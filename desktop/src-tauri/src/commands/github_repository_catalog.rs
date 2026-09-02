use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

use crate::managed_agents::resolve_command;

const MAX_REPOSITORIES: usize = 1_000;
const GH_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawGitHubRepository {
    name: String,
    description: Option<String>,
    url: String,
    default_branch_ref: Option<RawGitHubBranchRef>,
    primary_language: Option<RawGitHubLanguage>,
    is_archived: bool,
    is_private: bool,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
struct RawGitHubBranchRef {
    name: String,
}

#[derive(Debug, Deserialize)]
struct RawGitHubLanguage {
    name: String,
}

#[derive(Debug, Serialize)]
pub struct GitHubRepositoryCatalogEntry {
    owner: String,
    name: String,
    description: String,
    url: String,
    clone_url: String,
    default_branch: String,
    language: Option<String>,
    archived: bool,
    private: bool,
    created_at: String,
    updated_at: String,
}

fn validate_github_owner(owner: &str) -> Result<&str, String> {
    let trimmed = owner.trim();
    let valid = !trimmed.is_empty()
        && trimmed.len() <= 39
        && !trimmed.starts_with('-')
        && !trimmed.ends_with('-')
        && trimmed
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    if !valid {
        return Err("GitHub owner must be a valid account name".into());
    }
    Ok(trimmed)
}

fn parse_catalog(owner: &str, output: &[u8]) -> Result<Vec<GitHubRepositoryCatalogEntry>, String> {
    let raw: Vec<RawGitHubRepository> = serde_json::from_slice(output)
        .map_err(|error| format!("GitHub returned an invalid repository catalog: {error}"))?;
    if raw.len() > MAX_REPOSITORIES {
        return Err(format!(
            "GitHub repository catalog exceeds the {MAX_REPOSITORIES}-repository safety limit"
        ));
    }

    let mut repositories = raw
        .into_iter()
        .map(|repository| GitHubRepositoryCatalogEntry {
            owner: owner.to_string(),
            clone_url: format!("{}.git", repository.url.trim_end_matches('/')),
            name: repository.name,
            description: repository.description.unwrap_or_default(),
            url: repository.url,
            default_branch: repository
                .default_branch_ref
                .map(|branch| branch.name)
                .unwrap_or_else(|| "main".into()),
            language: repository.primary_language.map(|language| language.name),
            archived: repository.is_archived,
            private: repository.is_private,
            created_at: repository.created_at,
            updated_at: repository.updated_at,
        })
        .collect::<Vec<_>>();
    repositories.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(repositories)
}

/// Lists repositories visible to the user's local GitHub CLI session.
///
/// Buzz never requests or stores the token. `gh` resolves the user's own
/// authenticated session and returns only the bounded metadata fields named
/// below. The local session is therefore the publication/discovery identity
/// boundary rather than a relay-owned credential.
#[tauri::command]
pub async fn list_github_owner_repositories(
    owner: String,
) -> Result<Vec<GitHubRepositoryCatalogEntry>, String> {
    let owner = validate_github_owner(&owner)?.to_string();
    let gh_path = resolve_command("gh").ok_or_else(|| {
        "GitHub CLI is not installed. Install `gh` and sign in with the publishing user."
            .to_string()
    })?;
    let max_repositories = MAX_REPOSITORIES.to_string();
    let mut command = Command::new(gh_path);
    command
        .args([
            "repo",
            "list",
            &owner,
            "--limit",
            &max_repositories,
            "--json",
            "name,description,url,defaultBranchRef,primaryLanguage,isArchived,isPrivate,createdAt,updatedAt",
        ])
        .env("GH_PAGER", "cat")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);

    let output = tokio::time::timeout(GH_TIMEOUT, command.output())
        .await
        .map_err(|_| "GitHub repository discovery timed out after 30 seconds".to_string())?
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "GitHub CLI is not installed. Install `gh` and sign in with the publishing user."
                    .to_string()
            } else {
                format!("Could not start GitHub repository discovery: {error}")
            }
        })?;

    if !output.status.success() {
        return Err("GitHub repository discovery failed. Run `gh auth status` locally.".into());
    }

    parse_catalog(&owner, &output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_validation_rejects_shell_and_path_syntax() {
        for owner in ["", "-owner", "owner-", "owner/name", "owner;echo"] {
            assert!(validate_github_owner(owner).is_err(), "accepted {owner:?}");
        }
        assert_eq!(
            validate_github_owner("BrickO-Brick").unwrap(),
            "BrickO-Brick"
        );
    }

    #[test]
    fn catalog_maps_only_bounded_public_metadata() {
        let output = br#"[{"name":"hive","description":"A workspace","url":"https://github.com/BrickO-Brick/hive","defaultBranchRef":{"name":"main"},"primaryLanguage":{"name":"Rust"},"isArchived":false,"isPrivate":true,"createdAt":"2026-08-01T00:00:00Z","updatedAt":"2026-09-01T23:11:59Z"}]"#;
        let catalog = parse_catalog("BrickO-Brick", output).unwrap();
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].owner, "BrickO-Brick");
        assert_eq!(catalog[0].name, "hive");
        assert_eq!(
            catalog[0].clone_url,
            "https://github.com/BrickO-Brick/hive.git"
        );
        assert_eq!(catalog[0].default_branch, "main");
        assert_eq!(catalog[0].language.as_deref(), Some("Rust"));
        assert!(catalog[0].private);
    }
}
