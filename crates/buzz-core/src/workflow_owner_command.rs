//! Signed owner-command protocol for managed workflows.
//!
//! This module contains only the pure wire contract. Relay admission,
//! persistence, and agent execution are intentionally downstream consumers.

use nostr::{Event, EventId, PublicKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::kind::{KIND_WORKFLOW_DEF, KIND_WORKFLOW_OWNER_COMMAND, KIND_WORKFLOW_OWNER_RESULT};

/// Maximum UTF-8 byte length of a terminal result reason.
pub const WORKFLOW_OWNER_MAX_REASON_BYTES: usize = 4 * 1024;

/// Operation requested by a workflow owner.
///
/// These five operations deliberately share one command shape. In particular,
/// restore is not a relay-side special case: it is an ordinary command that
/// the downstream capability-gated lifecycle executor must execute.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowOwnerOperation {
    /// Start a workflow run.
    Start,
    /// Pause workflow execution.
    Pause,
    /// Resume paused workflow execution.
    Resume,
    /// Cancel workflow execution.
    Cancel,
    /// Restore a retired workflow.
    Restore,
}

impl WorkflowOwnerOperation {
    /// Return the canonical wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Pause => "pause",
            Self::Resume => "resume",
            Self::Cancel => "cancel",
            Self::Restore => "restore",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "start" => Some(Self::Start),
            "pause" => Some(Self::Pause),
            "resume" => Some(Self::Resume),
            "cancel" => Some(Self::Cancel),
            "restore" => Some(Self::Restore),
            _ => None,
        }
    }
}

/// Terminal status reported by an agent after executing an owner command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowOwnerResultStatus {
    /// The agent applied the requested operation.
    Applied,
    /// The agent rejected the operation without applying it.
    Rejected,
}

impl WorkflowOwnerResultStatus {
    /// Return the canonical wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::Rejected => "rejected",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "applied" => Some(Self::Applied),
            "rejected" => Some(Self::Rejected),
            _ => None,
        }
    }
}

/// Signed owner-command content.
///
/// All five lifecycle operations use this same body. Identity and replay
/// binding live in the signed tags, not in operation-specific cargo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowOwnerCommandBody {
    /// Requested operation.
    pub operation: WorkflowOwnerOperation,
}

/// Signed terminal-result content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowOwnerResultBody {
    /// Terminal result status.
    pub status: WorkflowOwnerResultStatus,
    /// Optional machine-readable or human-readable terminal context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Parsed owner-signed command identity and target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowOwnerCommand {
    /// Event ID of the signed request.
    pub event_id: EventId,
    /// Human owner that signed the request.
    pub owner_pubkey: PublicKey,
    /// Replay identity carried by the command `d` tag.
    pub command_id: Uuid,
    /// Immutable agent author of the target workflow coordinate.
    pub agent_pubkey: PublicKey,
    /// Workflow d-tag in the target coordinate.
    pub workflow_id: Uuid,
    /// Explicit command recipient; equal to the coordinate agent.
    pub recipient: PublicKey,
    /// Exact owner-signed kind-30620 revision being managed.
    pub expected_revision: EventId,
    /// Requested operation.
    pub operation: WorkflowOwnerOperation,
}

impl WorkflowOwnerCommand {
    /// Return the canonical parameterized workflow coordinate.
    pub fn workflow_coordinate(&self) -> String {
        format!(
            "{KIND_WORKFLOW_DEF}:{}:{}",
            self.agent_pubkey.to_hex(),
            self.workflow_id
        )
    }
}

/// Parsed agent-signed terminal-result identity and payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowOwnerResult {
    /// Event ID of the signed result.
    pub event_id: EventId,
    /// Agent that signed and executed the result.
    pub agent_pubkey: PublicKey,
    /// Human owner receiving the result.
    pub owner_pubkey: PublicKey,
    /// Replay identity copied from the command `d` tag.
    pub command_id: Uuid,
    /// Workflow agent author from the target coordinate.
    pub target_agent_pubkey: PublicKey,
    /// Workflow d-tag in the target coordinate.
    pub workflow_id: Uuid,
    /// Exact revision the command targeted.
    pub expected_revision: EventId,
    /// Operation executed by the agent.
    pub operation: WorkflowOwnerOperation,
    /// Terminal result status.
    pub status: WorkflowOwnerResultStatus,
    /// Optional terminal reason.
    pub reason: Option<String>,
}

