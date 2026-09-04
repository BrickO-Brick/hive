use super::project_repo_paths::{
    canonical_repos_roots, canonicalize_repos_root, default_repos_root_candidates,
    find_local_repo_dir, local_repo_candidates,
};
use crate::managed_agents::{bounded_command::output_with_timeout, resolve_command};
use fs2::FileExt;
use serde::Serialize;
use std::collections::BTreeSet;
use std::fs::{OpenOptions, Permissions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, Instant};

const GIT_TIMEOUT: Duration = Duration::from_secs(60);
const CLONE_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_TEST_TIMEOUT_SECONDS: u64 = 600;
const MAX_COMMAND_CHARS: usize = 2_000;
const MAX_DIFF_FILES: usize = 250;
const MAX_PATCH_LINES: usize = 2_000;
const MAX_RESULT_TEXT_BYTES: usize = 64 * 1024;
const MAX_WORKSPACE_FILE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Serialize)]
pub struct GitHubWorkspaceDiffFile {
    path: String,
    additions: usize,
    deletions: usize,
    patch: String,
    truncated: bool,
}

#[derive(Clone, Serialize)]
pub struct GitHubRepositoryWorkspace {
    pub(super) owner: String,
    pub(super) name: String,
    pub(super) path: String,
    pub(super) branch: String,
    pub(super) base_commit: String,
    pub(super) base_tree: String,
    pub(super) result_tree: String,
    pub(super) dirty: bool,
    pub(super) additions: usize,
    pub(super) deletions: usize,
    pub(super) files: Vec<GitHubWorkspaceDiffFile>,
}

#[derive(Serialize)]
pub struct GitHubRepositoryTestResult {
    exit_code: Option<i32>,
    passed: bool,
    duration_ms: u64,
    stdout: String,
    stderr: String,
    tested_tree: String,
    finished_tree: String,
    tree_changed: bool,
}

#[derive(Serialize)]
pub struct GitHubRepositoryWorkspaceFile {
    path: String,
    content: String,
    result_tree: String,
}

pub(super) fn validate_segment(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.starts_with('-')
        || value.ends_with('-')
        || value.contains("..")
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
    {
        return Err(format!("Invalid GitHub {label}."));
    }
    Ok(value.to_string())
}

fn clone_url(owner: &str, name: &str) -> String {
    format!("https://github.com/{owner}/{name}.git")
}

fn shell_quote(value: &Path) -> String {
    format!("'{}'", value.to_string_lossy().replace('\'', "'\\''"))
}

fn github_git_command(repo_dir: &Path, args: &[&str]) -> Result<Command, String> {
    let gh = resolve_command("gh").ok_or_else(|| "GitHub CLI is not installed.".to_string())?;
    let helper = format!(
        "credential.helper=!{} auth git-credential",
        shell_quote(&gh)
    );
    let mut owned = vec![
        "-c".to_string(),
        "credential.helper=".to_string(),
        "-c".to_string(),
        helper,
        "-c".to_string(),
        "credential.useHttpPath=true".to_string(),
    ];
    owned.extend(args.iter().map(|value| (*value).to_string()));
    let refs = owned.iter().map(String::as_str).collect::<Vec<_>>();
    git_command(repo_dir, &refs, None)
}

pub(super) fn repository_coordinate(owner: &str, name: &str) -> String {
    format!("{owner}/{name}")
}

fn first_error_line(output: &[u8], fallback: &str) -> String {
    String::from_utf8_lossy(output)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(240).collect())
        .unwrap_or_else(|| fallback.to_string())
}

pub(super) fn run_bounded(
    command: Command,
    timeout: Duration,
    label: &str,
) -> Result<Output, String> {
    let output = output_with_timeout(command, timeout)
        .ok_or_else(|| format!("{label} did not complete within its resource limits."))?;
    if output.status.success() {
        return Ok(output);
    }
    Err(first_error_line(
        &output.stderr,
        &format!("{label} exited with {}.", output.status),
    ))
}

pub(super) fn clean_process_environment(command: &mut Command) {
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_EXTERNAL_DIFF",
        "GIT_SSH_COMMAND",
    ] {
        command.env_remove(key);
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null");
}

pub(super) fn git_command(
    repo_dir: &Path,
    args: &[&str],
    index: Option<&Path>,
) -> Result<Command, String> {
    let git = resolve_command("git").ok_or_else(|| "git was not found on PATH".to_string())?;
    let mut command = Command::new(git);
    command
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "diff.external=",
        ])
        .args(args)
        .current_dir(repo_dir);
    clean_process_environment(&mut command);
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    Ok(command)
}

