use std::{path::Path, process::Stdio, time::Duration};

use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

const GITHUB_LOOKUP_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_GITHUB_STDOUT_BYTES: usize = 256 * 1024;
const MAX_GITHUB_STDERR_BYTES: usize = 32 * 1024;
const MAX_GITHUB_ACTIVITY: usize = 12;
const GITHUB_UNAVAILABLE: &str = "Optional GitHub pull request activity is unavailable";
const GITHUB_PR_QUERY: &str = r#"query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){title state author{login avatarUrl} updatedAt url mergedAt mergedBy{login avatarUrl} reviews(last:8){nodes{state submittedAt author{login avatarUrl}}} comments(last:8){nodes{createdAt author{login avatarUrl} url}}}}}"#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CollectionGithubPullRequest {
    pub url: String,
    pub title: String,
    pub state: String,
    pub author: Option<String>,
    pub author_avatar_url: Option<String>,
    pub updated_at: String,
    pub activity: Vec<CollectionGithubPullRequestActivity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CollectionGithubPullRequestActivity {
    pub kind: String,
    pub author: Option<String>,
    pub author_avatar_url: Option<String>,
    pub state: Option<String>,
    pub created_at: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GithubPullRequestLocator {
    owner: String,
    repository: String,
    number: u32,
    url: String,
}

#[derive(Debug, Deserialize)]
struct GithubGraphqlResponse {
    data: Option<GithubGraphqlData>,
}

#[derive(Debug, Deserialize)]
struct GithubGraphqlData {
    repository: Option<GithubRepository>,
}

#[derive(Debug, Deserialize)]
struct GithubRepository {
    #[serde(rename = "pullRequest")]
    pull_request: Option<GithubPullRequest>,
}

#[derive(Debug, Deserialize)]
struct GithubPullRequest {
    title: String,
    state: String,
    author: Option<GithubActor>,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    url: String,
    #[serde(rename = "mergedAt")]
    merged_at: Option<String>,
    #[serde(rename = "mergedBy")]
    merged_by: Option<GithubActor>,
    reviews: GithubReviews,
    comments: GithubComments,
}

#[derive(Debug, Deserialize)]
struct GithubActor {
    login: String,
    #[serde(rename = "avatarUrl")]
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubReviews {
    #[serde(default)]
    nodes: Vec<GithubReview>,
}

#[derive(Debug, Deserialize)]
struct GithubReview {
    state: String,
    #[serde(rename = "submittedAt")]
    submitted_at: Option<String>,
    author: Option<GithubActor>,
}

#[derive(Debug, Deserialize)]
struct GithubComments {
    #[serde(default)]
    nodes: Vec<GithubComment>,
}

#[derive(Debug, Deserialize)]
struct GithubComment {
    #[serde(rename = "createdAt")]
    created_at: String,
    author: Option<GithubActor>,
    url: String,
}

/// Resolve current GitHub state for a PR URL derived from an explicitly-added
/// message or thread. The result is ephemeral and is never written to storage.
#[tauri::command]
pub async fn resolve_collection_github_pull_request(
    url: String,
) -> Result<CollectionGithubPullRequest, String> {
    let locator = parse_github_pull_request_url(&url)?;
    let gh_path = crate::managed_agents::resolve_command("gh").ok_or_else(|| {
        format!("{GITHUB_UNAVAILABLE}: GitHub CLI (`gh`) was not found on this device")
    })?;
    let output = fetch_github_pull_request(&gh_path, &locator).await?;
    parse_github_pull_request(&output, &locator)
}

async fn fetch_github_pull_request(
    gh_path: &Path,
    locator: &GithubPullRequestLocator,
) -> Result<Vec<u8>, String> {
    let owner = format!("owner={}", locator.owner);
    let repository = format!("name={}", locator.repository);
    let number = format!("number={}", locator.number);
    let query = format!("query={GITHUB_PR_QUERY}");
    let mut command = Command::new(gh_path);
    command
        .args([
            "api",
            "graphql",
            "--hostname",
            "github.com",
            "-f",
            &query,
            "-F",
            &owner,
            "-F",
            &repository,
            "-F",
            &number,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command
        .spawn()
        .map_err(|error| format!("{GITHUB_UNAVAILABLE}: failed to start `gh`: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("{GITHUB_UNAVAILABLE}: failed to capture `gh` output"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("{GITHUB_UNAVAILABLE}: failed to capture `gh` errors"))?;

    let (status, stdout, stderr) = tokio::time::timeout(GITHUB_LOOKUP_TIMEOUT, async move {
        let (stdout, stderr, status) = tokio::join!(
            read_bounded(stdout, MAX_GITHUB_STDOUT_BYTES),
            read_bounded(stderr, MAX_GITHUB_STDERR_BYTES),
            child.wait(),
        );
        Ok::<_, std::io::Error>((status?, stdout?, stderr?))
    })
    .await
    .map_err(|_| format!("{GITHUB_UNAVAILABLE}: lookup timed out"))?
    .map_err(|error| format!("{GITHUB_UNAVAILABLE}: failed while running `gh`: {error}"))?;
    if !status.success() {
        return Err(format!(
            "{GITHUB_UNAVAILABLE}: {}",
            first_safe_line(&stderr).unwrap_or("GitHub lookup failed")
        ));
    }
    Ok(stdout)
}

fn parse_github_pull_request(
    output: &[u8],
    locator: &GithubPullRequestLocator,
) -> Result<CollectionGithubPullRequest, String> {
    let response: GithubGraphqlResponse = serde_json::from_slice(output)
        .map_err(|error| format!("{GITHUB_UNAVAILABLE}: invalid `gh` response: {error}"))?;
    let pull_request = response
        .data
        .and_then(|data| data.repository)
        .and_then(|repository| repository.pull_request)
        .ok_or_else(|| {
            format!("{GITHUB_UNAVAILABLE}: pull request was not found or is not accessible")
        })?;
    let resolved_locator = parse_github_pull_request_url(&pull_request.url).map_err(|_| {
        format!("{GITHUB_UNAVAILABLE}: GitHub returned an invalid pull request URL")
    })?;
    if !resolved_locator.owner.eq_ignore_ascii_case(&locator.owner)
        || !resolved_locator
            .repository
            .eq_ignore_ascii_case(&locator.repository)
        || resolved_locator.number != locator.number
    {
        return Err(format!(
            "{GITHUB_UNAVAILABLE}: GitHub returned a different pull request"
        ));
    }

    let mut activity = pull_request
        .reviews
        .nodes
        .into_iter()
        .filter_map(|review| {
            let (author, author_avatar_url) = github_actor_fields(review.author);
            Some(CollectionGithubPullRequestActivity {
                kind: "review".to_string(),
                author,
                author_avatar_url,
                state: Some(review.state.to_ascii_lowercase()),
                created_at: review.submitted_at?,
                url: None,
            })
        })
        .chain(pull_request.comments.nodes.into_iter().map(|comment| {
            let (author, author_avatar_url) = github_actor_fields(comment.author);
            CollectionGithubPullRequestActivity {
                kind: "comment".to_string(),
                author,
                author_avatar_url,
                state: None,
                created_at: comment.created_at,
                url: Some(comment.url),
            }
        }))
        .collect::<Vec<_>>();
    if let Some(created_at) = pull_request.merged_at {
        let (author, author_avatar_url) = github_actor_fields(pull_request.merged_by);
        activity.push(CollectionGithubPullRequestActivity {
            kind: "merge".to_string(),
            author,
            author_avatar_url,
            state: None,
            created_at,
            url: Some(resolved_locator.url.clone()),
        });
    }
    activity.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    activity.truncate(MAX_GITHUB_ACTIVITY);
    let (author, author_avatar_url) = github_actor_fields(pull_request.author);

    Ok(CollectionGithubPullRequest {
        url: resolved_locator.url,
        title: pull_request.title,
        state: pull_request.state.to_ascii_lowercase(),
        author,
        author_avatar_url,
        updated_at: pull_request.updated_at,
        activity,
    })
}

fn github_actor_fields(actor: Option<GithubActor>) -> (Option<String>, Option<String>) {
    match actor {
        Some(actor) => (
            Some(actor.login),
            actor
                .avatar_url
                .as_deref()
                .and_then(normalize_github_avatar_url),
        ),
        None => (None, None),
    }
}

fn normalize_github_avatar_url(raw: &str) -> Option<String> {
    if raw != raw.trim() || raw.len() > 2_048 || raw.chars().any(char::is_control) {
        return None;
    }
    let parsed = url::Url::parse(raw).ok()?;
    if parsed.scheme() != "https"
        || !matches!(
            parsed.host_str(),
            Some("avatars.githubusercontent.com" | "github.com")
        )
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.fragment().is_some()
        || parsed.path().is_empty()
        || parsed.path() == "/"
    {
        return None;
    }
    Some(parsed.to_string())
}

fn parse_github_pull_request_url(raw: &str) -> Result<GithubPullRequestLocator, String> {
    if raw != raw.trim() || raw.len() > 2_048 || raw.chars().any(char::is_control) {
        return Err("invalid GitHub pull request URL".to_string());
    }
    let parsed = url::Url::parse(raw).map_err(|_| "invalid GitHub pull request URL".to_string())?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("URL is not a supported GitHub pull request".to_string());
    }
    let mut segments = parsed
        .path_segments()
        .ok_or_else(|| "URL is not a supported GitHub pull request".to_string())?
        .collect::<Vec<_>>();
    if segments.last() == Some(&"") {
        segments.pop();
    }
    if segments.len() != 4 || segments[2] != "pull" {
        return Err("URL is not a supported GitHub pull request".to_string());
    }
    let owner = segments[0];
    let repository = segments[1];
    if !valid_github_owner(owner) || !valid_github_repository(repository) {
        return Err("URL is not a supported GitHub pull request".to_string());
    }
    let number = segments[3]
        .parse::<u32>()
        .ok()
        .filter(|number| *number > 0)
        .ok_or_else(|| "URL is not a supported GitHub pull request".to_string())?;
    Ok(GithubPullRequestLocator {
        owner: owner.to_string(),
        repository: repository.to_string(),
        number,
        url: format!("https://github.com/{owner}/{repository}/pull/{number}"),
    })
}

fn valid_github_owner(value: &str) -> bool {
    (1..=39).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

fn valid_github_repository(value: &str) -> bool {
    (1..=100).contains(&value.len())
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

async fn read_bounded(
    reader: impl AsyncRead + Unpin,
    max_bytes: usize,
) -> Result<Vec<u8>, std::io::Error> {
    let mut bytes = Vec::new();
    reader
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > max_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "GitHub response exceeded the size limit",
        ));
    }
    Ok(bytes)
}

fn first_safe_line(stderr: &[u8]) -> Option<&str> {
    std::str::from_utf8(stderr)
        .ok()?
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.chars().any(char::is_control))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn locator() -> GithubPullRequestLocator {
        parse_github_pull_request_url("https://github.com/Block/Buzz/pull/803")
            .expect("valid PR URL")
    }

    #[test]
    fn github_pr_urls_are_strictly_validated_and_normalized() {
        assert_eq!(
            parse_github_pull_request_url("https://github.com/block/buzz/pull/00803/")
                .expect("valid PR URL")
                .url,
            "https://github.com/block/buzz/pull/803"
        );
        for invalid in [
            "http://github.com/block/buzz/pull/803",
            "https://github.com.evil.example/block/buzz/pull/803",
            "https://user@github.com/block/buzz/pull/803",
            "https://github.com/block/buzz/issues/803",
            "https://github.com/block/buzz/pull/803/files",
            "https://github.com/block/buzz/pull/0",
            "https://github.com/block/buzz/pull/803?diff=split",
            " https://github.com/block/buzz/pull/803",
            "https://github.com/bl%6fck/buzz/pull/803",
        ] {
            assert!(
                parse_github_pull_request_url(invalid).is_err(),
                "accepted {invalid}"
            );
        }
    }

    #[test]
    fn github_response_is_metadata_only_sorted_and_capped() {
        let comments = (0..20)
            .map(|index| {
                serde_json::json!({
                    "createdAt": format!("2026-08-27T12:{index:02}:00Z"),
                    "author": {
                        "login": "commenter",
                        "avatarUrl": "https://avatars.githubusercontent.com/u/456?v=4"
                    },
                    "url": format!("https://github.com/block/buzz/pull/803#issuecomment-{index}")
                })
            })
            .collect::<Vec<_>>();
        let output = serde_json::json!({
            "data": {"repository": {"pullRequest": {
                "title": "Collections",
                "state": "MERGED",
                "author": {
                    "login": "author",
                    "avatarUrl": "https://avatars.githubusercontent.com/u/123?v=4"
                },
                "updatedAt": "2026-08-27T13:00:00Z",
                "url": "https://github.com/block/buzz/pull/803",
                "mergedAt": "2026-08-27T12:59:00Z",
                "mergedBy": {
                    "login": "merger",
                    "avatarUrl": "https://github.com/merger.png"
                },
                "reviews": {"nodes": [{
                    "state": "APPROVED",
                    "submittedAt": "2026-08-27T12:58:00Z",
                    "author": {
                        "login": "reviewer",
                        "avatarUrl": "https://example.com/reviewer.png"
                    }
                }]},
                "comments": {"nodes": comments}
            }}}
        });
        let parsed = parse_github_pull_request(output.to_string().as_bytes(), &locator())
            .expect("valid response");
        assert_eq!(parsed.state, "merged");
        assert_eq!(parsed.author.as_deref(), Some("author"));
        assert_eq!(
            parsed.author_avatar_url.as_deref(),
            Some("https://avatars.githubusercontent.com/u/123?v=4")
        );
        assert_eq!(parsed.activity.len(), MAX_GITHUB_ACTIVITY);
        assert_eq!(parsed.activity[0].kind, "merge");
        assert_eq!(
            parsed.activity[0].author_avatar_url.as_deref(),
            Some("https://github.com/merger.png")
        );
        assert!(parsed.activity.iter().any(|activity| {
            activity.kind == "comment"
                && activity.author_avatar_url.as_deref()
                    == Some("https://avatars.githubusercontent.com/u/456?v=4")
        }));
        let serialized = serde_json::to_value(parsed).expect("serialize PR activity");
        assert!(serialized["activity"]
            .as_array()
            .expect("activity array")
            .iter()
            .all(|activity| activity.get("body").is_none()));
    }

    #[test]
    fn github_avatar_urls_are_credential_free_and_host_allowlisted() {
        assert_eq!(
            normalize_github_avatar_url("https://avatars.githubusercontent.com/u/123?v=4")
                .as_deref(),
            Some("https://avatars.githubusercontent.com/u/123?v=4")
        );
        assert_eq!(
            normalize_github_avatar_url("https://github.com/octocat.png").as_deref(),
            Some("https://github.com/octocat.png")
        );
        for invalid in [
            "http://avatars.githubusercontent.com/u/123",
            "https://user@avatars.githubusercontent.com/u/123",
            "https://avatars.githubusercontent.com.evil.example/u/123",
            "https://example.com/avatar.png",
            "https://github.com/",
            " https://github.com/octocat.png",
        ] {
            assert_eq!(
                normalize_github_avatar_url(invalid),
                None,
                "accepted {invalid}"
            );
        }
    }

    #[test]
    fn github_response_must_match_the_requested_url() {
        let output = serde_json::json!({
            "data": {"repository": {"pullRequest": {
                "title": "Other",
                "state": "OPEN",
                "author": null,
                "updatedAt": "2026-08-27T13:00:00Z",
                "url": "https://github.com/block/buzz/pull/804",
                "mergedAt": null,
                "mergedBy": null,
                "reviews": {"nodes": []},
                "comments": {"nodes": []}
            }}}
        });
        assert!(parse_github_pull_request(output.to_string().as_bytes(), &locator()).is_err());
    }

    #[tokio::test]
    async fn github_tool_output_is_bounded() {
        let error = read_bounded(&b"12345"[..], 4)
            .await
            .expect_err("oversized output should fail");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }
}
