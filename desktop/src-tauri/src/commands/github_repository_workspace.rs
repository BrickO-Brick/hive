use super::project_repo_paths::{
    canonical_repos_roots, canonicalize_repos_root, default_repos_root_candidates,
    find_local_repo_dir, local_repo_candidates,
};
use crate::managed_agents::{bounded_command::output_with_timeout, resolve_command};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, Instant};

const GIT_TIMEOUT: Duration = Duration::from_secs(60);
const CLONE_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_TEST_TIMEOUT_SECONDS: u64 = 600;
const MAX_COMMAND_CHARS: usize = 2_000;
const MAX_DIFF_FILES: usize = 250;
const MAX_PATCH_LINES: usize = 2_000;
const MAX_RESULT_TEXT_BYTES: usize = 64 * 1024;

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
) -> Result<Option<GitHubRepositoryWorkspace>, String> {
    let url = clone_url(owner, name);
    let Some(repo_dir) = find_local_repo_dir(repos_dir, name, Some(&url))? else {
        return Ok(None);
    };
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
) -> Result<GitHubRepositoryWorkspace, String> {
    if let Some(workspace) = inspect_workspace_blocking(owner, name, repos_dir)? {
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
    inspect_workspace_blocking(owner, name, repos_dir)?.ok_or_else(|| {
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
) -> Result<Option<GitHubRepositoryWorkspace>, String> {
    let owner = validate_segment(&owner, "owner")?;
    let name = validate_segment(&name, "repository")?;
    tauri::async_runtime::spawn_blocking(move || {
        inspect_workspace_blocking(&owner, &name, repos_dir.as_deref())
    })
    .await
    .map_err(|error| format!("workspace inspection task failed: {error}"))?
}

#[tauri::command]
pub async fn prepare_github_repository_workspace(
    owner: String,
    name: String,
    repos_dir: Option<String>,
) -> Result<GitHubRepositoryWorkspace, String> {
    let owner = validate_segment(&owner, "owner")?;
    let name = validate_segment(&name, "repository")?;
    tauri::async_runtime::spawn_blocking(move || {
        prepare_workspace_blocking(&owner, &name, repos_dir.as_deref())
    })
    .await
    .map_err(|error| format!("workspace preparation task failed: {error}"))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn run_github_repository_test(
    owner: String,
    name: String,
    repos_dir: Option<String>,
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
    if !matches!(expected_result_tree.len(), 40 | 64)
        || !expected_result_tree
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("Expected result tree must be a Git object id.".to_string());
    }
    let timeout_seconds = timeout_seconds
        .unwrap_or(300)
        .clamp(10, MAX_TEST_TIMEOUT_SECONDS);
    tauri::async_runtime::spawn_blocking(move || {
        let before = inspect_workspace_blocking(&owner, &name, repos_dir.as_deref())?
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
        let after = inspect_workspace_blocking(&owner, &name, repos_dir.as_deref())?
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

        let workspace = inspect_workspace_blocking("BrickO-Brick", "hive", root.path().to_str())
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
}
