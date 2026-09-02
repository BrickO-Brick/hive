//! Authenticated OneBrick GitHub repository catalog.
//!
//! Private repository metadata must never be embedded in the public web bundle.
//! This endpoint keeps the GitHub credential on the relay, authenticates the
//! Hive caller with NIP-98, and returns a bounded metadata-only response.

use std::{sync::Arc, time::Duration};

use axum::{extract::State, http::HeaderMap, http::StatusCode, response::Json};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::state::AppState;

use super::{api_error, bridge, relay_members};

/// Authenticated catalog route mounted by the relay router.
pub(crate) const CATALOG_PATH: &str = "/api/onebrick/github/repositories";
const GITHUB_API_ROOT: &str = "https://api.github.com";
const GITHUB_API_VERSION: &str = "2026-03-10";
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_UPSTREAM_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_REPOSITORIES: usize = 100;

#[derive(Debug, Deserialize)]
struct GitHubRepository {
    name: String,
    description: Option<String>,
    html_url: String,
    private: bool,
    default_branch: String,
    updated_at: String,
    archived: bool,
    language: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub(crate) struct CatalogRepository {
    name: String,
    description: String,
    url: String,
    visibility: &'static str,
    default_branch: String,
    updated_at: String,
    archived: bool,
    language: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct CatalogResponse {
    organization: String,
    repositories: Vec<CatalogRepository>,
}

fn valid_github_organization(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 39
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn valid_repository_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn bounded_text(value: String, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn parse_catalog(
    body: &[u8],
    organization: &str,
) -> Result<Vec<CatalogRepository>, (StatusCode, Json<Value>)> {
    let upstream: Vec<GitHubRepository> = serde_json::from_slice(body).map_err(|_| {
        api_error(
            StatusCode::BAD_GATEWAY,
            "GitHub returned an invalid repository catalog",
        )
    })?;
    if upstream.len() > MAX_REPOSITORIES {
        return Err(api_error(
            StatusCode::BAD_GATEWAY,
            "GitHub repository catalog exceeded the configured limit",
        ));
    }

    let expected_url_prefix = format!("https://github.com/{organization}/");
    upstream
        .into_iter()
        .map(|repository| {
            if !valid_repository_name(&repository.name)
                || !repository.html_url.starts_with(&expected_url_prefix)
                || repository.default_branch.is_empty()
                || repository.default_branch.len() > 255
                || repository.updated_at.len() > 64
                || repository
                    .language
                    .as_ref()
                    .is_some_and(|language| language.len() > 64)
            {
                return Err(api_error(
                    StatusCode::BAD_GATEWAY,
                    "GitHub returned invalid repository metadata",
                ));
            }
            Ok(CatalogRepository {
                name: repository.name,
                description: bounded_text(repository.description.unwrap_or_default(), 500),
                url: repository.html_url,
                visibility: if repository.private {
                    "private"
                } else {
                    "public"
                },
                default_branch: repository.default_branch,
                updated_at: repository.updated_at,
                archived: repository.archived,
                language: repository.language,
            })
        })
        .collect()
}

async fn authenticated_member(
    state: &Arc<AppState>,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<Value>)> {
    let raw_host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let tenant = crate::tenant::bind_community(&state.db, raw_host)
        .await
        .map_err(|_| {
            api_error(
                StatusCode::NOT_FOUND,
                "relay: no community is configured for this host",
            )
        })?;
    let expected_url = bridge::nip98_expected_url(&state.config.relay_url, &tenant, CATALOG_PATH);
    let bridge::VerifiedBridgeAuth {
        pubkey,
        event_id_bytes,
        signed_created_at,
    } = bridge::verify_bridge_auth(headers, "GET", &expected_url, None, true)?;
    bridge::enforce_http_admission(state, &tenant, &pubkey).await?;
    bridge::check_nip98_replay(state, &tenant, event_id_bytes).await?;
    relay_members::enforce_relay_membership(
        state,
        tenant.community(),
        &pubkey.to_bytes(),
        relay_members::extract_auth_tag_header(headers),
        signed_created_at,
    )
    .await?;
    Ok(())
}

async fn bounded_body(response: reqwest::Response) -> Result<Vec<u8>, (StatusCode, Json<Value>)> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_UPSTREAM_RESPONSE_BYTES as u64)
    {
        return Err(api_error(
            StatusCode::BAD_GATEWAY,
            "GitHub repository catalog was too large",
        ));
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            api_error(
                StatusCode::BAD_GATEWAY,
                "GitHub repository catalog could not be read",
            )
        })?;
        if body.len().saturating_add(chunk.len()) > MAX_UPSTREAM_RESPONSE_BYTES {
            return Err(api_error(
                StatusCode::BAD_GATEWAY,
                "GitHub repository catalog was too large",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Return the configured organization's repositories to an authenticated Hive
/// member. The GitHub token remains server-side and only metadata is returned.
pub(crate) async fn repositories(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<CatalogResponse>, (StatusCode, Json<Value>)> {
    authenticated_member(&state, &headers).await?;

    let organization =
        std::env::var("BUZZ_ONEBRICK_GITHUB_ORG").unwrap_or_else(|_| "BrickO-Brick".to_string());
    if !valid_github_organization(&organization) {
        return Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "GitHub repository catalog is not configured",
        ));
    }
    let token = std::env::var("BUZZ_ONEBRICK_GITHUB_TOKEN").unwrap_or_default();
    if token.trim().len() < 20 || token.len() > 512 || token.contains("CHANGE_ME") {
        return Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "GitHub repository catalog is not configured",
        ));
    }

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| {
            api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "GitHub repository catalog is unavailable",
            )
        })?;
    let url = format!(
        "{GITHUB_API_ROOT}/orgs/{organization}/repos?type=all&sort=updated&direction=desc&per_page={MAX_REPOSITORIES}"
    );
    let response = client
        .get(url)
        .timeout(UPSTREAM_TIMEOUT)
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", format!("Bearer {}", token.trim()))
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
        .header("User-Agent", "OneBrick-Hive")
        .send()
        .await
        .map_err(|error| {
            tracing::warn!(
                timeout = error.is_timeout(),
                "GitHub catalog request failed"
            );
            api_error(
                StatusCode::BAD_GATEWAY,
                "GitHub repository catalog is unavailable",
            )
        })?;
    if !response.status().is_success() {
        tracing::warn!(status = %response.status(), "GitHub catalog request rejected");
        return Err(api_error(
            StatusCode::BAD_GATEWAY,
            "GitHub repository catalog is unavailable",
        ));
    }
    let body = bounded_body(response).await?;
    let repositories = parse_catalog(&body, &organization)?;
    Ok(Json(CatalogResponse {
        organization,
        repositories,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bounded_repository_metadata() {
        let body = br#"[{"name":"hive","description":"Collaboration","html_url":"https://github.com/BrickO-Brick/hive","private":false,"default_branch":"main","updated_at":"2026-09-02T10:34:31Z","archived":false,"language":"Rust"}]"#;
        let repositories = parse_catalog(body, "BrickO-Brick").expect("valid catalog");
        assert_eq!(repositories.len(), 1);
        assert_eq!(repositories[0].name, "hive");
        assert_eq!(repositories[0].visibility, "public");
    }

    #[test]
    fn rejects_cross_organization_urls_and_invalid_names() {
        for body in [
            br#"[{"name":"hive","description":null,"html_url":"https://github.com/other/hive","private":true,"default_branch":"main","updated_at":"2026-09-02T10:34:31Z","archived":false,"language":null}]"#.as_slice(),
            br#"[{"name":"../hive","description":null,"html_url":"https://github.com/BrickO-Brick/../hive","private":true,"default_branch":"main","updated_at":"2026-09-02T10:34:31Z","archived":false,"language":null}]"#.as_slice(),
        ] {
            assert!(parse_catalog(body, "BrickO-Brick").is_err());
        }
    }

    #[test]
    fn validates_github_organization_names() {
        assert!(valid_github_organization("BrickO-Brick"));
        assert!(!valid_github_organization("-BrickO"));
        assert!(!valid_github_organization("BrickO/other"));
    }
}