pub(super) fn run_git(
    repo_dir: &Path,
    args: &[&str],
    index: Option<&Path>,
) -> Result<Output, String> {
    run_bounded(git_command(repo_dir, args, index)?, GIT_TIMEOUT, "git")
}

pub(super) fn git_text(
    repo_dir: &Path,
    args: &[&str],
    index: Option<&Path>,
) -> Result<String, String> {
    run_git(repo_dir, args, index)
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn configured_filter_names(repo_dir: &Path) -> Vec<String> {
    let Ok(output) = run_git(
        repo_dir,
        &[
            "config",
            "--local",
            "--name-only",
            "--get-regexp",
            "^filter\\..*\\.(clean|process|required)$",
        ],
        None,
    ) else {
        return Vec::new();
    };
    let mut names = BTreeSet::new();
    for key in String::from_utf8_lossy(&output.stdout).lines() {
        let mut parts = key.trim().split('.');
        if parts.next() != Some("filter") {
            continue;
        }
        let Some(name) = parts.next() else {
            continue;
        };
        if !name.is_empty()
            && name.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
            })
        {
            names.insert(name.to_string());
        }
    }
    names.into_iter().collect()
}

fn git_with_neutralized_filters(
    repo_dir: &Path,
    args: &[&str],
    index: &Path,
) -> Result<Output, String> {
    let mut owned_args = vec![
        "-c".to_string(),
        "core.hooksPath=/dev/null".to_string(),
        "-c".to_string(),
        "core.fsmonitor=false".to_string(),
        "-c".to_string(),
        "diff.external=".to_string(),
    ];
    for name in configured_filter_names(repo_dir) {
        owned_args.extend([
            "-c".to_string(),
            format!("filter.{name}.clean="),
            "-c".to_string(),
            format!("filter.{name}.process="),
            "-c".to_string(),
            format!("filter.{name}.required=false"),
        ]);
    }
    owned_args.extend(args.iter().map(|argument| (*argument).to_string()));
    let refs = owned_args.iter().map(String::as_str).collect::<Vec<_>>();
    let git = resolve_command("git").ok_or_else(|| "git was not found on PATH".to_string())?;
    let mut command = Command::new(git);
    command.args(refs).current_dir(repo_dir);
    clean_process_environment(&mut command);
    command.env("GIT_INDEX_FILE", index);
    run_bounded(command, GIT_TIMEOUT, "git")
}

fn parse_numstat(output: &[u8]) -> Vec<(String, usize, usize)> {
    output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .filter_map(|record| {
            let record = String::from_utf8_lossy(record);
            let mut fields = record.splitn(3, '\t');
            let additions = fields.next()?.parse().unwrap_or_default();
            let deletions = fields.next()?.parse().unwrap_or_default();
            let path = fields.next()?.to_string();
            Some((path, additions, deletions))
        })
        .take(MAX_DIFF_FILES)
        .collect()
}

fn truncate_patch(patch: String) -> (String, bool) {
    let mut newline_indices = patch
        .char_indices()
        .filter(|(_, character)| *character == '\n')
        .map(|(index, _)| index);
    match newline_indices.nth(MAX_PATCH_LINES.saturating_sub(1)) {
        Some(index) => (patch[..index].to_string(), true),
        None => (patch, false),
    }
}

