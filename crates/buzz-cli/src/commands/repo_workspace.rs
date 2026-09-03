//! Mirror-backed local Git workspaces for repository-scoped discussion threads.
//!
//! The shared bare mirror is a fetch cache only. Every thread receives its own
//! branch and worktree, and every action can be fenced against an exact HEAD.

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use chrono::Utc;
use fs2::FileExt;
use serde::{Deserialize, Serialize};

use crate::{error::CliError, RepoWorkspaceCmd};

const WORKSPACE_ROOT_ENV: &str = "HIVE_GIT_WORKSPACE_ROOT";
const GIT_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_GIT_OUTPUT_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct WorkspaceManifest {
    schema_version: u32,
    repo: String,
    clone_url: String,
    thread: String,
    mirror_path: PathBuf,
    worktree_path: PathBuf,
    branch: String,
    base_ref: String,
    base_sha: String,
    prepared_head: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
struct WorkspaceStatus<'a> {
    #[serde(flatten)]
    manifest: &'a WorkspaceManifest,
    current_head: String,
    current_branch: String,
    clean: bool,
    head_matches_prepared: bool,
    branch_matches_manifest: bool,
}

pub fn dispatch(command: &RepoWorkspaceCmd) -> Result<(), CliError> {
    let value = match command {
        RepoWorkspaceCmd::Prepare {
            repo,
            clone_url,
            thread,
            base_ref,
            root,
        } => prepare(root.as_deref(), repo, clone_url, thread, base_ref)?,
        RepoWorkspaceCmd::Status { repo, thread, root } => {
            let manifest = load_manifest(root.as_deref(), repo, thread)?;
            status_json(&manifest)?
        }
        RepoWorkspaceCmd::VerifyHead {
            repo,
            thread,
            expected_head,
            root,
        } => verify_head(root.as_deref(), repo, thread, expected_head)?,
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&value)
            .map_err(|error| CliError::Other(format!("failed to serialize workspace: {error}")))?
    );
    Ok(())
}

fn prepare(
    root: Option<&Path>,
    repo: &str,
    clone_url: &str,
    thread_id: &str,
    base_ref: &str,
) -> Result<serde_json::Value, CliError> {
    let identity = validate_repo(repo)?;
    validate_clone_identity(clone_url, &identity)?;
    let thread_id = validate_component("thread", thread_id, 128)?;
    let base_ref = validate_component("base ref", base_ref, 128)?;
    let root = resolve_root(root)?;
    let repo_key = identity.replace('/', "--");
    let mirror = root.join("mirrors").join(format!("{repo_key}.git"));
    let worktree = root.join("worktrees").join(&repo_key).join(&thread_id);
    let manifest_path = root
        .join("manifests")
        .join(&repo_key)
        .join(format!("{thread_id}.json"));

    fs::create_dir_all(root.join("locks")).map_err(io_error("create lock directory"))?;
    let lock_path = root.join("locks").join(format!("{repo_key}.lock"));
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(io_error("open repository lock"))?;
    lock.try_lock_exclusive().map_err(|error| {
        CliError::Conflict(format!(
            "repository workspace is already being changed ({}): {error}",
            lock_path.display()
        ))
    })?;

    if manifest_path.exists() {
        let manifest = read_manifest(&manifest_path)?;
        if manifest.repo != identity
            || manifest.thread != thread_id
            || manifest.clone_url != clone_url
            || manifest.base_ref != base_ref
        {
            return Err(CliError::Conflict(
                "workspace already exists with different repository inputs".into(),
            ));
        }
        return status_json(&manifest);
    }
    if worktree.exists() {
        return Err(CliError::Conflict(format!(
            "refusing untracked existing worktree directory: {}",
            worktree.display()
        )));
    }

    if mirror.exists() {
        run_git(
            None,
            [
                "--git-dir",
                path_text(&mirror)?,
                "remote",
                "get-url",
                "origin",
            ],
        )
        .and_then(|actual| {
            if actual.trim() == clone_url {
                Ok(actual)
            } else {
                Err(CliError::Conflict(format!(
                    "mirror origin mismatch: expected {clone_url}, found {}",
                    actual.trim()
                )))
            }
        })?;
    } else {
        fs::create_dir_all(
            mirror
                .parent()
                .ok_or_else(|| CliError::Other("mirror path has no parent directory".into()))?,
        )
        .map_err(io_error("create mirror directory"))?;
        run_git(None, ["init", "--bare", path_text(&mirror)?])?;
        run_git(
            None,
            [
                "--git-dir",
                path_text(&mirror)?,
                "remote",
                "add",
                "origin",
                clone_url,
            ],
        )?;
    }

    run_git(
        None,
        [
            "--git-dir",
            path_text(&mirror)?,
            "fetch",
            "--prune",
            "origin",
            "+refs/heads/*:refs/remotes/origin/*",
        ],
    )?;
    let base_revision = format!("refs/remotes/origin/{base_ref}^{{commit}}");
    let base_sha = run_git(
        None,
        [
            "--git-dir",
            path_text(&mirror)?,
            "rev-parse",
            "--verify",
            &base_revision,
        ],
    )?
    .trim()
    .to_string();
    validate_sha(&base_sha)?;

    let branch = format!("hive/{thread_id}");
    let branch_ref = format!("refs/heads/{branch}");
    if run_git_status(
        None,
        [
            "--git-dir",
            path_text(&mirror)?,
            "show-ref",
            "--verify",
            "--quiet",
            &branch_ref,
        ],
    )? == 0
    {
        return Err(CliError::Conflict(format!(
            "branch {branch} already exists without this thread manifest"
        )));
    }
    fs::create_dir_all(
        worktree
            .parent()
            .ok_or_else(|| CliError::Other("worktree path has no parent directory".into()))?,
    )
    .map_err(io_error("create worktree parent"))?;
    run_git(
        None,
        [
            "--git-dir",
            path_text(&mirror)?,
            "worktree",
            "add",
            "-b",
            &branch,
            path_text(&worktree)?,
            &base_sha,
        ],
    )?;

    let manifest = WorkspaceManifest {
        schema_version: 1,
        repo: identity,
        clone_url: clone_url.to_string(),
        thread: thread_id,
        mirror_path: mirror,
        worktree_path: worktree,
        branch,
        base_ref,
        base_sha: base_sha.clone(),
        prepared_head: base_sha,
        created_at: Utc::now().to_rfc3339(),
    };
    write_manifest_atomic(&manifest_path, &manifest)?;
    status_json(&manifest)
}

