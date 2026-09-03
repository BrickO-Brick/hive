use super::github_repository_workspace::{
    clean_process_environment, git_command, git_text, inspect_workspace_blocking,
    repository_coordinate, run_bounded, run_git, validate_segment,
};
use crate::managed_agents::resolve_command;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

const GH_TIMEOUT: Duration = Duration::from_secs(60);
const GIT_REMOTE_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_COMMIT_MESSAGE_CHARS: usize = 10_000;
const MAX_PR_TITLE_CHARS: usize = 256;
const MAX_PR_BODY_CHARS: usize = 30_000;

#[derive(Clone, Serialize)]
pub struct GitHubRepositoryPublicationIdentity {
    git_name: Option<String>,
    git_email: Option<String>,
    github_login: Option<String>,
    local_commit_ready: bool,
    remote_publication_ready: bool,
    blockers: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct GitHubRepositoryCommitResult {
    branch: String,
    commit: String,
    result_tree: String,
    author_name: String,
    author_email: String,
    signed_off_by: String,
    checked_out: bool,
    index_synchronized: bool,
    warning: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHubPullRequestRecord {
    number: u64,
    url: String,
    is_draft: bool,
    head_ref_oid: String,
    base_ref_name: String,
    state: String,
}

#[derive(Serialize)]
pub struct GitHubRepositoryPublishResult {
    branch: String,
    commit: String,
    base_branch: String,
    github_login: String,
    pull_request_number: u64,
    pull_request_url: String,
    draft: bool,
    branch_pushed: bool,
}

fn validate_object_id(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if !matches!(value.len(), 40 | 64)
        || !value
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
    {
        return Err(format!("{label} must be a lowercase Git object id."));
    }
    Ok(value.to_string())
}

fn validate_branch(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 240
        || value.starts_with('-')
        || value.starts_with('/')
        || value.ends_with('/')
        || value.ends_with('.')
        || value.ends_with(".lock")
        || value.starts_with("refs/")
        || value.contains("..")
        || value.contains("@{")
        || value.chars().any(|character| {
            character.is_control()
                || character.is_whitespace()
                || matches!(character, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
        })
    {
        return Err(format!("{label} is not a safe Git branch name."));
    }
    Ok(value.to_string())
}

fn validate_text(value: &str, label: &str, max_chars: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max_chars || value.contains('\0') {
        return Err(format!(
            "{label} must contain between 1 and {max_chars} text characters."
        ));
    }
    Ok(value.to_string())
}

fn read_user_git_config(repo_dir: &Path, key: &str) -> Option<String> {
    let git = resolve_command("git")?;
    let mut command = Command::new(git);
    command.args(["config", "--get", key]).current_dir(repo_dir);
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_SYSTEM",
    ] {
        command.env_remove(key);
    }
    command.stdin(Stdio::null());
    run_bounded(command, GH_TIMEOUT, "git identity")
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
}

fn validated_git_identity(repo_dir: &Path) -> Result<(String, String), String> {
    let name = read_user_git_config(repo_dir, "user.name")
        .ok_or_else(|| "Configure git user.name before creating a local commit.".to_string())?;
    let email = read_user_git_config(repo_dir, "user.email")
        .ok_or_else(|| "Configure git user.email before creating a local commit.".to_string())?;
    if name.chars().count() > 200
        || name
            .chars()
            .any(|character| matches!(character, '\r' | '\n' | '<' | '>'))
        || email.chars().count() > 320
        || email
            .chars()
            .any(|character| matches!(character, '\r' | '\n' | '<' | '>'))
        || email.chars().any(char::is_whitespace)
        || !email.contains('@')
    {
        return Err("The configured Git name or email cannot be used for user attribution.".into());
    }
    Ok((name, email))
}

fn gh_command(args: &[&str]) -> Result<Command, String> {
    let gh = resolve_command("gh").ok_or_else(|| {
        "GitHub CLI is not installed. Install `gh` and sign in with the publishing user."
            .to_string()
    })?;
    let mut command = Command::new(gh);
    command
        .args(args)
        .env("GH_PAGER", "cat")
        .stdin(Stdio::null());
    clean_process_environment(&mut command);
    Ok(command)
}

fn github_login() -> Result<String, String> {
    let output = run_bounded(
        gh_command(&["api", "user", "--jq", ".login"])?,
        GH_TIMEOUT,
        "GitHub identity check",
    )?;
    let login = String::from_utf8_lossy(&output.stdout).trim().to_string();
    validate_segment(&login, "login")
        .map_err(|_| "GitHub CLI did not return a valid signed-in user.".to_string())
}

fn publication_identity_blocking(
    owner: &str,
    name: &str,
    repos_dir: Option<&str>,
    workspace_id: Option<&str>,
) -> Result<GitHubRepositoryPublicationIdentity, String> {
    let workspace =
        inspect_workspace_blocking(owner, name, repos_dir, workspace_id)?.ok_or_else(|| {
            "Prepare the local repository before checking publication identity.".to_string()
        })?;
    let repo_dir = Path::new(&workspace.path);
    let git_name = read_user_git_config(repo_dir, "user.name");
    let git_email = read_user_git_config(repo_dir, "user.email");
    let github_login = github_login().ok();
    let mut blockers = Vec::new();
    let local_commit_ready = match validated_git_identity(repo_dir) {
        Ok(_) => true,
        Err(error) => {
            blockers.push(error);
            false
        }
    };
    if github_login.is_none() {
        blockers.push("Sign in with GitHub CLI before publishing a branch or PR.".to_string());
    }
    Ok(GitHubRepositoryPublicationIdentity {
        git_name,
        git_email,
        github_login,
        local_commit_ready,
        remote_publication_ready: local_commit_ready && blockers.is_empty(),
        blockers,
    })
}

fn signed_commit_message(message: &str, name: &str, email: &str) -> String {
    let trailer = format!("Signed-off-by: {name} <{email}>");
    if message.lines().any(|line| line.trim() == trailer) {
        message.to_string()
    } else {
        format!("{message}\n\n{trailer}")
    }
}

struct CommitExactTreeRequest<'a> {
    owner: &'a str,
    name: &'a str,
    repos_dir: Option<&'a str>,
    workspace_id: Option<&'a str>,
    expected_base_commit: &'a str,
    expected_result_tree: &'a str,
    branch_name: &'a str,
    message: &'a str,
}

fn commit_exact_tree_blocking(
    request: CommitExactTreeRequest<'_>,
) -> Result<GitHubRepositoryCommitResult, String> {
    let CommitExactTreeRequest {
        owner,
        name,
        repos_dir,
        workspace_id,
        expected_base_commit,
        expected_result_tree,
        branch_name,
        message,
    } = request;
    let workspace = inspect_workspace_blocking(owner, name, repos_dir, workspace_id)?
        .ok_or_else(|| "Prepare the local repository before creating a commit.".to_string())?;
    if workspace.base_commit != expected_base_commit
        || workspace.result_tree != expected_result_tree
    {
        return Err(
            "The local base or result tree changed after approval. Refresh, test, and approve again."
                .to_string(),
        );
    }
    if !workspace.dirty {
        return Err("There are no approved local changes to commit.".to_string());
    }
    if workspace.branch == branch_name {
        return Err(
            "Choose a new task branch so the current branch remains unchanged.".to_string(),
        );
    }
    let repo_dir = Path::new(&workspace.path);
    run_git(
        repo_dir,
        &["check-ref-format", "--branch", branch_name],
        None,
    )
    .map_err(|_| "Task branch is not accepted by Git.".to_string())?;
    let (author_name, author_email) = validated_git_identity(repo_dir)?;
    let signed_off_by = format!("{author_name} <{author_email}>");
    let message = signed_commit_message(message, &author_name, &author_email);

    let mut commit_command = git_command(
        repo_dir,
        &[
            "commit-tree",
            expected_result_tree,
            "-p",
            expected_base_commit,
            "-m",
            &message,
        ],
        None,
    )?;
    commit_command
        .env("GIT_AUTHOR_NAME", &author_name)
        .env("GIT_AUTHOR_EMAIL", &author_email)
        .env("GIT_COMMITTER_NAME", &author_name)
        .env("GIT_COMMITTER_EMAIL", &author_email)
        .stdin(Stdio::null());
    let output = run_bounded(commit_command, GH_TIMEOUT, "local Git commit")?;
    let commit = validate_object_id(
        String::from_utf8_lossy(&output.stdout).trim(),
        "Created commit",
    )?;
    if git_text(
        repo_dir,
        &["rev-parse", &format!("{commit}^{{tree}}")],
        None,
    )? != expected_result_tree
        || git_text(repo_dir, &["rev-parse", &format!("{commit}^1")], None)? != expected_base_commit
    {
        return Err("Git created a commit outside the approved base or result tree.".to_string());
    }

    let branch_ref = format!("refs/heads/{branch_name}");
    let zero = "0".repeat(commit.len());
    run_git(repo_dir, &["update-ref", &branch_ref, &commit, &zero], None).map_err(|_| {
        "The task branch already exists or changed. Choose a new branch name.".to_string()
    })?;

    let checkout = run_git(
        repo_dir,
        &[
            "symbolic-ref",
            "-m",
            "Buzz user-approved local commit",
            "HEAD",
            &branch_ref,
        ],
        None,
    );
    if let Err(error) = checkout {
        return Ok(GitHubRepositoryCommitResult {
            branch: branch_name.to_string(),
            commit,
            result_tree: expected_result_tree.to_string(),
            author_name,
            author_email,
            signed_off_by,
            checked_out: false,
            index_synchronized: false,
            warning: Some(format!(
                "The commit is durable on {branch_ref}, but Buzz could not select it: {error}"
            )),
        });
    }

    let index_sync = run_git(repo_dir, &["read-tree", "--reset", &commit], None);
    let (index_synchronized, warning) = match index_sync {
        Ok(_) => (true, None),
        Err(error) => (
            false,
            Some(format!(
                "The task branch is selected and committed, but its Git index needs repair: {error}"
            )),
        ),
    };
    Ok(GitHubRepositoryCommitResult {
        branch: branch_name.to_string(),
        commit,
        result_tree: expected_result_tree.to_string(),
        author_name,
        author_email,
        signed_off_by,
        checked_out: true,
        index_synchronized,
        warning,
    })
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
    let mut command = git_command(repo_dir, &refs, None)?;
    command.env("GH_PAGER", "cat").stdin(Stdio::null());
    Ok(command)
}

fn remote_branch_head(repo_dir: &Path, branch: &str) -> Result<Option<String>, String> {
    let branch_ref = format!("refs/heads/{branch}");
    let output = run_bounded(
        github_git_command(repo_dir, &["ls-remote", "--heads", "origin", &branch_ref])?,
        GIT_REMOTE_TIMEOUT,
        "GitHub branch check",
    )?;
    let text = String::from_utf8_lossy(&output.stdout);
    let Some(head) = text.split_whitespace().next() else {
        return Ok(None);
    };
    validate_object_id(head, "Remote branch head").map(Some)
}

fn list_pull_requests(
    coordinate: &str,
    branch: &str,
) -> Result<Vec<GitHubPullRequestRecord>, String> {
    let output = run_bounded(
        gh_command(&[
            "pr",
            "list",
            "--repo",
            coordinate,
            "--state",
            "all",
            "--head",
            branch,
            "--limit",
            "10",
            "--json",
            "number,url,isDraft,headRefOid,baseRefName,state",
        ])?,
        GH_TIMEOUT,
        "GitHub pull request check",
    )?;
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("GitHub returned invalid pull request metadata: {error}"))
}