pub(super) fn inspect_workspace_blocking(
    owner: &str,
    name: &str,
    repos_dir: Option<&str>,
    workspace_id: Option<&str>,
) -> Result<Option<GitHubRepositoryWorkspace>, String> {
    let url = clone_url(owner, name);
    let workspace_binding = if let Some(workspace_id) = workspace_id {
        let workspace_id = validate_segment(workspace_id, "workspace")?;
        let coordinate = format!("{owner}--{name}");
        canonical_repos_roots(repos_dir)?
            .into_iter()
            .find_map(|root| {
                let candidate = root
                    .join(".hive-workspaces")
                    .join("worktrees")
                    .join(&coordinate)
                    .join(&workspace_id)
                    .canonicalize()
                    .ok()?;
                if !candidate.starts_with(&root) {
                    return None;
                }
                let mirror = root
                    .join(".hive-workspaces")
                    .join("mirrors")
                    .join(format!("{coordinate}.git"))
                    .canonicalize()
                    .ok()?;
                mirror.starts_with(&root).then_some((candidate, mirror))
            })
    } else {
        find_local_repo_dir(repos_dir, name, Some(&url))?.map(|repo_dir| (repo_dir, PathBuf::new()))
    };
    let Some((repo_dir, expected_common_dir)) = workspace_binding else {
        return Ok(None);
    };
    let actual_url = git_text(&repo_dir, &["remote", "get-url", "origin"], None)?;
    if actual_url.trim_end_matches(".git") != url.trim_end_matches(".git") {
        return Err("The thread workspace origin does not match the selected repository.".into());
    }
    if workspace_id.is_some() {
        let common_dir = git_text(&repo_dir, &["rev-parse", "--git-common-dir"], None)?;
        let common_dir = PathBuf::from(common_dir);
        let common_dir = if common_dir.is_absolute() {
            common_dir
        } else {
            repo_dir.join(common_dir)
        };
        let common_dir = common_dir
            .canonicalize()
            .map_err(|error| format!("resolve thread workspace Git directory: {error}"))?;
        if common_dir != expected_common_dir {
            return Err(
                "The thread workspace is no longer attached to its shared repository mirror."
                    .into(),
            );
        }
    }
    let base_commit = git_text(&repo_dir, &["rev-parse", "--verify", "HEAD^{commit}"], None)
        .map_err(|_| "The local repository has no commit to use as a proposal base.".to_string())?;
    let base_tree = git_text(&repo_dir, &["rev-parse", "HEAD^{tree}"], None)?;
    let branch = git_text(&repo_dir, &["branch", "--show-current"], None)?;
    let temp = tempfile::tempdir().map_err(|error| format!("create temporary index: {error}"))?;
    let index = temp.path().join("proposal-index");
    run_git(&repo_dir, &["read-tree", "HEAD"], Some(&index))?;
    git_with_neutralized_filters(&repo_dir, &["add", "-A", "--", "."], &index)?;
    let result_tree = git_text(&repo_dir, &["write-tree"], Some(&index))?;
    let numstat = run_git(
        &repo_dir,
        &[
            "diff",
            "--no-ext-diff",
            "--no-renames",
            "--numstat",
            "-z",
            &base_tree,
            &result_tree,
            "--",
        ],
        None,
    )?;
    let mut files = Vec::new();
    for (path, additions, deletions) in parse_numstat(&numstat.stdout) {
        let patch_output = run_git(
            &repo_dir,
            &[
                "diff",
                "--no-ext-diff",
                "--no-renames",
                "--unified=12",
                "--src-prefix=a/",
                "--dst-prefix=b/",
                &base_tree,
                &result_tree,
                "--",
                &path,
            ],
            None,
        );
        let (patch, truncated) = match patch_output {
            Ok(output) => truncate_patch(String::from_utf8_lossy(&output.stdout).to_string()),
            Err(_) => (String::new(), true),
        };
        files.push(GitHubWorkspaceDiffFile {
            path,
            additions,
            deletions,
            patch,
            truncated,
        });
    }
    Ok(Some(GitHubRepositoryWorkspace {
        owner: owner.to_string(),
        name: name.to_string(),
        path: repo_dir.display().to_string(),
        branch,
        base_commit,
        base_tree: base_tree.clone(),
        result_tree: result_tree.clone(),
        dirty: base_tree != result_tree,
        additions: files.iter().map(|file| file.additions).sum(),
        deletions: files.iter().map(|file| file.deletions).sum(),
        files,
    }))
}

fn validate_object_id(value: &str, label: &str) -> Result<(), String> {
    if matches!(value.len(), 40 | 64)
        && value.chars().all(|character| character.is_ascii_hexdigit())
    {
        return Ok(());
    }
    Err(format!("{label} must be a Git object id."))
}

fn editable_workspace_path(repo_dir: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative_path.is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || relative
            .components()
            .next()
            .is_some_and(|component| component.as_os_str() == ".git")
    {
        return Err("The proposal file path is not a safe workspace-relative path.".to_string());
    }
    let canonical_repo = repo_dir
        .canonicalize()
        .map_err(|error| format!("resolve proposal workspace: {error}"))?;
    let target = canonical_repo.join(relative);
    let parent = target
        .parent()
        .ok_or_else(|| "The proposal file has no parent directory.".to_string())?
        .canonicalize()
        .map_err(|error| format!("resolve proposal file parent: {error}"))?;
    if !parent.starts_with(&canonical_repo) {
        return Err("The proposal file resolves outside its workspace.".to_string());
    }
    let metadata = std::fs::symlink_metadata(&target)
        .map_err(|error| format!("read proposal file metadata: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Only regular, non-symlink proposal files can be edited.".to_string());
    }
    Ok(target)
}

fn require_editable_workspace(
    owner: &str,
    name: &str,
    repos_dir: Option<&str>,
    workspace_id: Option<&str>,
    path: &str,
    expected_result_tree: &str,
) -> Result<(GitHubRepositoryWorkspace, PathBuf), String> {
    validate_object_id(expected_result_tree, "Expected result tree")?;
    let workspace = inspect_workspace_blocking(owner, name, repos_dir, workspace_id)?
        .ok_or_else(|| "Prepare the local repository before editing files.".to_string())?;
    if workspace.result_tree != expected_result_tree {
        return Err("The workspace changed. Refresh the proposal before editing.".to_string());
    }
    if !workspace.files.iter().any(|file| file.path == path) {
        return Err("Only files already included in this proposal can be edited.".to_string());
    }
    let target = editable_workspace_path(Path::new(&workspace.path), path)?;
    Ok((workspace, target))
}

