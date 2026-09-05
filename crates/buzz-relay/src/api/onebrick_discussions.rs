//! Durable OneBrick repository discussions backed by isolated Git worktrees.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};

use axum::{
    body::Bytes,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::Mutex,
    time::timeout,
};
use uuid::Uuid;

use crate::state::AppState;

use super::{api_error, internal_error, onebrick_github};

pub(crate) const DISCUSSIONS_PATH: &str = "/api/onebrick/repository-discussions";
const GIT_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_DISCUSSIONS: usize = 500;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_WORKSPACE_FILES: usize = 2_000;
const MAX_GIT_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_EDITABLE_FILE_BYTES: u64 = 512 * 1024;

static GIT_WORKSPACE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Deserialize)]
pub(crate) struct CreateDiscussionRequest {
    owner: String,
    repository: String,
    title: String,
    default_branch: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepositoryDiscussion {
    id: Uuid,
    owner: String,
    repository: String,
    title: String,
    mirror_id: String,
    worktree_id: String,
    branch_ref: String,
    base_ref: String,
    base_sha: String,
    current_head_sha: String,
    proposal_revision: Option<String>,
    proposal_digest: Option<String>,
    test_evidence: Vec<String>,
    created_by: String,
    created_at: DateTime<Utc>,
    #[serde(default)]
    status: DiscussionStatus,
    #[serde(default)]
    completion_evidence: Option<String>,
    #[serde(default)]
    closed_by: Option<String>,
    #[serde(default)]
    closed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    workspace_cleaned_at: Option<DateTime<Utc>>,
    #[serde(default)]
    mirror_cleaned: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DiscussionStatus {
    #[default]
    Active,
    CleanupPending,
    Closed,
}

#[derive(Debug, Serialize, Deserialize)]
struct DiscussionManifest {
    #[serde(flatten)]
    discussion: RepositoryDiscussion,
    mirror_path: PathBuf,
    worktree_path: PathBuf,
}

#[derive(Debug, Serialize)]
pub(crate) struct DiscussionList {
    discussions: Vec<RepositoryDiscussion>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFileRequest {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFileWriteRequest {
    path: String,
    content: String,
    expected_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceCommitRequest {
    message: String,
    expected_head_sha: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloseDiscussionRequest {
    expected_head_sha: String,
    completion_evidence: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFileSummary {
    path: String,
    status: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceState {
    discussion_id: Uuid,
    current_head_sha: String,
    dirty: bool,
    files: Vec<WorkspaceFileSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFile {
    path: String,
    content: String,
    digest: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceDiff {
    current_head_sha: String,
    diff: String,
    additions: usize,
    deletions: usize,
    changed_files: usize,
}

fn valid_name(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= max
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn authorize_discussion_creator(
    member_role: Option<&str>,
) -> Result<(), (StatusCode, Json<Value>)> {
    member_role
        .map(|_| ())
        .ok_or_else(|| api_error(StatusCode::FORBIDDEN, "membership_required"))
}

fn token_for_owner(owner: &str) -> Option<String> {
    let personal_owner =
        std::env::var("BUZZ_ONEBRICK_GITHUB_ORG").unwrap_or_else(|_| "BrickO-Brick".into());
    let env_name = if owner.eq_ignore_ascii_case(&personal_owner) {
        "BUZZ_ONEBRICK_GITHUB_TOKEN"
    } else if owner.eq_ignore_ascii_case("brick-io") {
        "BUZZ_BRICK_IO_GITHUB_TOKEN"
    } else if owner.eq_ignore_ascii_case("BrickI-Brick") {
        "BUZZ_BRICKI_GITHUB_TOKEN"
    } else {
        return None;
    };
    std::env::var(env_name).ok().filter(|token| {
        let trimmed = token.trim();
        trimmed.len() >= 20 && trimmed.len() <= 512 && !trimmed.contains("CHANGE_ME")
    })
}

fn workspace_root(state: &AppState) -> PathBuf {
    state.config.git_repo_path.join("onebrick-discussions")
}

fn git_auth_header(token: &str) -> String {
    format!(
        "Authorization: Basic {}",
        STANDARD.encode(format!("x-access-token:{}", token.trim()))
    )
}

async fn git_status(args: &[&str], token: Option<&str>) -> Result<(), &'static str> {
    let mut command = Command::new("git");
    command
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(token) = token {
        command
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
            .env("GIT_CONFIG_VALUE_0", git_auth_header(token));
    }
    let status = timeout(GIT_TIMEOUT, command.status())
        .await
        .map_err(|_| "git operation timed out")?
        .map_err(|_| "git could not be started")?;
    status.success().then_some(()).ok_or("git operation failed")
}

async fn git_value(args: &[&str]) -> Result<String, &'static str> {
    let output = git_output(args, 256).await?;
    if !output.status.success() || output.stdout.len() > 256 {
        return Err("git operation failed");
    }
    let value = String::from_utf8(output.stdout).map_err(|_| "git returned invalid output")?;
    let value = value.trim();
    if (value.len() != 40 && value.len() != 64)
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("git returned an invalid revision");
    }
    Ok(value.to_string())
}

async fn git_output(
    args: &[&str],
    max_output_bytes: usize,
) -> Result<std::process::Output, &'static str> {
    let mut command = Command::new("git");
    command
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true)
        .stderr(Stdio::piped())
        .stdout(Stdio::piped());
    let mut child = command.spawn().map_err(|_| "git could not be started")?;
    let stdout = child.stdout.take().ok_or("git stdout was unavailable")?;
    let stderr = child.stderr.take().ok_or("git stderr was unavailable")?;
    let capture = async {
        let (stdout, stderr, status) = tokio::try_join!(
            read_bounded(stdout, max_output_bytes),
            read_bounded(stderr, max_output_bytes),
            child.wait()
        )?;
        Ok::<_, std::io::Error>(std::process::Output {
            status,
            stdout,
            stderr,
        })
    };
    let output = timeout(GIT_TIMEOUT, capture)
        .await
        .map_err(|_| "git operation timed out")?
        .map_err(|_| "git output could not be read")?;
    if output.stdout.len().saturating_add(output.stderr.len()) > max_output_bytes {
        return Err("git output exceeded its size limit");
    }
    Ok(output)
}

async fn read_bounded(
    reader: impl AsyncRead + Unpin,
    max_output_bytes: usize,
) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(max_output_bytes.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    Ok(bytes)
}

fn workspace_api_path(id: Uuid, suffix: &str) -> String {
    format!("{DISCUSSIONS_PATH}/{id}/workspace{suffix}")
}

fn close_api_path(id: Uuid) -> String {
    format!("{DISCUSSIONS_PATH}/{id}/close")
}

fn valid_workspace_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1_024
        && !path.starts_with('/')
        && !path.contains('\0')
        && Path::new(path).components().all(|component| {
            matches!(component, std::path::Component::Normal(_)) && component.as_os_str() != ".git"
        })
}

async fn read_manifest(
    state: &AppState,
    id: Uuid,
) -> Result<DiscussionManifest, (StatusCode, Json<Value>)> {
    let path = workspace_root(state)
        .join("manifests")
        .join(format!("{id}.json"));
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => {
                api_error(StatusCode::NOT_FOUND, "discussion_not_found")
            }
            _ => internal_error(&format!("read discussion metadata: {error}")),
        })?;
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err(internal_error(
            "discussion manifest exceeded its size limit",
        ));
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| internal_error(&format!("read discussion manifest: {error}")))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| internal_error(&format!("parse discussion manifest: {error}")))
}

async fn load_manifest(
    state: &AppState,
    id: Uuid,
) -> Result<DiscussionManifest, (StatusCode, Json<Value>)> {
    let manifest = read_manifest(state, id).await?;
    if manifest.discussion.status != DiscussionStatus::Active {
        return Err(api_error(StatusCode::CONFLICT, "discussion_closed"));
    }
    let worktrees = tokio::fs::canonicalize(workspace_root(state).join("worktrees"))
        .await
        .map_err(|error| internal_error(&format!("resolve workspace root: {error}")))?;
    let worktree = tokio::fs::canonicalize(&manifest.worktree_path)
        .await
        .map_err(|error| internal_error(&format!("resolve discussion workspace: {error}")))?;
    if !worktree.starts_with(&worktrees) {
        return Err(internal_error("discussion workspace escaped its root"));
    }
    Ok(manifest)
}

async fn authenticated_post_member(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    path: &str,
    body: &[u8],
) -> Result<String, (StatusCode, Json<Value>)> {
    let (tenant, pubkey) = super::invites::authenticate(state, headers, path, body).await?;
    let member = state
        .db
        .get_relay_member(tenant.community(), &pubkey.to_hex())
        .await
        .map_err(|error| internal_error(&format!("read Hive membership: {error}")))?;
    authorize_discussion_creator(member.as_ref().map(|member| member.role.as_str()))?;
    Ok(pubkey.to_hex())
}

async fn editable_file_path(
    worktree: &Path,
    requested: &str,
) -> Result<PathBuf, (StatusCode, Json<Value>)> {
    if !valid_workspace_path(requested) {
        return Err(api_error(StatusCode::BAD_REQUEST, "invalid_file_path"));
    }
    let candidate = worktree.join(requested);
    let metadata = tokio::fs::symlink_metadata(&candidate)
        .await
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => api_error(StatusCode::NOT_FOUND, "file_not_found"),
            _ => internal_error(&format!("read workspace file metadata: {error}")),
        })?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(api_error(StatusCode::BAD_REQUEST, "file_not_editable"));
    }
    if metadata.len() > MAX_EDITABLE_FILE_BYTES {
        return Err(api_error(StatusCode::PAYLOAD_TOO_LARGE, "file_too_large"));
    }
    let canonical = tokio::fs::canonicalize(&candidate)
        .await
        .map_err(|error| internal_error(&format!("resolve workspace file: {error}")))?;
    if !canonical.starts_with(worktree) {
        return Err(api_error(StatusCode::BAD_REQUEST, "invalid_file_path"));
    }
    Ok(canonical)
}

