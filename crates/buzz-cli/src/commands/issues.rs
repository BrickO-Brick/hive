use crate::client::BuzzClient;
use crate::commands::with_git_provenance;
use crate::error::CliError;
use crate::validate::{read_or_stdin, sdk_err, validate_hex64, validate_repo_id};
use buzz_sdk::{GitIssueMeta, GitRepoCoord, GitStatusMeta};
use nostr::Timestamp;

fn assignment_note_label(assignees: &[String], label: Option<&str>) -> Result<String, CliError> {
    if let Some(label) = label {
        let label = label.trim();
        if label.is_empty() || label.chars().count() > 128 {
            return Err(CliError::Usage(
                "--label must be between 1 and 128 characters".into(),
            ));
        }
        return Ok(label.to_string());
    }
    let prefixes = assignees
        .iter()
        .map(|assignee| format!("{}…", assignee.chars().take(8).collect::<String>()))
        .collect::<Vec<_>>();
    for included in (0..=prefixes.len()).rev() {
        let omitted = prefixes.len() - included;
        let mut generated = prefixes[..included].join(", ");
        if omitted > 0 {
            let suffix = format!("{omitted} other{}", if omitted == 1 { "" } else { "s" });
            if !generated.is_empty() {
                generated.push_str(", and ");
            }
            generated.push_str(&suffix);
        }
        if !generated.is_empty() && generated.chars().count() <= 128 {
            return Ok(generated);
        }
    }
    Err(CliError::Usage(
        "Unable to generate an assignee label between 1 and 128 characters".into(),
    ))
}

#[derive(Clone, Copy)]
enum IssueAssignmentOperation {
    Assign,
    Unassign,
}

impl IssueAssignmentOperation {
    fn content(self, label: &str) -> String {
        match self {
            Self::Assign => format!("Assigned this issue to {label}"),
            Self::Unassign => format!("Unassigned {label} from this issue"),
        }
    }
}

pub async fn cmd_create_issue(
    client: &BuzzClient,
    repo_owner: &str,
    repo_id: &str,
    subject: &str,
    content: &str,
    labels: &[String],
    to: &[String],
) -> Result<(), CliError> {
    validate_hex64(repo_owner)?;
    validate_repo_id(repo_id)?;
    let body = read_or_stdin(content)?;

    let meta = GitIssueMeta {
        labels: labels.to_vec(),
        recipients: to.to_vec(),
    };

    let repo = GitRepoCoord {
        owner: repo_owner.to_string(),
        id: repo_id.to_string(),
    };

    let builder = with_git_provenance(
        buzz_sdk::build_git_issue(&repo, subject, &body, &meta).map_err(sdk_err)?,
    )?;
    let event = client.sign_event(builder)?;
    let event_id = event.id.to_hex();
    let resp = client.submit_event(event).await?;
    // `link` renders as a rich preview card in Buzz Desktop when included in
    // a chat message — agents announce issues with it (see base_prompt.md).
    let link = crate::links::issue_link(&event_id, repo_owner, repo_id);
    crate::client::print_create_response(&resp, "link", &link);
    Ok(())
}

/// Publish an issue assignment: a kind:1 comment on the issue whose `p`
/// tags are the assignees, labeled `t: assignment` (same event shape the
/// Desktop app writes). Clients trust it when signed by the issue author
/// or repo owner, or when it is a self-assignment.
pub async fn cmd_assign_issue(
    client: &BuzzClient,
    issue: &str,
    repo_owner: &str,
    repo_id: &str,
    assignees: &[String],
    label: Option<&str>,
) -> Result<(), CliError> {
    publish_issue_assignment_operation(
        client,
        issue,
        repo_owner,
        repo_id,
        assignees,
        label,
        IssueAssignmentOperation::Assign,
    )
    .await
}