fn read_workspace_file_blocking(
    owner: &str,
    name: &str,
    repos_dir: Option<&str>,
    workspace_id: Option<&str>,
    path: &str,
    expected_result_tree: &str,
) -> Result<GitHubRepositoryWorkspaceFile, String> {
    let (workspace, target) = require_editable_workspace(
        owner,
        name,
        repos_dir,
        workspace_id,
        path,
        expected_result_tree,
    )?;
    let bytes = std::fs::read(&target).map_err(|error| format!("read proposal file: {error}"))?;
    if bytes.len() > MAX_WORKSPACE_FILE_BYTES {
        return Err(
            "Proposal files larger than 1 MiB must be edited in an external IDE.".to_string(),
        );
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| "Binary proposal files must be edited in an external IDE.".to_string())?;
    Ok(GitHubRepositoryWorkspaceFile {
        path: path.to_string(),
        content,
        result_tree: workspace.result_tree,
    })
}

fn write_workspace_file_blocking(
    owner: &str,
    name: &str,
    repos_dir: Option<&str>,
    workspace_id: Option<&str>,
    path: &str,
    content: &str,
    expected_result_tree: &str,
) -> Result<GitHubRepositoryWorkspace, String> {
    if content.len() > MAX_WORKSPACE_FILE_BYTES || content.contains('\0') {
        return Err("Proposal file content must be UTF-8 text no larger than 1 MiB.".to_string());
    }
    let (before, target) = require_editable_workspace(
        owner,
        name,
        repos_dir,
        workspace_id,
        path,
        expected_result_tree,
    )?;
    let existing =
        std::fs::read(&target).map_err(|error| format!("read proposal file: {error}"))?;
    if existing == content.as_bytes() {
        return Ok(before);
    }
    let permissions: Permissions = std::fs::metadata(&target)
        .map_err(|error| format!("read proposal file permissions: {error}"))?
        .permissions();
    let parent = target
        .parent()
        .ok_or_else(|| "The proposal file has no parent directory.".to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("create atomic proposal file: {error}"))?;
    temporary
        .write_all(content.as_bytes())
        .and_then(|()| temporary.flush())
        .map_err(|error| format!("write atomic proposal file: {error}"))?;
    temporary
        .as_file()
        .set_permissions(permissions)
        .map_err(|error| format!("preserve proposal file permissions: {error}"))?;
    temporary
        .persist(&target)
        .map_err(|error| format!("replace proposal file atomically: {}", error.error))?;
    inspect_workspace_blocking(owner, name, repos_dir, workspace_id)?
        .ok_or_else(|| "The local repository disappeared after editing.".to_string())
}

fn clone_destination_root(repos_dir: Option<&str>) -> Result<PathBuf, String> {
    match canonical_repos_roots(repos_dir) {
        Ok(roots) => roots
            .into_iter()
            .next()
            .ok_or_else(|| "reposDir is not accessible".to_string()),
        Err(error) => {
            if repos_dir.is_some() {
                return Err(error);
            }
            let root = default_repos_root_candidates()
                .into_iter()
                .next()
                .ok_or(error)?;
            std::fs::create_dir_all(&root).map_err(|error| format!("create repos dir: {error}"))?;
            canonicalize_repos_root(root)
        }
    }
}