async fn remove_task_path(path: &Path) {
    if let Err(error) = tokio::fs::remove_dir_all(path).await {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(path = %path.display(), %error, "failed to clean incomplete discussion workspace");
        }
    }
}

async fn cleanup_worktree(mirror: &Path, worktree: &Path, branch_ref: &str) {
    let mirror_arg = mirror.to_string_lossy();
    let worktree_arg = worktree.to_string_lossy();
    let branch = branch_ref.trim_start_matches("refs/heads/");
    let _ = git_status(
        &[
            "--git-dir",
            &mirror_arg,
            "worktree",
            "remove",
            "--force",
            &worktree_arg,
        ],
        None,
    )
    .await;
    remove_task_path(worktree).await;
    let _ = git_status(&["--git-dir", &mirror_arg, "branch", "-D", branch], None).await;
}

async fn create_workspace(
    state: &AppState,
    request: CreateDiscussionRequest,
    creator: String,
) -> Result<RepositoryDiscussion, (StatusCode, Json<Value>)> {
    let title = request.title.trim();
    if !valid_name(&request.owner, 39)
        || !valid_name(&request.repository, 100)
        || !valid_name(&request.default_branch, 255)
        || title.is_empty()
        || title.chars().count() > 160
    {
        return Err(api_error(StatusCode::BAD_REQUEST, "invalid_discussion"));
    }
    let token = token_for_owner(&request.owner)
        .ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "repository_owner_not_configured"))?;
    let id = Uuid::new_v4();
    let canonical = format!(
        "{}/{}",
        request.owner.to_ascii_lowercase(),
        request.repository.to_ascii_lowercase()
    );
    let mirror_id = hex::encode(Sha256::digest(canonical.as_bytes()));
    let worktree_id = id.simple().to_string();
    let branch_ref = format!("refs/heads/codex/hive-discussion-{}", &worktree_id[..12]);
    let base_ref = format!("refs/heads/{}", request.default_branch);
    let root = workspace_root(state);
    let mirror = root.join("mirrors").join(format!("{mirror_id}.git"));
    let worktree = root.join("worktrees").join(&worktree_id);
    let manifests = root.join("manifests");
    let temporary_mirror = root
        .join("mirrors")
        .join(format!(".{mirror_id}-{worktree_id}.tmp"));
    tokio::fs::create_dir_all(root.join("mirrors"))
        .await
        .map_err(|error| internal_error(&format!("create mirror directory: {error}")))?;
    tokio::fs::create_dir_all(root.join("worktrees"))
        .await
        .map_err(|error| internal_error(&format!("create worktree directory: {error}")))?;
    tokio::fs::create_dir_all(&manifests)
        .await
        .map_err(|error| internal_error(&format!("create manifest directory: {error}")))?;

    let _guard = GIT_WORKSPACE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .await;
    let git_url = format!(
        "https://github.com/{}/{}.git",
        request.owner, request.repository
    );
    if mirror.exists() {
        let mirror_arg = mirror.to_string_lossy();
        git_status(
            &["--git-dir", &mirror_arg, "fetch", "--prune", "origin"],
            Some(&token),
        )
        .await
        .map_err(|message| api_error(StatusCode::BAD_GATEWAY, message))?;
    } else {
        remove_task_path(&temporary_mirror).await;
        let temporary_arg = temporary_mirror.to_string_lossy();
        if let Err(message) = git_status(
            &["clone", "--mirror", &git_url, &temporary_arg],
            Some(&token),
        )
        .await
        {
            remove_task_path(&temporary_mirror).await;
            return Err(api_error(StatusCode::BAD_GATEWAY, message));
        }
        if let Err(error) = tokio::fs::rename(&temporary_mirror, &mirror).await {
            remove_task_path(&temporary_mirror).await;
            if !mirror.exists() {
                return Err(internal_error(&format!("publish mirror: {error}")));
            }
        }
    }
    let mirror_arg = mirror.to_string_lossy();
    let base_sha = git_value(&["--git-dir", &mirror_arg, "rev-parse", &base_ref])
        .await
        .map_err(|message| api_error(StatusCode::BAD_GATEWAY, message))?;
    let worktree_arg = worktree.to_string_lossy();
    let branch_name = branch_ref.trim_start_matches("refs/heads/");
    if let Err(message) = git_status(
        &[
            "--git-dir",
            &mirror_arg,
            "worktree",
            "add",
            "-b",
            branch_name,
            &worktree_arg,
            &base_sha,
        ],
        None,
    )
    .await
    {
        cleanup_worktree(&mirror, &worktree, &branch_ref).await;
        return Err(api_error(StatusCode::BAD_GATEWAY, message));
    }
    let current_head_sha = match git_value(&["-C", &worktree_arg, "rev-parse", "HEAD"]).await {
        Ok(value) => value,
        Err(message) => {
            cleanup_worktree(&mirror, &worktree, &branch_ref).await;
            return Err(api_error(StatusCode::BAD_GATEWAY, message));
        }
    };
    let discussion = RepositoryDiscussion {
        id,
        owner: request.owner,
        repository: request.repository,
        title: title.to_string(),
        mirror_id,
        worktree_id,
        branch_ref,
        base_ref,
        base_sha,
        current_head_sha,
        proposal_revision: None,
        proposal_digest: None,
        test_evidence: Vec::new(),
        created_by: creator,
        created_at: Utc::now(),
        status: DiscussionStatus::Active,
        completion_evidence: None,
        closed_by: None,
        closed_at: None,
        workspace_cleaned_at: None,
        mirror_cleaned: false,
    };
    let manifest = DiscussionManifest {
        discussion: discussion.clone(),
        mirror_path: mirror.clone(),
        worktree_path: worktree.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| internal_error(&format!("serialize discussion: {error}")))?;
    let temporary_manifest = manifests.join(format!(".{}.tmp", discussion.id));
    let final_manifest = manifests.join(format!("{}.json", discussion.id));
    if let Err(error) = tokio::fs::write(&temporary_manifest, bytes).await {
        cleanup_worktree(&mirror, &worktree, &discussion.branch_ref).await;
        return Err(internal_error(&format!(
            "write discussion manifest: {error}"
        )));
    }
    if let Err(error) = tokio::fs::rename(&temporary_manifest, &final_manifest).await {
        let _ = tokio::fs::remove_file(&temporary_manifest).await;
        cleanup_worktree(&mirror, &worktree, &discussion.branch_ref).await;
        return Err(internal_error(&format!(
            "publish discussion manifest: {error}"
        )));
    }
    Ok(discussion)
}