/// Canonical failures while parsing owner-command protocol events.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum WorkflowOwnerError {
    /// Event kind did not match the requested protocol type.
    #[error("unexpected workflow owner event kind: {0}")]
    UnexpectedKind(u16),
    /// Nostr signature verification failed.
    #[error("invalid workflow owner event signature: {0}")]
    InvalidSignature(String),
    /// A required tag was missing.
    #[error("missing workflow owner {0} tag")]
    MissingTag(&'static str),
    /// A tag occurred more than once.
    #[error("duplicate workflow owner {0} tag")]
    DuplicateTag(&'static str),
    /// A tag did not have its canonical two-field shape.
    #[error("workflow owner {0} tag has a non-canonical shape")]
    InvalidTagShape(&'static str),
    /// An unrecognized tag was present.
    #[error("unexpected workflow owner tag: {0}")]
    UnexpectedTag(String),
    /// The replay identity was malformed or nil.
    #[error("invalid workflow owner command id")]
    InvalidCommandId,
    /// The workflow coordinate was malformed.
    #[error("invalid workflow owner workflow coordinate")]
    InvalidWorkflowCoordinate,
    /// The coordinate used a kind other than workflow definition kind 30620.
    #[error("workflow owner coordinate must target kind 30620")]
    WrongWorkflowKind,
    /// The coordinate agent pubkey was malformed.
    #[error("invalid workflow owner agent pubkey")]
    InvalidAgentPubkey,
    /// The coordinate workflow UUID was malformed or nil.
    #[error("invalid workflow owner workflow id")]
    InvalidWorkflowId,
    /// The exact definition event ID was malformed.
    #[error("invalid workflow owner expected revision")]
    InvalidExpectedRevision,
    /// A command recipient was malformed.
    #[error("invalid workflow owner command recipient")]
    InvalidRecipient,
    /// The explicit recipient did not equal the workflow coordinate agent.
    #[error("workflow owner command recipient must equal target agent")]
    RecipientMismatch,
    /// A result was not signed by the coordinate agent.
    #[error("workflow owner result signer must equal target agent")]
    ResultSignerMismatch,
    /// Signed JSON content could not be decoded.
    #[error("invalid workflow owner event content: {0}")]
    InvalidContent(String),
    /// A result reason exceeded the protocol limit.
    #[error("workflow owner result reason exceeds {WORKFLOW_OWNER_MAX_REASON_BYTES} bytes")]
    ReasonTooLarge,
    /// A result status in content and tag disagreed.
    #[error("workflow owner result status tag disagrees with content")]
    ResultStatusMismatch,
    /// An operation was malformed or unknown.
    #[error("invalid workflow owner operation")]
    InvalidOperation,
    /// A result status was malformed or unknown.
    #[error("invalid workflow owner result status")]
    InvalidStatus,
}

/// Parse and structurally validate an owner-signed command event.
pub fn parse_owner_command(event: &Event) -> Result<WorkflowOwnerCommand, WorkflowOwnerError> {
    if event.kind.as_u16() as u32 != KIND_WORKFLOW_OWNER_COMMAND {
        return Err(WorkflowOwnerError::UnexpectedKind(event.kind.as_u16()));
    }
    verify_signature(event)?;
    let tags = canonical_tags(event, &["d", "a", "revision", "p"])?;
    let command_id = parse_command_id(tag_value(&tags, "d")?)?;
    let (agent_pubkey, workflow_id) = parse_workflow_coordinate(tag_value(&tags, "a")?)?;
    let expected_revision = parse_event_id(tag_value(&tags, "revision")?)?;
    let recipient = PublicKey::from_hex(tag_value(&tags, "p")?)
        .map_err(|_| WorkflowOwnerError::InvalidRecipient)?;
    if recipient != agent_pubkey {
        return Err(WorkflowOwnerError::RecipientMismatch);
    }
    let body: WorkflowOwnerCommandBody = serde_json::from_str(&event.content)
        .map_err(|error| WorkflowOwnerError::InvalidContent(error.to_string()))?;
    Ok(WorkflowOwnerCommand {
        event_id: event.id,
        owner_pubkey: event.pubkey,
        command_id,
        agent_pubkey,
        workflow_id,
        recipient,
        expected_revision,
        operation: body.operation,
    })
}

/// Parse and structurally validate an agent-signed terminal result event.
pub fn parse_owner_result(event: &Event) -> Result<WorkflowOwnerResult, WorkflowOwnerError> {
    if event.kind.as_u16() as u32 != KIND_WORKFLOW_OWNER_RESULT {
        return Err(WorkflowOwnerError::UnexpectedKind(event.kind.as_u16()));
    }
    verify_signature(event)?;
    let tags = canonical_tags(event, &["d", "a", "revision", "p", "operation", "status"])?;
    let command_id = parse_command_id(tag_value(&tags, "d")?)?;
    let (target_agent_pubkey, workflow_id) = parse_workflow_coordinate(tag_value(&tags, "a")?)?;
    if event.pubkey != target_agent_pubkey {
        return Err(WorkflowOwnerError::ResultSignerMismatch);
    }
    let owner_pubkey = PublicKey::from_hex(tag_value(&tags, "p")?)
        .map_err(|_| WorkflowOwnerError::InvalidRecipient)?;
    let expected_revision = parse_event_id(tag_value(&tags, "revision")?)?;
    let operation = WorkflowOwnerOperation::parse(tag_value(&tags, "operation")?)
        .ok_or(WorkflowOwnerError::InvalidOperation)?;
    let status_tag = WorkflowOwnerResultStatus::parse(tag_value(&tags, "status")?)
        .ok_or(WorkflowOwnerError::InvalidStatus)?;
    let body: WorkflowOwnerResultBody = serde_json::from_str(&event.content)
        .map_err(|error| WorkflowOwnerError::InvalidContent(error.to_string()))?;
    if body.status != status_tag {
        return Err(WorkflowOwnerError::ResultStatusMismatch);
    }
    if body
        .reason
        .as_deref()
        .is_some_and(|reason| reason.len() > WORKFLOW_OWNER_MAX_REASON_BYTES)
    {
        return Err(WorkflowOwnerError::ReasonTooLarge);
    }
    Ok(WorkflowOwnerResult {
        event_id: event.id,
        agent_pubkey: event.pubkey,
        owner_pubkey,
        command_id,
        target_agent_pubkey,
        workflow_id,
        expected_revision,
        operation,
        status: status_tag,
        reason: body.reason,
    })
}

fn verify_signature(event: &Event) -> Result<(), WorkflowOwnerError> {
    event
        .verify()
        .map_err(|error| WorkflowOwnerError::InvalidSignature(error.to_string()))
}

fn canonical_tags<'a>(
    event: &'a Event,
    allowed: &[&'static str],
) -> Result<Vec<(&'static str, &'a [String])>, WorkflowOwnerError> {
    let mut found = Vec::with_capacity(allowed.len());
    for tag in event.tags.iter() {
        let values = tag.as_slice();
        let name = values
            .first()
            .map(String::as_str)
            .ok_or_else(|| WorkflowOwnerError::UnexpectedTag(String::new()))?;
        let Some(&canonical_name) = allowed.iter().find(|candidate| **candidate == name) else {
            return Err(WorkflowOwnerError::UnexpectedTag(name.to_owned()));
        };
        if found
            .iter()
            .any(|(candidate, _)| *candidate == canonical_name)
        {
            return Err(WorkflowOwnerError::DuplicateTag(canonical_name));
        }
        if values.len() != 2 {
            return Err(WorkflowOwnerError::InvalidTagShape(canonical_name));
        }
        found.push((canonical_name, values));
    }
    for &name in allowed {
        if !found.iter().any(|(candidate, _)| *candidate == name) {
            return Err(WorkflowOwnerError::MissingTag(name));
        }
    }
    Ok(found)
}

fn tag_value<'a>(
    tags: &[(&'static str, &'a [String])],
    name: &'static str,
) -> Result<&'a str, WorkflowOwnerError> {
    tags.iter()
        .find(|(candidate, _)| *candidate == name)
        .map(|(_, values)| values[1].as_str())
        .ok_or(WorkflowOwnerError::MissingTag(name))
}

