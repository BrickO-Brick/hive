//! Durable OneBrick repository discussions backed by isolated Git worktrees.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::Duration,
};

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Json,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{process::Command, sync::Mutex, time::timeout};
use uuid::Uuid;

use crate::state::AppState;

use super::{api_error, internal_error, onebrick_github};

pub(crate) const DISCUSSIONS_PATH: &str = "/api/onebrick/repository-discussions";
const GIT_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_DISCUSSIONS: usize = 500;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

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
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
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
    let output = timeout(
        GIT_TIMEOUT,
        Command::new("git")
            .args(args)
            .stderr(std::process::Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| "git operation timed out")?
    .map_err(|_| "git could not be started")?;
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
        .map_err(|error| internal_error(&format!("read Hive member role: {error}")))?
        .ok_or_else(|| api_error(StatusCode::FORBIDDEN, "membership_required"))?;
    if member.role != "owner" && member.role != "admin" {
        return Err(api_error(StatusCode::FORBIDDEN, "write_access_required"));
    }
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
}