fn verify_head(
    root: Option<&Path>,
    repo: &str,
    thread_id: &str,
    expected_head: &str,
) -> Result<serde_json::Value, CliError> {
    validate_sha(expected_head)?;
    let manifest = load_manifest(root, repo, thread_id)?;
    let status = inspect_status(&manifest)?;
    if status.current_head != expected_head {
        return Err(CliError::Conflict(format!(
            "workspace HEAD moved: expected {expected_head}, found {}",
            status.current_head
        )));
    }
    if !status.clean {
        return Err(CliError::Conflict(
            "workspace has uncommitted changes; bind the action to a committed revision".into(),
        ));
    }
    if !status.branch_matches_manifest {
        return Err(CliError::Conflict(format!(
            "workspace branch changed: expected {}, found {}",
            manifest.branch, status.current_branch
        )));
    }
    serde_json::to_value(status)
        .map_err(|error| CliError::Other(format!("failed to serialize workspace: {error}")))
}

fn load_manifest(
    root: Option<&Path>,
    repo: &str,
    thread_id: &str,
) -> Result<WorkspaceManifest, CliError> {
    let identity = validate_repo(repo)?;
    let thread_id = validate_component("thread", thread_id, 128)?;
    let root = resolve_root(root)?;
    let path = root
        .join("manifests")
        .join(identity.replace('/', "--"))
        .join(format!("{thread_id}.json"));
    read_manifest(&path)
}

fn status_json(manifest: &WorkspaceManifest) -> Result<serde_json::Value, CliError> {
    serde_json::to_value(inspect_status(manifest)?)
        .map_err(|error| CliError::Other(format!("failed to serialize workspace: {error}")))
}

fn inspect_status(manifest: &WorkspaceManifest) -> Result<WorkspaceStatus<'_>, CliError> {
    let current_head = run_git(Some(&manifest.worktree_path), ["rev-parse", "HEAD"])?
        .trim()
        .to_string();
    validate_sha(&current_head)?;
    let current_branch = run_git(
        Some(&manifest.worktree_path),
        ["rev-parse", "--abbrev-ref", "HEAD"],
    )?
    .trim()
    .to_string();
    let clean = run_git(Some(&manifest.worktree_path), ["status", "--porcelain"])?
        .trim()
        .is_empty();
    Ok(WorkspaceStatus {
        manifest,
        head_matches_prepared: current_head == manifest.prepared_head,
        branch_matches_manifest: current_branch == manifest.branch,
        current_head,
        current_branch,
        clean,
    })
}

fn validate_repo(repo: &str) -> Result<String, CliError> {
    let mut parts = repo.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    if parts.next().is_some() {
        return Err(CliError::Usage(
            "repository must contain exactly owner/name".into(),
        ));
    }
    let owner = validate_component("repository owner", owner, 100)?;
    let name = validate_component("repository name", name, 100)?;
    Ok(format!("{owner}/{name}").to_ascii_lowercase())
}