fn parse_command_id(value: &str) -> Result<Uuid, WorkflowOwnerError> {
    let id = Uuid::parse_str(value).map_err(|_| WorkflowOwnerError::InvalidCommandId)?;
    if id.is_nil() {
        return Err(WorkflowOwnerError::InvalidCommandId);
    }
    Ok(id)
}

fn parse_workflow_coordinate(value: &str) -> Result<(PublicKey, Uuid), WorkflowOwnerError> {
    let mut parts = value.split(':');
    let kind = parts
        .next()
        .and_then(|part| part.parse::<u32>().ok())
        .ok_or(WorkflowOwnerError::InvalidWorkflowCoordinate)?;
    if kind != KIND_WORKFLOW_DEF {
        return Err(WorkflowOwnerError::WrongWorkflowKind);
    }
    let agent = PublicKey::from_hex(parts.next().unwrap_or_default())
        .map_err(|_| WorkflowOwnerError::InvalidAgentPubkey)?;
    let workflow_id = Uuid::parse_str(parts.next().unwrap_or_default())
        .map_err(|_| WorkflowOwnerError::InvalidWorkflowId)?;
    if workflow_id.is_nil() || parts.next().is_some() {
        return Err(WorkflowOwnerError::InvalidWorkflowId);
    }
    Ok((agent, workflow_id))
}