pub(crate) async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(StatusCode, Json<RepositoryDiscussion>), (StatusCode, Json<Value>)> {
    let (tenant, pubkey) =
        super::invites::authenticate(&state, &headers, DISCUSSIONS_PATH, &body).await?;
    let member = state
        .db
        .get_relay_member(tenant.community(), &pubkey.to_hex())
        .await
        .map_err(|error| internal_error(&format!("read Hive membership: {error}")))?;
    authorize_discussion_creator(member.as_ref().map(|member| member.role.as_str()))?;
    let request = serde_json::from_slice(&body)
        .map_err(|_| api_error(StatusCode::BAD_REQUEST, "invalid_discussion"))?;
    let discussion = create_workspace(&state, request, pubkey.to_hex()).await?;
    Ok((StatusCode::CREATED, Json(discussion)))
}

pub(crate) async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<DiscussionList>, (StatusCode, Json<Value>)> {
    onebrick_github::authenticated_member(&state, &headers, DISCUSSIONS_PATH).await?;
    let manifests = workspace_root(&state).join("manifests");
    let mut entries = match tokio::fs::read_dir(&manifests).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Json(DiscussionList {
                discussions: Vec::new(),
            }));
        }
        Err(error) => return Err(internal_error(&format!("read discussions: {error}"))),
    };
    let mut discussions = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| internal_error(&format!("read discussion entry: {error}")))?
    {
        if discussions.len() >= MAX_DISCUSSIONS
            || entry.path().extension().and_then(|v| v.to_str()) != Some("json")
        {
            continue;
        }
        let metadata = entry
            .metadata()
            .await
            .map_err(|error| internal_error(&format!("read discussion metadata: {error}")))?;
        if metadata.len() > MAX_MANIFEST_BYTES {
            return Err(internal_error(
                "discussion manifest exceeded its size limit",
            ));
        }
        let bytes = tokio::fs::read(entry.path())
            .await
            .map_err(|error| internal_error(&format!("read discussion manifest: {error}")))?;
        let manifest: DiscussionManifest = serde_json::from_slice(&bytes)
            .map_err(|error| internal_error(&format!("parse discussion manifest: {error}")))?;
        discussions.push(manifest.discussion);
    }
    discussions.sort_by_key(|discussion| std::cmp::Reverse(discussion.created_at));
    Ok(Json(DiscussionList { discussions }))
}