fn validate_clone_identity(clone_url: &str, repo: &str) -> Result<(), CliError> {
    let normalized = clone_url
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .replace(':', "/");
    let expected = format!("/{repo}");
    if !normalized.to_ascii_lowercase().ends_with(&expected) {
        return Err(CliError::Usage(format!(
            "clone URL does not match canonical repository {repo}"
        )));
    }
    Ok(())
}

fn validate_component(label: &str, value: &str, max_len: usize) -> Result<String, CliError> {
    if value.is_empty()
        || value.len() > max_len
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
        || value == "."
        || value == ".."
    {
        return Err(CliError::Usage(format!(
            "invalid {label}: use 1-{max_len} ASCII letters, digits, '.', '_', or '-'"
        )));
    }
    Ok(value.to_string())
}

fn validate_sha(value: &str) -> Result<(), CliError> {
    if value.len() != 40 || !value.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err(CliError::Usage(
            "expected HEAD must be an exact 40-character commit SHA".into(),
        ));
    }
    Ok(())
}

fn resolve_root(explicit: Option<&Path>) -> Result<PathBuf, CliError> {
    if let Some(root) = explicit {
        return absolute_root(root);
    }
    if let Some(root) = std::env::var_os(WORKSPACE_ROOT_ENV) {
        return absolute_root(Path::new(&root));
    }
    let data = dirs::data_local_dir()
        .ok_or_else(|| CliError::Other("cannot determine local app data directory".into()))?;
    Ok(data.join("Hive").join("git-workspaces"))
}

fn absolute_root(root: &Path) -> Result<PathBuf, CliError> {
    if !root.is_absolute() {
        return Err(CliError::Usage(
            "workspace root must be an absolute path".into(),
        ));
    }
    Ok(root.to_path_buf())
}

fn read_manifest(path: &Path) -> Result<WorkspaceManifest, CliError> {
    let bytes = fs::read(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            CliError::NotFound(format!("workspace manifest not found: {}", path.display()))
        } else {
            CliError::Other(format!(
                "read workspace manifest {}: {error}",
                path.display()
            ))
        }
    })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        CliError::Other(format!(
            "invalid workspace manifest {}: {error}",
            path.display()
        ))
    })
}

fn write_manifest_atomic(path: &Path, manifest: &WorkspaceManifest) -> Result<(), CliError> {
    fs::create_dir_all(
        path.parent()
            .ok_or_else(|| CliError::Other("manifest path has no parent directory".into()))?,
    )
    .map_err(io_error("create manifest directory"))?;
    let temp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| CliError::Other(format!("serialize workspace manifest: {error}")))?;
    let mut file = File::create(&temp).map_err(io_error("create temporary workspace manifest"))?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(io_error("persist temporary workspace manifest"))?;
    fs::rename(&temp, path).map_err(io_error("publish workspace manifest"))
}

fn path_text(path: &Path) -> Result<&str, CliError> {
    path.to_str()
        .ok_or_else(|| CliError::Usage(format!("path is not valid UTF-8: {}", path.display())))
}

fn io_error(action: &'static str) -> impl FnOnce(std::io::Error) -> CliError {
    move |error| CliError::Other(format!("{action}: {error}"))
}

fn run_git<'a, I>(cwd: Option<&Path>, args: I) -> Result<String, CliError>
where
    I: IntoIterator<Item = &'a str>,
{
    let (status, stdout, stderr) = run_git_bounded(cwd, args)?;
    if status != 0 {
        return Err(CliError::Other(format!(
            "git failed with exit code {status}: {}",
            stderr.trim()
        )));
    }
    String::from_utf8(stdout)
        .map_err(|error| CliError::Other(format!("git returned non-UTF-8 output: {error}")))
}

fn run_git_status<'a, I>(cwd: Option<&Path>, args: I) -> Result<i32, CliError>
where
    I: IntoIterator<Item = &'a str>,
{
    let (status, _, _) = run_git_bounded(cwd, args)?;
    Ok(status)
}

fn run_git_bounded<'a, I>(cwd: Option<&Path>, args: I) -> Result<(i32, Vec<u8>, String), CliError>
where
    I: IntoIterator<Item = &'a str>,
{
    let mut command = Command::new("git");
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut child = command
        .spawn()
        .map_err(|error| CliError::Other(format!("start git: {error}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CliError::Other("capture git stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| CliError::Other("capture git stderr".into()))?;
    let stdout_reader = thread::spawn(move || read_bounded(stdout));
    let stderr_reader = thread::spawn(move || read_bounded(stderr));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| CliError::Other(format!("wait for git: {error}")))?
        {
            break status;
        }
        if started.elapsed() >= GIT_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CliError::Other(format!(
                "git exceeded {} second timeout",
                GIT_TIMEOUT.as_secs()
            )));
        }
        thread::sleep(Duration::from_millis(20));
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| CliError::Other("git stdout reader failed".into()))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| CliError::Other("git stderr reader failed".into()))??;
    Ok((
        status.code().unwrap_or(-1),
        stdout,
        String::from_utf8_lossy(&stderr).into_owned(),
    ))
}