/// Publish an issue unassignment with the same trust rules as assignment.
pub async fn cmd_unassign_issue(
    client: &BuzzClient,
    issue: &str,
    repo_owner: &str,
    repo_id: &str,
    assignees: &[String],
    label: Option<&str>,
) -> Result<(), CliError> {
    publish_issue_assignment_operation(
        client,
        issue,
        repo_owner,
        repo_id,
        assignees,
        label,
        IssueAssignmentOperation::Unassign,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn publish_issue_assignment_operation(
    client: &BuzzClient,
    issue: &str,
    repo_owner: &str,
    repo_id: &str,
    assignees: &[String],
    label: Option<&str>,
    operation: IssueAssignmentOperation,
) -> Result<(), CliError> {
    validate_hex64(issue)?;
    validate_hex64(repo_owner)?;
    validate_repo_id(repo_id)?;
    for assignee in assignees {
        validate_hex64(assignee)?;
    }

    let label = assignment_note_label(assignees, label)?;
    let content = operation.content(&label);
    let created_at = next_issue_assignment_created_at(client, issue).await?;
    let repo = GitRepoCoord {
        owner: repo_owner.to_string(),
        id: repo_id.to_string(),
    };
    let builder = match operation {
        IssueAssignmentOperation::Assign => {
            buzz_sdk::build_git_issue_assignment(&repo, issue, assignees, &content)
        }
        IssueAssignmentOperation::Unassign => {
            buzz_sdk::build_git_issue_unassignment(&repo, issue, assignees, &content)
        }
    }
    .map(|builder| builder.custom_created_at(Timestamp::from_secs(created_at)));
    let event = client.sign_event(builder.map_err(sdk_err)?)?;
    let resp = client.submit_event(event).await?;
    println!("{resp}");
    Ok(())
}

async fn next_issue_assignment_created_at(
    client: &BuzzClient,
    issue: &str,
) -> Result<u64, CliError> {
    let signer = client.keys().public_key().to_hex();
    let filter = serde_json::json!({
        "kinds": [1],
        "#e": [issue],
        "authors": [signer],
        "limit": 500
    });
    let response = client.query(&filter).await?;
    let latest = serde_json::from_str::<Vec<serde_json::Value>>(&response)
        .map_err(|error| CliError::Other(format!("parse issue comments: {error}")))?
        .into_iter()
        .filter_map(|event| event.get("created_at").and_then(serde_json::Value::as_u64))
        .max()
        .unwrap_or(0);
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| CliError::Other(format!("read system clock: {error}")))?
        .as_secs()
        .max(latest.saturating_add(1)))
}

pub async fn cmd_get_issue(client: &BuzzClient, event: &str) -> Result<(), CliError> {
    validate_hex64(event)?;
    let filter = serde_json::json!({
        "kinds": [1621],
        "ids": [event]
    });
    let resp = client.query(&filter).await?;
    println!("{resp}");
    Ok(())
}