struct PublishExactCommitRequest<'a> {
    owner: &'a str,
    name: &'a str,
    repos_dir: Option<&'a str>,
    workspace_id: Option<&'a str>,
    expected_commit: &'a str,
    expected_result_tree: &'a str,
    branch_name: &'a str,
    base_branch: &'a str,
    expected_github_login: &'a str,
    title: &'a str,
    body: &'a str,
}

fn publish_exact_commit_blocking(
    request: PublishExactCommitRequest<'_>,
) -> Result<GitHubRepositoryPublishResult, String> {
    let PublishExactCommitRequest {
        owner,
        name,
        repos_dir,
        workspace_id,
        expected_commit,
        expected_result_tree,
        branch_name,
        base_branch,
        expected_github_login,
        title,
        body,
    } = request;
    if branch_name == base_branch {
        return Err(
            "The publication branch must be different from the PR base branch.".to_string(),
        );
    }
    let workspace = inspect_workspace_blocking(owner, name, repos_dir, workspace_id)?
        .ok_or_else(|| "The committed local repository is no longer available.".to_string())?;
    if workspace.branch != branch_name
        || workspace.base_commit != expected_commit
        || workspace.dirty
        || git_text(
            Path::new(&workspace.path),
            &["rev-parse", &format!("{expected_commit}^{{tree}}")],
            None,
        )? != expected_result_tree
    {
        return Err(
            "The selected branch, commit, or working tree changed after local approval."
                .to_string(),
        );
    }
    let login = github_login()?;
    if !login.eq_ignore_ascii_case(expected_github_login) {
        return Err(format!(
            "GitHub CLI is signed in as {login}, not the confirmed publishing user {expected_github_login}."
        ));
    }
    let repo_dir = Path::new(&workspace.path);
    let mut branch_pushed = false;
    match remote_branch_head(repo_dir, branch_name)? {
        Some(remote_head) if remote_head == expected_commit => {}
        Some(_) => {
            return Err(
                "The remote publication branch already exists at a different commit.".to_string(),
            );
        }
        None => {
            let refspec = format!("HEAD:refs/heads/{branch_name}");
            run_bounded(
                github_git_command(
                    repo_dir,
                    &[
                        "push",
                        "--porcelain",
                        "--end-of-options",
                        "origin",
                        &refspec,
                    ],
                )?,
                GIT_REMOTE_TIMEOUT,
                "GitHub branch publication",
            )?;
            branch_pushed = true;
            if remote_branch_head(repo_dir, branch_name)?.as_deref() != Some(expected_commit) {
                return Err(
                    "GitHub did not report the exact committed branch after push.".to_string(),
                );
            }
        }
    }

    let coordinate = repository_coordinate(owner, name);
    let existing = list_pull_requests(&coordinate, branch_name)?;
    if let Some(record) = existing.first() {
        if record.state.eq_ignore_ascii_case("open")
            && record.head_ref_oid == expected_commit
            && record.base_ref_name == base_branch
        {
            return Ok(GitHubRepositoryPublishResult {
                branch: branch_name.to_string(),
                commit: expected_commit.to_string(),
                base_branch: base_branch.to_string(),
                github_login: login,
                pull_request_number: record.number,
                pull_request_url: record.url.clone(),
                draft: record.is_draft,
                branch_pushed,
            });
        }
        return Err(
            "A pull request already uses this publication branch with different lifecycle state."
                .to_string(),
        );
    }

    let output = run_bounded(
        gh_command(&[
            "pr",
            "create",
            "--repo",
            &coordinate,
            "--head",
            branch_name,
            "--base",
            base_branch,
            "--title",
            title,
            "--body",
            body,
            "--draft",
        ])?,
        GH_TIMEOUT,
        "GitHub Draft PR publication",
    )?;
    let url = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("https://github.com/"))
        .ok_or_else(|| "GitHub created a PR but did not return its canonical URL.".to_string())?
        .to_string();
    let output = run_bounded(
        gh_command(&[
            "pr",
            "view",
            &url,
            "--repo",
            &coordinate,
            "--json",
            "number,url,isDraft,headRefOid,baseRefName,state",
        ])?,
        GH_TIMEOUT,
        "GitHub Draft PR verification",
    )?;
    let record: GitHubPullRequestRecord = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("GitHub returned invalid created PR metadata: {error}"))?;
    if !record.state.eq_ignore_ascii_case("open")
        || !record.is_draft
        || record.head_ref_oid != expected_commit
        || record.base_ref_name != base_branch
    {
        return Err("The created GitHub PR does not match the confirmed publication.".to_string());
    }
    Ok(GitHubRepositoryPublishResult {
        branch: branch_name.to_string(),
        commit: expected_commit.to_string(),
        base_branch: base_branch.to_string(),
        github_login: login,
        pull_request_number: record.number,
        pull_request_url: record.url,
        draft: record.is_draft,
        branch_pushed,
    })
}