fn parse_event_id(value: &str) -> Result<EventId, WorkflowOwnerError> {
    EventId::from_hex(value).map_err(|_| WorkflowOwnerError::InvalidExpectedRevision)
}

#[cfg(test)]
mod tests {
    use nostr::{EventBuilder, Keys, Kind, Tag};

    use super::*;

    fn command(owner: &Keys, agent: &Keys, operation: WorkflowOwnerOperation) -> Event {
        let command_id = Uuid::new_v4();
        let workflow_id = Uuid::new_v4();
        let revision = EventId::from_hex(&"11".repeat(32)).unwrap();
        let body = WorkflowOwnerCommandBody { operation };
        EventBuilder::new(
            Kind::Custom(KIND_WORKFLOW_OWNER_COMMAND as u16),
            serde_json::to_string(&body).unwrap(),
        )
        .tags([
            Tag::parse(["d", &command_id.to_string()]).unwrap(),
            Tag::parse([
                "a",
                &format!(
                    "{KIND_WORKFLOW_DEF}:{}:{workflow_id}",
                    agent.public_key().to_hex()
                ),
            ])
            .unwrap(),
            Tag::parse(["revision", &revision.to_hex()]).unwrap(),
            Tag::parse(["p", &agent.public_key().to_hex()]).unwrap(),
        ])
        .sign_with_keys(owner)
        .unwrap()
    }