fn read_bounded(mut reader: impl Read) -> Result<Vec<u8>, CliError> {
    let mut kept = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| CliError::Other(format!("read git output: {error}")))?;
        if count == 0 {
            break;
        }
        let remaining = MAX_GIT_OUTPUT_BYTES.saturating_sub(kept.len());
        kept.extend_from_slice(&buffer[..count.min(remaining)]);
    }
    Ok(kept)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, PathBuf, String) {
        let temp = tempfile::tempdir().expect("tempdir");
        let remote = temp.path().join("BrickO-Brick").join("demo.git");
        fs::create_dir_all(remote.parent().expect("remote parent")).expect("create owner");
        run_git(None, ["init", "--bare", path_text(&remote).expect("path")]).expect("bare repo");
        let seed = temp.path().join("seed");
        run_git(None, ["init", path_text(&seed).expect("path")]).expect("seed repo");
        run_git(Some(&seed), ["config", "user.name", "Hive Test"]).expect("user name");
        run_git(
            Some(&seed),
            ["config", "user.email", "hive@example.invalid"],
        )
        .expect("user email");
        fs::write(seed.join("README.md"), "hello\n").expect("fixture file");
        run_git(Some(&seed), ["add", "README.md"]).expect("add");
        run_git(Some(&seed), ["commit", "-m", "initial"]).expect("commit");
        run_git(Some(&seed), ["branch", "-M", "main"]).expect("main branch");
        run_git(
            Some(&seed),
            ["remote", "add", "origin", path_text(&remote).expect("path")],
        )
        .expect("remote");
        run_git(Some(&seed), ["push", "origin", "main"]).expect("push");
        let clone_url = path_text(&remote).expect("remote path").to_string();
        (temp, remote, clone_url)
    }

    #[test]
    fn prepares_isolated_thread_worktrees_and_reuses_the_mirror() {
        let (temp, _, clone_url) = fixture();
        let root = temp.path().join("workspaces");
        let first = prepare(
            Some(&root),
            "BrickO-Brick/demo",
            &clone_url,
            "thread-one",
            "main",
        )
        .expect("first workspace");
        let second = prepare(
            Some(&root),
            "BrickO-Brick/demo",
            &clone_url,
            "thread-two",
            "main",
        )
        .expect("second workspace");

        assert_eq!(first["mirror_path"], second["mirror_path"]);
        assert_ne!(first["worktree_path"], second["worktree_path"]);
        assert_ne!(first["branch"], second["branch"]);
        assert_eq!(first["current_head"], first["base_sha"]);
        assert_eq!(second["current_head"], second["base_sha"]);
    }

    #[test]
    fn verify_head_rejects_dirty_or_moved_workspace() {
        let (temp, _, clone_url) = fixture();
        let root = temp.path().join("workspaces");
        let prepared = prepare(
            Some(&root),
            "BrickO-Brick/demo",
            &clone_url,
            "thread-one",
            "main",
        )
        .expect("workspace");
        let head = prepared["current_head"].as_str().expect("head");
        verify_head(Some(&root), "BrickO-Brick/demo", "thread-one", head)
            .expect("clean prepared head");

        let path = PathBuf::from(prepared["worktree_path"].as_str().expect("worktree"));
        fs::write(path.join("README.md"), "changed\n").expect("dirty file");
        let error = verify_head(Some(&root), "BrickO-Brick/demo", "thread-one", head)
            .expect_err("dirty workspace must fail");
        assert!(error.to_string().contains("uncommitted changes"));

        run_git(Some(&path), ["config", "user.name", "Hive Test"]).expect("user name");
        run_git(
            Some(&path),
            ["config", "user.email", "hive@example.invalid"],
        )
        .expect("user email");
        run_git(Some(&path), ["add", "README.md"]).expect("add moved head");
        run_git(Some(&path), ["commit", "-m", "thread change"]).expect("move head");
        let error = verify_head(Some(&root), "BrickO-Brick/demo", "thread-one", head)
            .expect_err("moved HEAD must fail");
        assert!(error.to_string().contains("workspace HEAD moved"));
    }

    #[test]
    fn rejects_traversal_and_clone_identity_mismatch() {
        assert!(validate_repo("../demo").is_err());
        assert!(validate_component("thread", "../../other", 128).is_err());
        assert!(
            validate_clone_identity("https://github.com/other/demo.git", "bricko-brick/demo")
                .is_err()
        );
    }
}