fn prepare_workspace_blocking(
    owner: &str,
    name: &str,
    repos_dir: Option<&str>,
    workspace_id: Option<&str>,
    base_ref: Option<&str>,
) -> Result<GitHubRepositoryWorkspace, String> {
    if let Some(workspace) = inspect_workspace_blocking(owner, name, repos_dir, workspace_id)? {
        return Ok(workspace);
    }
    let Some(workspace_id) = workspace_id else {
        return prepare_legacy_workspace_blocking(owner, name, repos_dir);
    };
    let workspace_id = validate_segment(workspace_id, "workspace")?;
    let base_ref = validate_segment(base_ref.unwrap_or("main"), "base branch")?;
    let root = clone_destination_root(repos_dir)?;
    let managed_root = root.join(".hive-workspaces");
    let coordinate = format!("{owner}--{name}");
    let lock_dir = managed_root.join("locks");
    std::fs::create_dir_all(&lock_dir)
        .map_err(|error| format!("create workspace lock directory: {error}"))?;
    let lock_path = lock_dir.join(format!("{coordinate}.lock"));
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|error| format!("open repository workspace lock: {error}"))?;
    lock.try_lock_exclusive().map_err(|_| {
        "This repository is already preparing another local discussion workspace.".to_string()
    })?;
    if let Some(workspace) =
        inspect_workspace_blocking(owner, name, repos_dir, Some(&workspace_id))?
    {
        return Ok(workspace);
    }

    let mirror = managed_root
        .join("mirrors")
        .join(format!("{coordinate}.git"));
    let destination = managed_root
        .join("worktrees")
        .join(&coordinate)
        .join(&workspace_id);
    if destination.exists() {
        return Err(format!(
            "{} already exists without a valid thread workspace binding.",
            destination.display()
        ));
    }
    if !mirror.exists() {
        std::fs::create_dir_all(
            mirror
                .parent()
                .ok_or_else(|| "The mirror path has no parent directory.".to_string())?,
        )
        .map_err(|error| format!("create repository mirror directory: {error}"))?;
        let gh = resolve_command("gh").ok_or_else(|| {
            "GitHub CLI is not installed. Install `gh` and sign in with the publishing user."
                .to_string()
        })?;
        let repository = repository_coordinate(owner, name);
        let mut command = Command::new(gh);
        command
            .args(["repo", "clone", &repository])
            .arg(&mirror)
            .args(["--", "--bare", "--filter=blob:none"])
            .env("GH_PAGER", "cat");
        clean_process_environment(&mut command);
        run_bounded(command, CLONE_TIMEOUT, "GitHub repository mirror")?;
    }
    let actual_url = git_text(&mirror, &["remote", "get-url", "origin"], None)?;
    let expected_url = clone_url(owner, name);
    if actual_url.trim_end_matches(".git") != expected_url.trim_end_matches(".git") {
        return Err("The shared mirror origin does not match the selected repository.".into());
    }
    run_bounded(
        github_git_command(
            &mirror,
            &[
                "fetch",
                "--prune",
                "origin",
                "+refs/heads/*:refs/remotes/origin/*",
            ],
        )?,
        CLONE_TIMEOUT,
        "GitHub repository mirror fetch",
    )?;
    let base_revision = format!("refs/remotes/origin/{base_ref}^{{commit}}");
    let base_commit = git_text(&mirror, &["rev-parse", "--verify", &base_revision], None)
        .map_err(|_| format!("The remote base branch {base_ref} does not exist."))?;
    let branch = format!("hive/{workspace_id}");
    let branch_ref = format!("refs/heads/{branch}");
    let branch_probe = output_with_timeout(
        git_command(
            &mirror,
            &["show-ref", "--verify", "--quiet", &branch_ref],
            None,
        )?,
        GIT_TIMEOUT,
    )
    .ok_or_else(|| "The discussion branch check exceeded its resource limits.".to_string())?;
    let branch_exists = if branch_probe.status.success() {
        true
    } else if branch_probe.status.code() == Some(1) {
        false
    } else {
        return Err(first_error_line(
            &branch_probe.stderr,
            "The discussion branch could not be inspected.",
        ));
    };
    if branch_exists {
        return Err(format!(
            "Discussion branch {branch} already exists without its expected worktree."
        ));
    }
    std::fs::create_dir_all(
        destination
            .parent()
            .ok_or_else(|| "The worktree path has no parent directory.".to_string())?,
    )
    .map_err(|error| format!("create discussion worktree directory: {error}"))?;
    run_git(
        &mirror,
        &[
            "worktree",
            "add",
            "-b",
            &branch,
            destination
                .to_str()
                .ok_or_else(|| "The worktree path is not valid UTF-8.".to_string())?,
            &base_commit,
        ],
        None,
    )?;
    inspect_workspace_blocking(owner, name, repos_dir, Some(&workspace_id))?.ok_or_else(|| {
        "The worktree was created but its repository binding could not be verified.".to_string()
    })
}