#[tauri::command]
pub async fn get_github_repository_publication_identity(
    owner: String,
    name: String,
    repos_dir: Option<String>,
    workspace_id: Option<String>,
) -> Result<GitHubRepositoryPublicationIdentity, String> {
    let owner = validate_segment(&owner, "owner")?;
    let name = validate_segment(&name, "repository")?;
    tauri::async_runtime::spawn_blocking(move || {
        publication_identity_blocking(&owner, &name, repos_dir.as_deref(), workspace_id.as_deref())
    })
    .await
    .map_err(|error| format!("publication identity task failed: {error}"))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn commit_github_repository_change(
    owner: String,
    name: String,
    repos_dir: Option<String>,
    workspace_id: Option<String>,
    expected_base_commit: String,
    expected_result_tree: String,
    branch_name: String,
    message: String,
) -> Result<GitHubRepositoryCommitResult, String> {
    let owner = validate_segment(&owner, "owner")?;
    let name = validate_segment(&name, "repository")?;
    let expected_base_commit = validate_object_id(&expected_base_commit, "Base commit")?;
    let expected_result_tree = validate_object_id(&expected_result_tree, "Result tree")?;
    let branch_name = validate_branch(&branch_name, "Task branch")?;
    let message = validate_text(&message, "Commit message", MAX_COMMIT_MESSAGE_CHARS)?;
    tauri::async_runtime::spawn_blocking(move || {
        commit_exact_tree_blocking(CommitExactTreeRequest {
            owner: &owner,
            name: &name,
            repos_dir: repos_dir.as_deref(),
            workspace_id: workspace_id.as_deref(),
            expected_base_commit: &expected_base_commit,
            expected_result_tree: &expected_result_tree,
            branch_name: &branch_name,
            message: &message,
        })
    })
    .await
    .map_err(|error| format!("local commit task failed: {error}"))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn publish_github_repository_change(
    owner: String,
    name: String,
    repos_dir: Option<String>,
    workspace_id: Option<String>,
    expected_commit: String,
    expected_result_tree: String,
    branch_name: String,
    base_branch: String,
    expected_github_login: String,
    remote_publication_authorized: bool,
    title: String,
    body: String,
) -> Result<GitHubRepositoryPublishResult, String> {
    if !remote_publication_authorized {
        return Err("Explicit user authorization is required for GitHub publication.".to_string());
    }
    let owner = validate_segment(&owner, "owner")?;
    let name = validate_segment(&name, "repository")?;
    let expected_commit = validate_object_id(&expected_commit, "Commit")?;
    let expected_result_tree = validate_object_id(&expected_result_tree, "Result tree")?;
    let branch_name = validate_branch(&branch_name, "Publication branch")?;
    let base_branch = validate_branch(&base_branch, "PR base branch")?;
    let expected_github_login = validate_segment(&expected_github_login, "login")?;
    let title = validate_text(&title, "PR title", MAX_PR_TITLE_CHARS)?;
    let body = validate_text(&body, "PR body", MAX_PR_BODY_CHARS)?;
    tauri::async_runtime::spawn_blocking(move || {
        publish_exact_commit_blocking(PublishExactCommitRequest {
            owner: &owner,
            name: &name,
            repos_dir: repos_dir.as_deref(),
            workspace_id: workspace_id.as_deref(),
            expected_commit: &expected_commit,
            expected_result_tree: &expected_result_tree,
            branch_name: &branch_name,
            base_branch: &base_branch,
            expected_github_login: &expected_github_login,
            title: &title,
            body: &body,
        })
    })
    .await
    .map_err(|error| format!("GitHub publication task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Output;

    fn test_git(repo: &Path, args: &[&str]) -> Output {
        Command::new(resolve_command("git").expect("git is required"))
            .args(args)
            .current_dir(repo)
            .output()
            .expect("run git fixture command")
    }

    fn fixture() -> (tempfile::TempDir, std::path::PathBuf, String) {
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
                "https://github.com/BrickO-Brick/hive.git"
            ],
        )
        .status
        .success());
        assert!(test_git(&repo, &["config", "user.name", "Buzz User"])
            .status
            .success());
        assert!(
            test_git(&repo, &["config", "user.email", "buzz@example.test"])
                .status
                .success()
        );
        std::fs::write(repo.join("tracked.txt"), "before\n").expect("write fixture");
        assert!(test_git(&repo, &["add", "tracked.txt"]).status.success());
        assert!(test_git(&repo, &["commit", "-m", "Initial"])
            .status
            .success());
        let base = String::from_utf8_lossy(&test_git(&repo, &["rev-parse", "HEAD"]).stdout)
            .trim()
            .to_string();
        std::fs::write(repo.join("tracked.txt"), "after\n").expect("modify fixture");
        std::fs::write(repo.join("untracked.txt"), "new\n").expect("add fixture");
        (root, repo, base)
    }

    #[test]
    fn exact_tree_commit_preserves_base_branch_and_uses_user_identity() {
        let (root, repo, base) = fixture();
        let workspace =
            inspect_workspace_blocking("BrickO-Brick", "hive", root.path().to_str(), None)
                .expect("inspect fixture")
                .expect("workspace exists");
        let result = commit_exact_tree_blocking(CommitExactTreeRequest {
            owner: "BrickO-Brick",
            name: "hive",
            repos_dir: root.path().to_str(),
            workspace_id: None,
            expected_base_commit: &base,
            expected_result_tree: &workspace.result_tree,
            branch_name: "users/buzz-user/exact-tree",
            message: "Keep publication user-owned",
        })
        .expect("commit approved tree");

        assert!(result.checked_out);
        assert!(result.index_synchronized);
        assert_eq!(result.author_name, "Buzz User");
        assert_eq!(result.author_email, "buzz@example.test");
        assert_eq!(
            git_text(&repo, &["rev-parse", "refs/heads/main"], None).unwrap(),
            base
        );
        assert_eq!(
            git_text(&repo, &["branch", "--show-current"], None).unwrap(),
            "users/buzz-user/exact-tree"
        );
        assert_eq!(
            git_text(&repo, &["rev-parse", "HEAD^{tree}"], None).unwrap(),
            workspace.result_tree
        );
        let commit_text = git_text(&repo, &["show", "-s", "--format=%B", "HEAD"], None).unwrap();
        assert!(commit_text.contains("Signed-off-by: Buzz User <buzz@example.test>"));
        assert!(test_git(&repo, &["status", "--porcelain"])
            .stdout
            .is_empty());
    }

    #[test]
    fn exact_tree_commit_rejects_stale_approval_without_creating_branch() {
        let (root, repo, base) = fixture();
        let workspace =
            inspect_workspace_blocking("BrickO-Brick", "hive", root.path().to_str(), None)
                .unwrap()
                .unwrap();
        std::fs::write(repo.join("tracked.txt"), "changed again\n").expect("revise fixture");
        let error = commit_exact_tree_blocking(CommitExactTreeRequest {
            owner: "BrickO-Brick",
            name: "hive",
            repos_dir: root.path().to_str(),
            workspace_id: None,
            expected_base_commit: &base,
            expected_result_tree: &workspace.result_tree,
            branch_name: "users/buzz-user/stale",
            message: "Stale change",
        })
        .expect_err("stale tree must fail");
        assert!(error.contains("changed after approval"));
        assert!(!test_git(
            &repo,
            &["show-ref", "--verify", "refs/heads/users/buzz-user/stale"]
        )
        .status
        .success());
    }

    #[test]
    fn branch_and_object_validation_fail_closed() {
        for branch in [
            "",
            "-force",
            "main..next",
            "refs/heads/x",
            "feature name",
            "x.lock",
        ] {
            assert!(
                validate_branch(branch, "Branch").is_err(),
                "accepted {branch:?}"
            );
        }
        assert!(validate_object_id(&"a".repeat(40), "Tree").is_ok());
        assert!(validate_object_id(&"A".repeat(40), "Tree").is_err());
    }

    #[test]
    fn signed_message_does_not_duplicate_user_dco_trailer() {
        let message = "Subject\n\nSigned-off-by: Buzz User <buzz@example.test>";
        assert_eq!(
            signed_commit_message(message, "Buzz User", "buzz@example.test"),
            message
        );
    }
}