fn parse_statuses(bytes: &[u8]) -> HashMap<String, String> {
    let mut statuses = HashMap::new();
    for record in bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        if record.len() < 4 || record.get(2) != Some(&b' ') {
            continue;
        }
        let status = String::from_utf8_lossy(&record[..2]).trim().to_string();
        let path = String::from_utf8_lossy(&record[3..]).to_string();
        if valid_workspace_path(&path) {
            statuses.insert(path, status);
        }
    }
    statuses
}

pub(crate) async fn workspace(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
    headers: HeaderMap,
) -> Result<Json<WorkspaceState>, (StatusCode, Json<Value>)> {
    let path = workspace_api_path(id, "");
    onebrick_github::authenticated_member(&state, &headers, &path).await?;
    let manifest = load_manifest(&state, id).await?;
    let worktree = manifest.worktree_path.to_string_lossy();
    let file_output = git_output(
        &["-C", &worktree, "ls-files", "-z", "--cached"],
        MAX_GIT_OUTPUT_BYTES,
    )
    .await
    .map_err(|message| api_error(StatusCode::BAD_GATEWAY, message))?;
    if !file_output.status.success() {
        return Err(api_error(StatusCode::BAD_GATEWAY, "git operation failed"));
    }
    let status_output = git_output(
        &[
            "-C",
            &worktree,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
        ],
        MAX_GIT_OUTPUT_BYTES,
    )
    .await
    .map_err(|message| api_error(StatusCode::BAD_GATEWAY, message))?;
    if !status_output.status.success() {
        return Err(api_error(StatusCode::BAD_GATEWAY, "git operation failed"));
    }
    let statuses = parse_statuses(&status_output.stdout);
    let mut files = file_output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
        .filter_map(|value| String::from_utf8(value.to_vec()).ok())
        .filter(|path| valid_workspace_path(path))
        .take(MAX_WORKSPACE_FILES + 1)
        .map(|path| WorkspaceFileSummary {
            status: statuses.get(&path).cloned(),
            path,
        })
        .collect::<Vec<_>>();
    if files.len() > MAX_WORKSPACE_FILES {
        return Err(api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "workspace_has_too_many_files",
        ));
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let dirty = files.iter().any(|file| file.status.is_some());
    let current_head_sha = git_value(&["-C", &worktree, "rev-parse", "HEAD"])
        .await
        .map_err(|message| api_error(StatusCode::BAD_GATEWAY, message))?;
    Ok(Json(WorkspaceState {
        discussion_id: id,
        current_head_sha,
        dirty,
        files,
    }))
}