fn prepare_legacy_workspace_blocking(
    owner: &str,
    name: &str,
    repos_dir: Option<&str>,
) -> Result<GitHubRepositoryWorkspace, String> {
    if let Some(workspace) = inspect_workspace_blocking(owner, name, repos_dir, None)? {
        return Ok(workspace);
    }
    let root = clone_destination_root(repos_dir)?;
    let url = clone_url(owner, name);
    let directory_name = local_repo_candidates(name, Some(&url))
        .into_iter()
        .next()
        .ok_or_else(|| "Could not derive a local repository name.".to_string())?;
    let destination = root.join(directory_name);
    if destination.exists() {
        return Err(format!(
            "{} already exists but is not the selected GitHub repository.",
            destination.display()
        ));
    }
    let gh = resolve_command("gh").ok_or_else(|| {
        "GitHub CLI is not installed. Install `gh` and sign in with the publishing user."
            .to_string()
    })?;
    let coordinate = repository_coordinate(owner, name);
    let mut command = Command::new(gh);
    command
        .args(["repo", "clone", &coordinate])
        .arg(&destination)
        .args(["--", "--filter=blob:none"])
        .env("GH_PAGER", "cat");
    clean_process_environment(&mut command);
    run_bounded(command, CLONE_TIMEOUT, "GitHub repository clone")?;
    inspect_workspace_blocking(owner, name, repos_dir, None)?.ok_or_else(|| {
        "The clone completed but its origin could not be verified against the selected repository."
            .to_string()
    })
}

fn clipped_text(bytes: &[u8]) -> String {
    let clipped = &bytes[..bytes.len().min(MAX_RESULT_TEXT_BYTES)];
    let mut text = String::from_utf8_lossy(clipped).to_string();
    if bytes.len() > MAX_RESULT_TEXT_BYTES {
        text.push_str("\n[output truncated by Buzz]");
    }
    text
}

fn test_command(repo_dir: &Path, command_text: &str) -> Result<Command, String> {
    #[cfg(unix)]
    let mut command = {
        let shell = if Path::new("/bin/zsh").is_file() {
            "/bin/zsh"
        } else {
            "/bin/sh"
        };
        let mut command = Command::new(shell);
        command.args(["-c", command_text]);
        command
    };
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", command_text]);
        command
    };
    command.current_dir(repo_dir);
    let safe_environment = [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "TMPDIR",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
        "CARGO_HOME",
        "RUSTUP_HOME",
        "GOPATH",
    ]
    .into_iter()
    .filter_map(|key| std::env::var_os(key).map(|value| (key, value)))
    .collect::<Vec<_>>();
    command.env_clear().envs(safe_environment).env("CI", "1");
    Ok(command)
}

#[tauri::command]
pub async fn inspect_github_repository_workspace(
    owner: String,
    name: String,
    repos_dir: Option<String>,
    workspace_id: Option<String>,
) -> Result<Option<GitHubRepositoryWorkspace>, String> {
    let owner = validate_segment(&owner, "owner")?;
    let name = validate_segment(&name, "repository")?;
    tauri::async_runtime::spawn_blocking(move || {
        inspect_workspace_blocking(&owner, &name, repos_dir.as_deref(), workspace_id.as_deref())
    })
    .await
    .map_err(|error| format!("workspace inspection task failed: {error}"))?
}