    #[test]
    fn every_operation_has_the_same_command_identity_and_body_shape() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        for operation in [
            WorkflowOwnerOperation::Start,
            WorkflowOwnerOperation::Pause,
            WorkflowOwnerOperation::Resume,
            WorkflowOwnerOperation::Cancel,
            WorkflowOwnerOperation::Restore,
        ] {
            let event = command(&owner, &agent, operation);
            let parsed = parse_owner_command(&event).unwrap();
            assert_eq!(parsed.operation, operation);
            assert_eq!(parsed.owner_pubkey, owner.public_key());
            assert_eq!(parsed.agent_pubkey, agent.public_key());
            assert_eq!(parsed.recipient, agent.public_key());
            assert_eq!(event.tags.len(), 4);
        }
    }

    #[test]
    fn rejects_unknown_or_duplicate_tags_and_recipient_mismatch() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let other = Keys::generate();
        let event = command(&owner, &agent, WorkflowOwnerOperation::Start);
        let mut tags = event.tags.to_vec();
        tags.push(Tag::parse(["d", &Uuid::new_v4().to_string()]).unwrap());
        let event = EventBuilder::new(event.kind, event.content)
            .tags(tags)
            .sign_with_keys(&owner)
            .unwrap();
        assert_eq!(
            parse_owner_command(&event),
            Err(WorkflowOwnerError::DuplicateTag("d"))
        );

        let event = command(&owner, &agent, WorkflowOwnerOperation::Pause);
        let mut tags = event.tags.to_vec();
        tags.pop();
        tags.push(Tag::parse(["p", &other.public_key().to_hex()]).unwrap());
        let event = EventBuilder::new(event.kind, event.content)
            .tags(tags)
            .sign_with_keys(&owner)
            .unwrap();
        assert_eq!(
            parse_owner_command(&event),
            Err(WorkflowOwnerError::RecipientMismatch)
        );

        let event = command(&owner, &agent, WorkflowOwnerOperation::Resume);
        let mut tags = event.tags.to_vec();
        tags.push(Tag::parse(["private", "leak"]).unwrap());
        let event = EventBuilder::new(event.kind, event.content)
            .tags(tags)
            .sign_with_keys(&owner)
            .unwrap();
        assert_eq!(
            parse_owner_command(&event),
            Err(WorkflowOwnerError::UnexpectedTag("private".into()))
        );
    }

    #[test]
    fn result_requires_agent_signature_and_matching_status() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let command_event = command(&owner, &agent, WorkflowOwnerOperation::Restore);
        let command = parse_owner_command(&command_event).unwrap();
        let body = WorkflowOwnerResultBody {
            status: WorkflowOwnerResultStatus::Applied,
            reason: None,
        };
        let event = EventBuilder::new(
            Kind::Custom(KIND_WORKFLOW_OWNER_RESULT as u16),
            serde_json::to_string(&body).unwrap(),
        )
        .tags([
            Tag::parse(["d", &command.command_id.to_string()]).unwrap(),
            Tag::parse(["a", &command.workflow_coordinate()]).unwrap(),
            Tag::parse(["revision", &command.expected_revision.to_hex()]).unwrap(),
            Tag::parse(["p", &command.owner_pubkey.to_hex()]).unwrap(),
            Tag::parse(["operation", command.operation.as_str()]).unwrap(),
            Tag::parse(["status", "applied"]).unwrap(),
        ])
        .sign_with_keys(&agent)
        .unwrap();
        let result = parse_owner_result(&event).unwrap();
        assert_eq!(result.agent_pubkey, agent.public_key());
        assert_eq!(result.owner_pubkey, owner.public_key());
        assert_eq!(result.operation, WorkflowOwnerOperation::Restore);

        let mut tags = event.tags.to_vec();
        tags[5] = Tag::parse(["status", "rejected"]).unwrap();
        let event = EventBuilder::new(event.kind, event.content)
            .tags(tags)
            .sign_with_keys(&agent)
            .unwrap();
        assert_eq!(
            parse_owner_result(&event),
            Err(WorkflowOwnerError::ResultStatusMismatch)
        );
    }

    #[test]
    fn rejects_unknown_operation_and_unknown_body_fields() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let event = command(&owner, &agent, WorkflowOwnerOperation::Cancel);
        let event = EventBuilder::new(event.kind, r#"{"operation":"update"}"#)
            .tags(event.tags)
            .sign_with_keys(&owner)
            .unwrap();
        assert_eq!(
            parse_owner_command(&event),
            Err(WorkflowOwnerError::InvalidContent(
                "unknown variant `update`, expected one of `start`, `pause`, `resume`, `cancel`, `restore`".into()
            ))
        );

        let event = command(&owner, &agent, WorkflowOwnerOperation::Start);
        let event = EventBuilder::new(
            event.kind,
            r#"{"operation":"start","yaml_definition":"no"}"#,
        )
        .tags(event.tags)
        .sign_with_keys(&owner)
        .unwrap();
        assert!(matches!(
            parse_owner_command(&event),
            Err(WorkflowOwnerError::InvalidContent(_))
        ));
    }
}