pub(crate) async fn read_file(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<WorkspaceFile>, (StatusCode, Json<Value>)> {
    let api_path = workspace_api_path(id, "/file/read");
    authenticated_post_member(&state, &headers, &api_path, &body).await?;
    let request: WorkspaceFileRequest = serde_json::from_slice(&body)
        .map_err(|_| api_error(StatusCode::BAD_REQUEST, "invalid_file_request"))?;
    let manifest = load_manifest(&state, id).await?;
    let path = editable_file_path(&manifest.worktree_path, &request.path).await?;
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| internal_error(&format!("read workspace file: {error}")))?;
    if bytes.contains(&0) {
        return Err(api_error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "binary_file"));
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| api_error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "binary_file"))?;
    let digest = hex::encode(Sha256::digest(content.as_bytes()));
    Ok(Json(WorkspaceFile {
        path: request.path,
        content,
        digest,
    }))
}

pub(crate) async fn write_file(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<WorkspaceFile>, (StatusCode, Json<Value>)> {
    let api_path = workspace_api_path(id, "/file/write");
    authenticated_post_member(&state, &headers, &api_path, &body).await?;
    let request: WorkspaceFileWriteRequest = serde_json::from_slice(&body)
        .map_err(|_| api_error(StatusCode::BAD_REQUEST, "invalid_file_request"))?;
    if request.content.len() as u64 > MAX_EDITABLE_FILE_BYTES || request.content.contains('\0') {
        return Err(api_error(StatusCode::PAYLOAD_TOO_LARGE, "file_too_large"));
    }
    if request.expected_digest.len() != 64
        || !request
            .expected_digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(api_error(StatusCode::BAD_REQUEST, "invalid_file_digest"));
    }
    let _guard = GIT_WORKSPACE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .await;
    let manifest = load_manifest(&state, id).await?;
    let path = editable_file_path(&manifest.worktree_path, &request.path).await?;
    let current = tokio::fs::read(&path)
        .await
        .map_err(|error| internal_error(&format!("read workspace file: {error}")))?;
    if current.contains(&0) || std::str::from_utf8(&current).is_err() {
        return Err(api_error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "binary_file"));
    }
    let current_digest = hex::encode(Sha256::digest(&current));
    if current_digest != request.expected_digest.to_ascii_lowercase() {
        return Err(api_error(StatusCode::CONFLICT, "file_changed"));
    }
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| internal_error(&format!("read workspace file metadata: {error}")))?;
    let temporary = path.with_file_name(format!(
        ".hive-edit-{}-{}",
        id.simple(),
        Uuid::new_v4().simple()
    ));
    let write_result = async {
        use tokio::io::AsyncWriteExt;

        let mut file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .await?;
        file.write_all(request.content.as_bytes()).await?;
        file.sync_all().await?;
        tokio::fs::set_permissions(&temporary, metadata.permissions()).await?;
        tokio::fs::rename(&temporary, &path).await
    }
    .await;
    if let Err(error) = write_result {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(internal_error(&format!("write workspace file: {error}")));
    }
    let digest = hex::encode(Sha256::digest(request.content.as_bytes()));
    Ok(Json(WorkspaceFile {
        path: request.path,
        content: request.content,
        digest,
    }))
}

fn diff_counts(diff: &str) -> (usize, usize, usize) {
    let mut additions = 0;
    let mut deletions = 0;
    let mut changed_files = 0;
    for line in diff.lines() {
        if line.starts_with("diff --git ") {
            changed_files += 1;
        } else if line.starts_with('+') && !line.starts_with("+++") {
            additions += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            deletions += 1;
        }
    }
    (additions, deletions, changed_files)
}

pub(crate) async fn diff(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
    headers: HeaderMap,
) -> Result<Json<WorkspaceDiff>, (StatusCode, Json<Value>)> {
    let path = workspace_api_path(id, "/diff");
    onebrick_github::authenticated_member(&state, &headers, &path).await?;
    let manifest = load_manifest(&state, id).await?;
    let worktree = manifest.worktree_path.to_string_lossy();
    let output = git_output(
        &[
            "-C",
            &worktree,
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--unified=3",
            "HEAD",
            "--",
        ],
        MAX_GIT_OUTPUT_BYTES,
    )
    .await
    .map_err(|message| api_error(StatusCode::BAD_GATEWAY, message))?;
    if !output.status.success() {
        return Err(api_error(StatusCode::BAD_GATEWAY, "git operation failed"));
    }
    let diff = String::from_utf8(output.stdout)
        .map_err(|_| api_error(StatusCode::BAD_GATEWAY, "git returned invalid output"))?;
    let (additions, deletions, changed_files) = diff_counts(&diff);
    let current_head_sha = git_value(&["-C", &worktree, "rev-parse", "HEAD"])
        .await
        .map_err(|message| api_error(StatusCode::BAD_GATEWAY, message))?;
    Ok(Json(WorkspaceDiff {
        current_head_sha,
        diff,
        additions,
        deletions,
        changed_files,
    }))
}

async fn persist_manifest(
    state: &AppState,
    manifest: &DiscussionManifest,
) -> Result<(), (StatusCode, Json<Value>)> {
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| internal_error(&format!("serialize discussion: {error}")))?;
    let directory = workspace_root(state).join("manifests");
    let temporary = directory.join(format!(
        ".{}-{}.tmp",
        manifest.discussion.id,
        Uuid::new_v4()
    ));
    let final_path = directory.join(format!("{}.json", manifest.discussion.id));
    tokio::fs::write(&temporary, bytes)
        .await
        .map_err(|error| internal_error(&format!("write discussion manifest: {error}")))?;
    tokio::fs::rename(&temporary, final_path)
        .await
        .map_err(|error| {
            let _ = std::fs::remove_file(&temporary);
            internal_error(&format!("publish discussion manifest: {error}"))
        })?;
    Ok(())
}