pub async fn cmd_list_issues(
    client: &BuzzClient,
    repo_owner: &str,
    repo_id: &str,
    author: Option<&str>,
    label: Option<&str>,
    limit: Option<u32>,
) -> Result<(), CliError> {
    validate_hex64(repo_owner)?;
    validate_repo_id(repo_id)?;

    let a_value = format!("30617:{repo_owner}:{repo_id}");
    let mut filter = serde_json::json!({
        "kinds": [1621],
        "#a": [a_value]
    });

    if let Some(pk) = author {
        validate_hex64(pk)?;
        filter["authors"] = serde_json::json!([pk]);
    }
    if let Some(l) = label {
        filter["#t"] = serde_json::json!([l]);
    }
    if let Some(n) = limit {
        filter["limit"] = serde_json::json!(n);
    }

    let resp = client.query(&filter).await?;
    println!("{resp}");
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn cmd_issue_status(
    client: &BuzzClient,
    issue: &str,
    status: &str,
    content: Option<&str>,
    repo_owner: Option<&str>,
    repo_id: Option<&str>,
    euc: Option<&str>,
    to: &[String],
) -> Result<(), CliError> {
    validate_hex64(issue)?;
    let status = crate::commands::patches::parse_status(status)?;
    let body = match content {
        Some(c) => read_or_stdin(c)?,
        None => String::new(),
    };

    let repo = match (repo_owner, repo_id) {
        (Some(owner), Some(id)) => {
            validate_hex64(owner)?;
            validate_repo_id(id)?;
            Some(GitRepoCoord {
                owner: owner.to_string(),
                id: id.to_string(),
            })
        }
        (None, None) => None,
        _ => {
            return Err(CliError::Usage(
                "--repo-owner and --repo-id must be given together".into(),
            ))
        }
    };

    // Mirrors `buzz patches status`: default a `p` tag to the repo owner
    // for discoverability, plus a `--to` escape hatch for the issue author
    // or anyone else who should be notified of the status change.
    let mut recipients = Vec::new();
    if let Some(ref repo) = repo {
        recipients.push(repo.owner.clone());
    }
    for recipient in to {
        validate_hex64(recipient)?;
        if !recipients.contains(recipient) {
            recipients.push(recipient.clone());
        }
    }

    let meta = GitStatusMeta {
        root_event: issue.to_string(),
        accepted_revision_root: None,
        repo,
        euc: euc.map(str::to_string),
        recipients,
        applied_patches: vec![],
        merge_commit: None,
        applied_as_commits: vec![],
    };

    let builder =
        with_git_provenance(buzz_sdk::build_git_status(status, &body, &meta).map_err(sdk_err)?)?;
    let event = client.sign_event(builder)?;
    let resp = client.submit_event(event).await?;
    println!("{resp}");
    Ok(())
}

pub async fn dispatch(cmd: crate::IssuesCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::IssuesCmd;
    match cmd {
        IssuesCmd::Create {
            repo_owner,
            repo_id,
            title,
            content,
            label,
            to,
        } => cmd_create_issue(client, &repo_owner, &repo_id, &title, &content, &label, &to).await,
        IssuesCmd::Get { event } => cmd_get_issue(client, &event).await,
        IssuesCmd::List {
            repo_owner,
            repo_id,
            author,
            label,
            limit,
        } => {
            cmd_list_issues(
                client,
                &repo_owner,
                &repo_id,
                author.as_deref(),
                label.as_deref(),
                limit,
            )
            .await
        }
        IssuesCmd::Status {
            issue,
            status,
            content,
            repo_owner,
            repo_id,
            euc,
            to,
        } => {
            cmd_issue_status(
                client,
                &issue,
                &status,
                content.as_deref(),
                repo_owner.as_deref(),
                repo_id.as_deref(),
                euc.as_deref(),
                &to,
            )
            .await
        }
        IssuesCmd::Assign {
            issue,
            repo_owner,
            repo_id,
            assignee,
            label,
        } => {
            cmd_assign_issue(
                client,
                &issue,
                &repo_owner,
                &repo_id,
                &assignee,
                label.as_deref(),
            )
            .await
        }
        IssuesCmd::Unassign {
            issue,
            repo_owner,
            repo_id,
            assignee,
            label,
        } => {
            cmd_unassign_issue(
                client,
                &issue,
                &repo_owner,
                &repo_id,
                &assignee,
                label.as_deref(),
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::assignment_note_label;

    #[test]
    fn assignment_note_label_enforces_desktop_length_limit() {
        let assignees = vec!["a".repeat(64)];
        assert_eq!(
            assignment_note_label(&assignees, Some(" Thomas ")).unwrap(),
            "Thomas"
        );
        assert!(assignment_note_label(&assignees, Some("")).is_err());
        assert!(assignment_note_label(&assignees, Some(&"x".repeat(129))).is_err());
        assert_eq!(
            assignment_note_label(&assignees, None).unwrap(),
            "aaaaaaaa…"
        );
        let many_assignees = (0..50)
            .map(|index| format!("{index:064x}"))
            .collect::<Vec<_>>();
        let generated = assignment_note_label(&many_assignees, None).unwrap();
        assert!(generated.chars().count() <= 128);
        assert!(generated.contains("others"));
    }
}