#[tauri::command]
pub async fn prepare_github_repository_workspace(
    owner: String,
    name: String,
    repos_dir: Option<String>,
    workspace_id: Option<String>,
    base_ref: Option<String>,
) -> Result<GitHubRepositoryWorkspace, String> {
    let owner = validate_segment(&owner, "owner")?;
    let name = validate_segment(&name, "repository")?;
    tauri::async_runtime::spawn_blocking(move || {
        prepare_workspace_blocking(
            &owner,
            &name,
            repos_dir.as_deref(),
            workspace_id.as_deref(),
            base_ref.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("workspace preparation task failed: {error}"))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn read_github_repository_workspace_file(
    owner: String,
    name: String,
    repos_dir: Option<String>,
    workspace_id: Option<String>,
    path: String,
    expected_result_tree: String,
) -> Result<GitHubRepositoryWorkspaceFile, String> {
    let owner = validate_segment(&owner, "owner")?;
    let name = validate_segment(&name, "repository")?;
    tauri::async_runtime::spawn_blocking(move || {
        read_workspace_file_blocking(
            &owner,
            &name,
            repos_dir.as_deref(),
            workspace_id.as_deref(),
            &path,
            &expected_result_tree,
        )
    })
    .await
    .map_err(|error| format!("workspace file read task failed: {error}"))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn write_github_repository_workspace_file(
    owner: String,
    name: String,
    repos_dir: Option<String>,
    workspace_id: Option<String>,
    path: String,
    content: String,
    expected_result_tree: String,
) -> Result<GitHubRepositoryWorkspace, String> {
    let owner = validate_segment(&owner, "owner")?;
    let name = validate_segment(&name, "repository")?;
    tauri::async_runtime::spawn_blocking(move || {
        write_workspace_file_blocking(
            &owner,
            &name,
            repos_dir.as_deref(),
            workspace_id.as_deref(),
            &path,
            &content,
            &expected_result_tree,
        )
    })
    .await
    .map_err(|error| format!("workspace file write task failed: {error}"))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn run_github_repository_test(
    owner: String,
    name: String,
    repos_dir: Option<String>,
    workspace_id: Option<String>,
    command: String,
    expected_result_tree: String,
    timeout_seconds: Option<u64>,
) -> Result<GitHubRepositoryTestResult, String> {
    let owner = validate_segment(&owner, "owner")?;
    let name = validate_segment(&name, "repository")?;
    let command = command.trim().to_string();
    if command.is_empty() || command.len() > MAX_COMMAND_CHARS || command.contains('\0') {
        return Err(
            "Test command must contain between 1 and 2,000 safe text characters.".to_string(),
        );
    }
    validate_object_id(&expected_result_tree, "Expected result tree")?;
    let timeout_seconds = timeout_seconds
        .unwrap_or(300)
        .clamp(10, MAX_TEST_TIMEOUT_SECONDS);
    tauri::async_runtime::spawn_blocking(move || {
        let before = inspect_workspace_blocking(
            &owner,
            &name,
            repos_dir.as_deref(),
            workspace_id.as_deref(),
        )?
        .ok_or_else(|| "Prepare the local repository before running tests.".to_string())?;
        if before.result_tree != expected_result_tree {
            return Err(
                "The workspace changed before the test started. Refresh the proposal.".to_string(),
            );
        }
        let started = Instant::now();
        let output = output_with_timeout(
            test_command(Path::new(&before.path), &command)?,
            Duration::from_secs(timeout_seconds),
        )
        .ok_or_else(|| {
            format!("Test exceeded {timeout_seconds}s or the 1 MiB output safety limit.")
        })?;
        let after = inspect_workspace_blocking(
            &owner,
            &name,
            repos_dir.as_deref(),
            workspace_id.as_deref(),
        )?
        .ok_or_else(|| "The local repository disappeared during the test.".to_string())?;
        let tree_changed = after.result_tree != expected_result_tree;
        Ok(GitHubRepositoryTestResult {
            exit_code: output.status.code(),
            passed: output.status.success() && !tree_changed,
            duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
            stdout: clipped_text(&output.stdout),
            stderr: clipped_text(&output.stderr),
            tested_tree: expected_result_tree,
            finished_tree: after.result_tree,
            tree_changed,
        })
    })
    .await
    .map_err(|error| format!("test task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_git(repo: &Path, args: &[&str]) -> Output {
        let git = resolve_command("git").expect("git is required for repository tests");
        Command::new(git)
            .args(args)
            .current_dir(repo)
            .output()
            .expect("run test git command")
    }

    fn editable_repository() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().expect("temporary repositories root");
        let repo = root.path().join("BrickO-Brick--hive");
        std::fs::create_dir(&repo).expect("create repository");
        assert!(test_git(&repo, &["init", "--initial-branch=main"])
            .status
            .success());
        assert!(test_git(
            &repo,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/BrickO-Brick/hive.git",
            ],
        )
        .status
        .success());
        std::fs::write(repo.join("proposal.txt"), "before\n").expect("write proposal file");
        assert!(test_git(&repo, &["add", "proposal.txt"]).status.success());
        assert!(test_git(
            &repo,
            &[
                "-c",
                "user.name=Buzz Test",
                "-c",
                "user.email=buzz@example.test",
                "commit",
                "-m",
                "Initial",
            ],
        )
        .status
        .success());
        std::fs::write(repo.join("proposal.txt"), "agent recommendation\n")
            .expect("modify proposal file");
        (root, repo)
    }

    #[test]
    fn github_segments_reject_flags_and_paths() {
        for value in ["", "-repo", "owner/repo", "repo..next", "repo;echo"] {
            assert!(
                validate_segment(value, "repository").is_err(),
                "accepted {value:?}"
            );
        }
        assert_eq!(
            validate_segment("BrickO-Brick", "owner").unwrap(),
            "BrickO-Brick"
        );
    }

    #[test]
    fn numstat_parser_is_bounded_and_binary_safe() {
        let output = b"12\t3\tsrc/main.rs\0-\t-\tassets/icon.png\0";
        assert_eq!(
            parse_numstat(output),
            vec![
                ("src/main.rs".to_string(), 12, 3),
                ("assets/icon.png".to_string(), 0, 0),
            ]
        );
    }

    #[test]
    fn result_text_is_capped() {
        let output = vec![b'x'; MAX_RESULT_TEXT_BYTES + 100];
        let text = clipped_text(&output);
        assert!(text.len() < MAX_RESULT_TEXT_BYTES + 100);
        assert!(text.ends_with("[output truncated by Buzz]"));
    }

    #[test]
    fn inspection_snapshots_tracked_and_untracked_files_without_staging_them() {
        let root = tempfile::tempdir().expect("temporary repositories root");
        let repo = root.path().join("BrickO-Brick--hive");
        std::fs::create_dir(&repo).expect("create repository");
        assert!(test_git(&repo, &["init", "--initial-branch=main"])
            .status
            .success());
        assert!(test_git(
            &repo,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/BrickO-Brick/hive.git",
            ],
        )
        .status
        .success());
        std::fs::write(repo.join("tracked.txt"), "before\n").expect("write tracked file");
        assert!(test_git(&repo, &["add", "tracked.txt"]).status.success());
        assert!(test_git(
            &repo,
            &[
                "-c",
                "user.name=Buzz Test",
                "-c",
                "user.email=buzz@example.test",
                "commit",
                "-m",
                "Initial",
            ],
        )
        .status
        .success());
        let original_head =
            String::from_utf8_lossy(&test_git(&repo, &["rev-parse", "HEAD"]).stdout)
                .trim()
                .to_string();
        std::fs::write(repo.join("tracked.txt"), "after\n").expect("modify tracked file");
        std::fs::write(repo.join("untracked.txt"), "new\n").expect("write untracked file");

        let workspace =
            inspect_workspace_blocking("BrickO-Brick", "hive", root.path().to_str(), None)
                .expect("inspect workspace")
                .expect("workspace exists");

        assert!(workspace.dirty);
        assert_eq!(workspace.base_commit, original_head);
        assert_ne!(workspace.base_tree, workspace.result_tree);
        assert_eq!(
            workspace
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["tracked.txt", "untracked.txt"]
        );
        assert!(test_git(&repo, &["diff", "--cached", "--quiet"])
            .status
            .success());
        let head_after = String::from_utf8_lossy(&test_git(&repo, &["rev-parse", "HEAD"]).stdout)
            .trim()
            .to_string();
        assert_eq!(head_after, original_head);
        let tree_files = String::from_utf8_lossy(
            &test_git(
                &repo,
                &["ls-tree", "-r", "--name-only", &workspace.result_tree],
            )
            .stdout,
        )
        .to_string();
        assert!(tree_files.lines().any(|path| path == "untracked.txt"));
    }

    #[test]
    fn file_edits_are_bound_to_the_exact_proposal_tree() {
        let (root, repo) = editable_repository();
        let before = inspect_workspace_blocking("BrickO-Brick", "hive", root.path().to_str(), None)
            .expect("inspect workspace")
            .expect("workspace exists");

        let opened = read_workspace_file_blocking(
            "BrickO-Brick",
            "hive",
            root.path().to_str(),
            None,
            "proposal.txt",
            &before.result_tree,
        )
        .expect("read proposal file");
        assert_eq!(opened.content, "agent recommendation\n");
        assert_eq!(opened.result_tree, before.result_tree);

        let after = write_workspace_file_blocking(
            "BrickO-Brick",
            "hive",
            root.path().to_str(),
            None,
            "proposal.txt",
            "user revision\n",
            &before.result_tree,
        )
        .expect("write proposal file");
        assert_eq!(
            std::fs::read_to_string(repo.join("proposal.txt")).expect("read updated file"),
            "user revision\n"
        );
        assert_ne!(after.result_tree, before.result_tree);
        assert!(test_git(&repo, &["diff", "--cached", "--quiet"])
            .status
            .success());

        let stale = write_workspace_file_blocking(
            "BrickO-Brick",
            "hive",
            root.path().to_str(),
            None,
            "proposal.txt",
            "stale overwrite\n",
            &before.result_tree,
        );
        let Err(stale) = stale else {
            panic!("stale result tree must be rejected");
        };
        assert!(stale.contains("workspace changed"));
        assert_eq!(
            std::fs::read_to_string(repo.join("proposal.txt")).expect("read preserved file"),
            "user revision\n"
        );
    }

    #[test]
    fn file_editor_rejects_git_metadata_and_parent_traversal() {
        let (_root, repo) = editable_repository();
        assert!(editable_workspace_path(&repo, ".git/config").is_err());
        assert!(editable_workspace_path(&repo, "../outside.txt").is_err());
        assert!(editable_workspace_path(&repo, "/tmp/outside.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn file_editor_rejects_symlinks() {
        use std::os::unix::fs::symlink;

        let (root, repo) = editable_repository();
        let outside = root.path().join("outside.txt");
        std::fs::write(&outside, "outside\n").expect("write outside file");
        std::fs::remove_file(repo.join("proposal.txt")).expect("remove proposal file");
        symlink(&outside, repo.join("proposal.txt")).expect("link proposal file");
        assert!(editable_workspace_path(&repo, "proposal.txt").is_err());
    }
}

#[cfg(test)]
#[path = "github_repository_workspace_discussion_tests.rs"]
mod discussion_tests;