fn completion_evidence(value: Option<String>) -> Result<Option<String>, (StatusCode, Json<Value>)> {
    let evidence = value.map(|item| item.trim().to_string());
    if evidence
        .as_ref()
        .is_some_and(|item| item.is_empty() || item.chars().count() > 500)
    {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "invalid_completion_evidence",
        ));
    }
    Ok(evidence)
}

async fn mirror_has_other_open_discussions(
    root: &Path,
    discussion: &RepositoryDiscussion,
) -> Result<bool, (StatusCode, Json<Value>)> {
    let directory = root.join("manifests");
    let mut entries = tokio::fs::read_dir(directory)
        .await
        .map_err(|error| internal_error(&format!("read discussions: {error}")))?;
    let mut manifest_count = 0usize;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| internal_error(&format!("read discussion entry: {error}")))?
    {
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        manifest_count = manifest_count.saturating_add(1);
        if manifest_count > MAX_DISCUSSIONS {
            return Err(internal_error("discussion manifest limit exceeded"));
        }
        let metadata = entry
            .metadata()
            .await
            .map_err(|error| internal_error(&format!("read discussion metadata: {error}")))?;
        if metadata.len() > MAX_MANIFEST_BYTES {
            return Err(internal_error(
                "discussion manifest exceeded its size limit",
            ));
        }
        let bytes = tokio::fs::read(entry.path())
            .await
            .map_err(|error| internal_error(&format!("read discussion manifest: {error}")))?;
        let manifest: DiscussionManifest = serde_json::from_slice(&bytes)
            .map_err(|error| internal_error(&format!("parse discussion manifest: {error}")))?;
        if manifest.discussion.id != discussion.id
            && manifest.discussion.mirror_id == discussion.mirror_id
            && manifest.discussion.status != DiscussionStatus::Closed
        {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn clean_discussion_workspace(
    state: &AppState,
    manifest: &DiscussionManifest,
) -> Result<bool, (StatusCode, Json<Value>)> {
    let root = workspace_root(state);
    clean_discussion_workspace_at(&root, manifest).await
}

async fn clean_discussion_workspace_at(
    root: &Path,
    manifest: &DiscussionManifest,
) -> Result<bool, (StatusCode, Json<Value>)> {
    let expected_mirror = root
        .join("mirrors")
        .join(format!("{}.git", manifest.discussion.mirror_id));
    let expected_worktree = root
        .join("worktrees")
        .join(&manifest.discussion.worktree_id);
    if manifest.mirror_path != expected_mirror || manifest.worktree_path != expected_worktree {
        return Err(internal_error(
            "discussion cleanup path did not match its manifest identity",
        ));
    }

    let mirror_arg = expected_mirror.to_string_lossy();
    let worktree_arg = expected_worktree.to_string_lossy();
    if expected_worktree.exists() {
        if !expected_mirror.exists() {
            return Err(internal_error(
                "discussion mirror is missing during cleanup",
            ));
        }
        git_status(
            &[
                "--git-dir",
                &mirror_arg,
                "worktree",
                "remove",
                "--force",
                &worktree_arg,
            ],
            None,
        )
        .await
        .map_err(|message| api_error(StatusCode::BAD_GATEWAY, message))?;
    }
    if expected_mirror.exists() {
        git_status(
            &[
                "--git-dir",
                &mirror_arg,
                "update-ref",
                "-d",
                &manifest.discussion.branch_ref,
            ],
            None,
        )
        .await
        .map_err(|message| api_error(StatusCode::BAD_GATEWAY, message))?;
    }

    if mirror_has_other_open_discussions(root, &manifest.discussion).await? {
        return Ok(false);
    }
    match tokio::fs::remove_dir_all(&expected_mirror).await {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(internal_error(&format!(
            "remove discussion mirror: {error}"
        ))),
    }
}

pub(crate) async fn close(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<RepositoryDiscussion>, (StatusCode, Json<Value>)> {
    let api_path = close_api_path(id);
    let actor = authenticated_post_member(&state, &headers, &api_path, &body).await?;
    let request: CloseDiscussionRequest = serde_json::from_slice(&body)
        .map_err(|_| api_error(StatusCode::BAD_REQUEST, "invalid_close_request"))?;
    let evidence = completion_evidence(request.completion_evidence)?;
    let _guard = GIT_WORKSPACE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .await;
    let mut manifest = read_manifest(&state, id).await?;
    if request.expected_head_sha != manifest.discussion.current_head_sha {
        return Err(api_error(StatusCode::CONFLICT, "workspace_head_changed"));
    }
    if manifest.discussion.status == DiscussionStatus::Closed {
        return Ok(Json(manifest.discussion));
    }

    if manifest.discussion.status == DiscussionStatus::Active {
        let worktree = manifest.worktree_path.to_string_lossy();
        let current_head_sha = git_value(&["-C", &worktree, "rev-parse", "HEAD"])
            .await
            .map_err(|message| api_error(StatusCode::BAD_GATEWAY, message))?;
        if current_head_sha != request.expected_head_sha {
            return Err(api_error(StatusCode::CONFLICT, "workspace_head_changed"));
        }
        let status = git_output(
            &[
                "-C",
                &worktree,
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
            ],
            MAX_GIT_OUTPUT_BYTES,
        )
        .await
        .map_err(|message| api_error(StatusCode::BAD_GATEWAY, message))?;
        if !status.status.success() {
            return Err(api_error(StatusCode::BAD_GATEWAY, "git operation failed"));
        }
        if !status.stdout.is_empty() {
            return Err(api_error(StatusCode::CONFLICT, "workspace_has_changes"));
        }
        if manifest.discussion.proposal_revision.is_some() && evidence.is_none() {
            return Err(api_error(
                StatusCode::BAD_REQUEST,
                "completion_evidence_required",
            ));
        }
        let now = Utc::now();
        manifest.discussion.status = DiscussionStatus::CleanupPending;
        manifest.discussion.completion_evidence = evidence;
        manifest.discussion.closed_by = Some(actor);
        manifest.discussion.closed_at = Some(now);
        persist_manifest(&state, &manifest).await?;
    }

    let mirror_cleaned = clean_discussion_workspace(&state, &manifest).await?;
    manifest.discussion.status = DiscussionStatus::Closed;
    manifest.discussion.workspace_cleaned_at = Some(Utc::now());
    manifest.discussion.mirror_cleaned = mirror_cleaned;
    persist_manifest(&state, &manifest).await?;
    Ok(Json(manifest.discussion))
}

pub(crate) async fn commit(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<RepositoryDiscussion>, (StatusCode, Json<Value>)> {
    let api_path = workspace_api_path(id, "/commit");
    let author = authenticated_post_member(&state, &headers, &api_path, &body).await?;
    let request: WorkspaceCommitRequest = serde_json::from_slice(&body)
        .map_err(|_| api_error(StatusCode::BAD_REQUEST, "invalid_commit_request"))?;
    let message = request.message.trim();
    if message.is_empty() || message.chars().count() > 160 {
        return Err(api_error(StatusCode::BAD_REQUEST, "invalid_commit_message"));
    }
    let _guard = GIT_WORKSPACE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .await;
    let mut manifest = load_manifest(&state, id).await?;
    let worktree = manifest.worktree_path.to_string_lossy();
    let current_head_sha = git_value(&["-C", &worktree, "rev-parse", "HEAD"])
        .await
        .map_err(|message| api_error(StatusCode::BAD_GATEWAY, message))?;
    if current_head_sha != request.expected_head_sha {
        return Err(api_error(StatusCode::CONFLICT, "workspace_head_changed"));
    }
    git_status(&["-C", &worktree, "add", "--update"], None)
        .await
        .map_err(|message| api_error(StatusCode::BAD_GATEWAY, message))?;
    let status = git_output(
        &["-C", &worktree, "diff", "--cached", "--quiet", "--"],
        8 * 1024,
    )
    .await
    .map_err(|message| api_error(StatusCode::BAD_GATEWAY, message))?;
    if status.status.success() {
        return Err(api_error(StatusCode::CONFLICT, "workspace_has_no_changes"));
    }
    if status.status.code() != Some(1) {
        return Err(api_error(StatusCode::BAD_GATEWAY, "git operation failed"));
    }
    let mut command = Command::new("git");
    command
        .args(["-C", &worktree, "commit", "-m", message])
        .env("GIT_AUTHOR_NAME", "Hive Member")
        .env("GIT_AUTHOR_EMAIL", format!("{author}@hive.local"))
        .env("GIT_COMMITTER_NAME", "Hive")
        .env("GIT_COMMITTER_EMAIL", "hive@onebrick.io")
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let commit_status = timeout(GIT_TIMEOUT, command.status())
        .await
        .map_err(|_| api_error(StatusCode::GATEWAY_TIMEOUT, "git operation timed out"))?
        .map_err(|_| api_error(StatusCode::BAD_GATEWAY, "git could not be started"))?;
    if !commit_status.success() {
        return Err(api_error(StatusCode::BAD_GATEWAY, "git operation failed"));
    }
    let revision = git_value(&["-C", &worktree, "rev-parse", "HEAD"])
        .await
        .map_err(|message| api_error(StatusCode::BAD_GATEWAY, message))?;
    manifest.discussion.current_head_sha = revision.clone();
    manifest.discussion.proposal_revision = Some(revision.clone());
    manifest.discussion.proposal_digest = Some(hex::encode(Sha256::digest(revision.as_bytes())));
    persist_manifest(&state, &manifest).await?;
    Ok(Json(manifest.discussion))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_cannot_escape_workspace_paths() {
        assert!(valid_name("BrickO-Brick", 39));
        assert!(valid_name("hive_web", 100));
        for invalid in ["../hive", "-owner", "owner/child", "", "."] {
            assert!(!valid_name(invalid, 100));
        }
    }

    #[test]
    fn every_hive_member_can_create_a_repository_discussion() {
        for role in ["member", "admin", "owner"] {
            assert!(
                authorize_discussion_creator(Some(role)).is_ok(),
                "{role} must be allowed to start a discussion"
            );
        }

        let (status, _) = authorize_discussion_creator(None).expect_err("non-member must fail");
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[test]
    fn workspace_paths_are_relative_regular_components() {
        for valid in ["src/main.ts", "README.md", "crates/buzz-core/src/lib.rs"] {
            assert!(valid_workspace_path(valid), "{valid} must be accepted");
        }
        for invalid in [
            "",
            "/etc/passwd",
            "../secret",
            "src/../secret",
            ".git/config",
        ] {
            assert!(!valid_workspace_path(invalid), "{invalid} must be rejected");
        }
    }

    #[test]
    fn diff_summary_ignores_headers() {
        let diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n-old\n+new\n";
        assert_eq!(diff_counts(diff), (1, 1, 1));
    }

    #[test]
    fn legacy_discussions_remain_active_after_lifecycle_upgrade() {
        let discussion: RepositoryDiscussion = serde_json::from_value(serde_json::json!({
            "id": "11111111-2222-4333-8444-555555555555",
            "owner": "BrickO-Brick",
            "repository": "hive",
            "title": "Existing discussion",
            "mirrorId": "aa",
            "worktreeId": "bb",
            "branchRef": "refs/heads/codex/hive-discussion-test",
            "baseRef": "refs/heads/main",
            "baseSha": "cc",
            "currentHeadSha": "dd",
            "proposalRevision": null,
            "proposalDigest": null,
            "testEvidence": [],
            "createdBy": "ee",
            "createdAt": "2026-09-03T10:00:00Z"
        }))
        .expect("legacy discussion must deserialize");

        assert_eq!(discussion.status, DiscussionStatus::Active);
        assert!(discussion.closed_at.is_none());
        assert!(!discussion.mirror_cleaned);
    }

    #[test]
    fn completion_evidence_is_trimmed_and_bounded() {
        assert_eq!(
            completion_evidence(Some("  https://example.test/build/1  ".into()))
                .expect("valid evidence"),
            Some("https://example.test/build/1".into())
        );
        assert!(completion_evidence(Some("   ".into())).is_err());
        assert!(completion_evidence(Some("x".repeat(501))).is_err());
    }

    #[tokio::test]
    async fn completed_discussion_removes_its_worktree_branch_and_unused_mirror() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let root = temporary.path().join("onebrick-discussions");
        let source = temporary.path().join("source");
        let id =
            Uuid::parse_str("11111111-2222-4333-8444-555555555555").expect("valid discussion id");
        let mirror_id = "aa".repeat(32);
        let worktree_id = id.simple().to_string();
        let mirror = root.join("mirrors").join(format!("{mirror_id}.git"));
        let worktree = root.join("worktrees").join(&worktree_id);
        let manifests = root.join("manifests");
        std::fs::create_dir_all(&source).expect("source directory");
        std::fs::create_dir_all(root.join("mirrors")).expect("mirror directory");
        std::fs::create_dir_all(root.join("worktrees")).expect("worktree directory");
        std::fs::create_dir_all(&manifests).expect("manifest directory");

        let run_git = |args: &[&str], directory: &Path| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(directory)
                .env("GIT_AUTHOR_NAME", "Hive Test")
                .env("GIT_AUTHOR_EMAIL", "hive-test@example.test")
                .env("GIT_COMMITTER_NAME", "Hive Test")
                .env("GIT_COMMITTER_EMAIL", "hive-test@example.test")
                .status()
                .expect("git must start");
            assert!(status.success(), "git {args:?} must succeed");
        };
        run_git(&["init", "-b", "main"], &source);
        std::fs::write(source.join("README.md"), "Hive cleanup test\n").expect("fixture file");
        run_git(&["add", "README.md"], &source);
        run_git(&["commit", "-m", "Initial fixture"], &source);
        run_git(
            &[
                "clone",
                "--mirror",
                source.to_str().expect("source path"),
                mirror.to_str().expect("mirror path"),
            ],
            temporary.path(),
        );
        run_git(
            &[
                "--git-dir",
                mirror.to_str().expect("mirror path"),
                "worktree",
                "add",
                "-b",
                "codex/hive-discussion-111111112222",
                worktree.to_str().expect("worktree path"),
                "HEAD",
            ],
            temporary.path(),
        );
        let head = git_value(&[
            "-C",
            worktree.to_str().expect("worktree path"),
            "rev-parse",
            "HEAD",
        ])
        .await
        .expect("fixture head");
        let manifest = DiscussionManifest {
            discussion: RepositoryDiscussion {
                id,
                owner: "BrickO-Brick".into(),
                repository: "hive".into(),
                title: "Cleanup lifecycle".into(),
                mirror_id,
                worktree_id,
                branch_ref: "refs/heads/codex/hive-discussion-111111112222".into(),
                base_ref: "refs/heads/main".into(),
                base_sha: head.clone(),
                current_head_sha: head,
                proposal_revision: None,
                proposal_digest: None,
                test_evidence: Vec::new(),
                created_by: "test-user".into(),
                created_at: Utc::now(),
                status: DiscussionStatus::CleanupPending,
                completion_evidence: None,
                closed_by: Some("test-user".into()),
                closed_at: Some(Utc::now()),
                workspace_cleaned_at: None,
                mirror_cleaned: false,
            },
            mirror_path: mirror.clone(),
            worktree_path: worktree.clone(),
        };
        std::fs::write(
            manifests.join(format!("{id}.json")),
            serde_json::to_vec(&manifest).expect("manifest serialization"),
        )
        .expect("manifest write");

        assert!(clean_discussion_workspace_at(&root, &manifest)
            .await
            .expect("cleanup must succeed"));
        assert!(!worktree.exists(), "worktree must be deleted");
        assert!(!mirror.exists(), "unused mirror must be deleted");
    }
}
