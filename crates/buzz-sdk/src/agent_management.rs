//! Agent-initiated agent management: the request/result contract an owned
//! agent uses to create, update, or delete agents through its owner's client.
//!
//! # Why this goes through the owner
//!
//! Personas (kind:30175) and managed agents (kind:30177) are addressed by the
//! **owner** pubkey, and a runnable agent needs key material that only the
//! owner's client can mint. An agent therefore cannot write those coordinates
//! itself; it asks the owner's client to do it. The transport is the encrypted
//! observer channel (kind 24200, `docs/nips/NIP-AM.md`): the relay already
//! authenticates that the frame's agent is owned by its `p`-tagged owner, and
//! the payload is NIP-44 encrypted so only the owner can read it.
//!
//! ```text
//! agent  --telemetry frame: agent_management_request-->  owner's client
//! agent  <--control frame:  agent_management_result----  owner's client
//! ```
//!
//! The owner's client decides whether to execute immediately (owner opted in
//! to unattended agent management) or to open a review dialog; either way it
//! answers with a result frame keyed by `request_id`.
//!
//! This module owns the wire shapes, their validation, and the frame builders
//! so the CLI (requester) and Buzz Desktop (executor) share one contract.

use buzz_core::observer::{
    encrypt_observer_payload, OBSERVER_FRAME_CONTROL, OBSERVER_FRAME_TELEMETRY,
};
use nostr::{EventBuilder, Keys, PublicKey};
use serde::{Deserialize, Serialize};

use crate::builders::build_agent_observer_frame;
use crate::SdkError;

/// Observer payload `kind`/`type` of an agent → owner management request.
pub const AGENT_MANAGEMENT_REQUEST: &str = "agent_management_request";
/// Observer control payload `type` of an owner → agent management result.
pub const AGENT_MANAGEMENT_RESULT: &str = "agent_management_result";

/// Maximum characters in an agent display name.
pub const MAX_AGENT_NAME_CHARS: usize = 120;
/// Maximum characters in a system prompt.
pub const MAX_SYSTEM_PROMPT_CHARS: usize = 20_000;
/// Maximum characters in a short free-form field (runtime, provider, model…).
pub const MAX_SHORT_FIELD_CHARS: usize = 300;
/// Maximum characters in an avatar URL carried by a request.
pub const MAX_AVATAR_URL_CHARS: usize = 2_048;
/// Upper bound on requested concurrent turns (matches Buzz Desktop's mint gate).
pub const MAX_PARALLELISM: u32 = 32;

/// Who a requested agent should answer. Only the two non-allowlist modes are
/// expressible here — an allowlist needs pubkeys the requester cannot vouch for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RespondToRequest {
    /// Answer only the owner.
    OwnerOnly,
    /// Answer anyone in the channel.
    Anyone,
}

impl RespondToRequest {
    /// Wire string, matching `buzz-acp --respond-to`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OwnerOnly => "owner-only",
            Self::Anyone => "anyone",
        }
    }

    /// Parse the wire string.
    pub fn parse(value: &str) -> Result<Self, SdkError> {
        match value {
            "owner-only" => Ok(Self::OwnerOnly),
            "anyone" => Ok(Self::Anyone),
            other => Err(SdkError::InvalidInput(format!(
                "respond-to must be owner-only or anyone (got {other:?})"
            ))),
        }
    }
}

/// Create a persona + runnable instance and add it to `channel_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentRequest {
    /// Channel the requesting agent is acting from; the new agent joins it.
    pub channel_id: String,
    /// Display name of the new agent.
    pub display_name: String,
    /// Instructions for the new agent.
    pub system_prompt: String,
    /// Preferred runtime id (e.g. `goose`, `claude`); owner default when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    /// Inference provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Model identifier, interpreted by the runtime.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Inbound author gate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub respond_to: Option<RespondToRequest>,
    /// Concurrent turn limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parallelism: Option<u32>,
    /// Avatar URL (https or a small data URL).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    /// Start the instance after creating it. Absent means `true`; `false`
    /// creates the definition only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<bool>,
}

/// Identify the agent a request targets. Exactly one of the two is set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTarget {
    /// Target by the agent's pubkey (hex); unambiguous.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_pubkey: Option<String>,
    /// Target by the agent's current display name; the executor refuses an
    /// ambiguous name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
}

/// Change an existing agent's definition. Absent fields are left alone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAgentRequest {
    /// Channel the requesting agent is acting from.
    pub channel_id: String,
    /// Which agent to change.
    #[serde(flatten)]
    pub target: AgentTarget,
    /// New display name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Replacement instructions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    /// New runtime id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    /// New provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// New model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// New inbound author gate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub respond_to: Option<RespondToRequest>,
}

impl UpdateAgentRequest {
    /// True when the request changes nothing.
    pub fn is_empty(&self) -> bool {
        self.display_name.is_none()
            && self.system_prompt.is_none()
            && self.runtime.is_none()
            && self.provider.is_none()
            && self.model.is_none()
            && self.respond_to.is_none()
    }
}

/// Remove an agent (its instance and, when nothing else uses it, its persona).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAgentRequest {
    /// Channel the requesting agent is acting from.
    pub channel_id: String,
    /// Which agent to remove.
    #[serde(flatten)]
    pub target: AgentTarget,
}

/// The operation an agent asks its owner's client to perform.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", content = "request", rename_all = "camelCase")]
pub enum AgentManagementAction {
    /// Create a new agent.
    Create(CreateAgentRequest),
    /// Change an existing agent.
    Update(UpdateAgentRequest),
    /// Remove an existing agent.
    Delete(DeleteAgentRequest),
}

impl AgentManagementAction {
    /// Wire name of the action.
    pub fn name(&self) -> &'static str {
        match self {
            Self::Create(_) => "create",
            Self::Update(_) => "update",
            Self::Delete(_) => "delete",
        }
    }

    /// Channel the request was issued from.
    pub fn channel_id(&self) -> &str {
        match self {
            Self::Create(r) => &r.channel_id,
            Self::Update(r) => &r.channel_id,
            Self::Delete(r) => &r.channel_id,
        }
    }
}

/// The observer payload body of a management request.
///
/// Serializes as `{"type": "agent_management_request", "action": …,
/// "requestId": …, "request": {…}}` — the shape Buzz Desktop's
/// `parseAgentManagementRequest` reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentManagementRequest {
    /// Always [`AGENT_MANAGEMENT_REQUEST`].
    #[serde(rename = "type")]
    pub request_type: String,
    /// Correlates the result frame with this request.
    pub request_id: String,
    /// `true` asks the owner's client to open its review dialog even when the
    /// owner has enabled unattended agent management (`buzz agents draft-*`).
    /// Absent/`false` lets the owner's setting decide.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<bool>,
    /// What to do.
    #[serde(flatten)]
    pub action: AgentManagementAction,
}

impl AgentManagementRequest {
    /// Wrap a validated action with a fresh request id.
    pub fn new(action: AgentManagementAction) -> Result<Self, SdkError> {
        validate_action(&action)?;
        Ok(Self {
            request_type: AGENT_MANAGEMENT_REQUEST.into(),
            request_id: uuid::Uuid::new_v4().to_string(),
            review: None,
            action,
        })
    }

    /// Force owner review for this request.
    pub fn with_review(mut self) -> Self {
        self.review = Some(true);
        self
    }

    /// True when the requester asked for owner review regardless of settings.
    pub fn wants_review(&self) -> bool {
        self.review == Some(true)
    }
}

/// Outcome of a management request, as reported by the owner's client.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentManagementStatus {
    /// The change was applied.
    Executed,
    /// The owner's client opened a review dialog; nothing has changed yet.
    PendingOwnerReview,
    /// The owner closed the review without saving.
    Dismissed,
    /// The request was refused (origin gate, unknown or ambiguous target…).
    Rejected,
    /// The client tried and failed; `error` says why.
    Failed,
}

impl AgentManagementStatus {
    /// Wire string (`executed`, `pending_owner_review`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Executed => "executed",
            Self::PendingOwnerReview => "pending_owner_review",
            Self::Dismissed => "dismissed",
            Self::Rejected => "rejected",
            Self::Failed => "failed",
        }
    }
}

/// The control payload an owner's client sends back to the requesting agent.
///
/// Serializes as `{"type": "agent_management_result", "requestId": …,
/// "action": …, "status": …, …}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentManagementResult {
    /// Always [`AGENT_MANAGEMENT_RESULT`].
    #[serde(rename = "type")]
    pub result_type: String,
    /// The `request_id` this answers.
    pub request_id: String,
    /// The action that was requested.
    pub action: String,
    /// What happened.
    pub status: AgentManagementStatus,
    /// Pubkey of the agent created/updated/deleted, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_pubkey: Option<String>,
    /// Display name of the agent, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    /// Persona id behind the agent, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persona_id: Option<String>,
    /// Human-readable failure/rejection reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl AgentManagementResult {
    /// A result with no agent details attached.
    pub fn new(request_id: &str, action: &str, status: AgentManagementStatus) -> Self {
        Self {
            result_type: AGENT_MANAGEMENT_RESULT.into(),
            request_id: request_id.to_owned(),
            action: action.to_owned(),
            status,
            agent_pubkey: None,
            agent_name: None,
            persona_id: None,
            error: None,
        }
    }
}

/// Observer telemetry envelope (`NIP-AM` `ObserverEvent`) carrying a request.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObserverEnvelope<'a> {
    seq: u64,
    timestamp: String,
    kind: &'static str,
    agent_index: Option<usize>,
    channel_id: Option<&'a str>,
    session_id: Option<String>,
    turn_id: Option<String>,
    payload: &'a AgentManagementRequest,
}

/// Build the kind 24200 telemetry frame an agent publishes to ask its owner
/// to perform `request`. Encrypted to `owner`; signed by the caller with
/// `agent_keys` (the same keys used for encryption).
pub fn build_agent_management_request_frame(
    agent_keys: &Keys,
    owner: &PublicKey,
    request: &AgentManagementRequest,
) -> Result<EventBuilder, SdkError> {
    validate_action(&request.action)?;
    let envelope = ObserverEnvelope {
        seq: 0,
        timestamp: chrono::Utc::now().to_rfc3339(),
        kind: AGENT_MANAGEMENT_REQUEST,
        agent_index: None,
        channel_id: Some(request.action.channel_id()),
        session_id: None,
        turn_id: None,
        payload: request,
    };
    let encrypted = encrypt_observer_payload(agent_keys, owner, &envelope).map_err(|e| {
        SdkError::InvalidInput(format!("could not encrypt agent management request: {e}"))
    })?;
    build_agent_observer_frame(
        &owner.to_hex(),
        &agent_keys.public_key().to_hex(),
        OBSERVER_FRAME_TELEMETRY,
        &encrypted,
    )
}

/// Build the kind 24200 control frame an owner's client publishes to report
/// `result` to the requesting agent. Encrypted to `agent`; signed by the
/// caller with `owner_keys`.
pub fn build_agent_management_result_frame(
    owner_keys: &Keys,
    agent: &PublicKey,
    result: &AgentManagementResult,
) -> Result<EventBuilder, SdkError> {
    let encrypted = encrypt_observer_payload(owner_keys, agent, result).map_err(|e| {
        SdkError::InvalidInput(format!("could not encrypt agent management result: {e}"))
    })?;
    let agent_hex = agent.to_hex();
    build_agent_observer_frame(&agent_hex, &agent_hex, OBSERVER_FRAME_CONTROL, &encrypted)
}

/// Read a decrypted control payload as a management result, if it is one.
pub fn parse_agent_management_result(payload: &serde_json::Value) -> Option<AgentManagementResult> {
    if payload.get("type").and_then(|v| v.as_str()) != Some(AGENT_MANAGEMENT_RESULT) {
        return None;
    }
    serde_json::from_value(payload.clone()).ok()
}

fn validate_action(action: &AgentManagementAction) -> Result<(), SdkError> {
    check_channel(action.channel_id())?;
    match action {
        AgentManagementAction::Create(r) => {
            check_text(&r.display_name, "display name", MAX_AGENT_NAME_CHARS, true)?;
            check_text(
                &r.system_prompt,
                "system prompt",
                MAX_SYSTEM_PROMPT_CHARS,
                true,
            )?;
            check_opt(&r.runtime, "runtime", MAX_SHORT_FIELD_CHARS)?;
            check_opt(&r.provider, "provider", MAX_SHORT_FIELD_CHARS)?;
            check_opt(&r.model, "model", MAX_SHORT_FIELD_CHARS)?;
            check_opt(&r.avatar_url, "avatar URL", MAX_AVATAR_URL_CHARS)?;
            if let Some(p) = r.parallelism {
                if p == 0 || p > MAX_PARALLELISM {
                    return Err(SdkError::InvalidInput(format!(
                        "parallelism must be between 1 and {MAX_PARALLELISM}"
                    )));
                }
            }
        }
        AgentManagementAction::Update(r) => {
            check_target(&r.target)?;
            check_opt(&r.display_name, "display name", MAX_AGENT_NAME_CHARS)?;
            check_opt(&r.system_prompt, "system prompt", MAX_SYSTEM_PROMPT_CHARS)?;
            check_opt(&r.runtime, "runtime", MAX_SHORT_FIELD_CHARS)?;
            check_opt(&r.provider, "provider", MAX_SHORT_FIELD_CHARS)?;
            check_opt(&r.model, "model", MAX_SHORT_FIELD_CHARS)?;
            if r.is_empty() {
                return Err(SdkError::InvalidInput(
                    "include at least one field to update".into(),
                ));
            }
        }
        AgentManagementAction::Delete(r) => check_target(&r.target)?,
    }
    Ok(())
}

fn check_channel(channel_id: &str) -> Result<(), SdkError> {
    uuid::Uuid::parse_str(channel_id)
        .map(|_| ())
        .map_err(|_| SdkError::InvalidInput(format!("invalid channel UUID: {channel_id}")))
}

fn check_target(target: &AgentTarget) -> Result<(), SdkError> {
    match (&target.agent_pubkey, &target.agent_name) {
        (Some(pubkey), None) => {
            if pubkey.len() != 64 || !pubkey.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(SdkError::InvalidInput(
                    "agent pubkey must be 64 hex characters".into(),
                ));
            }
            Ok(())
        }
        (None, Some(name)) => check_text(name, "agent name", MAX_AGENT_NAME_CHARS, true),
        (Some(_), Some(_)) => Err(SdkError::InvalidInput(
            "target the agent by pubkey or by name, not both".into(),
        )),
        (None, None) => Err(SdkError::InvalidInput(
            "target the agent by pubkey or by name".into(),
        )),
    }
}

fn check_text(value: &str, label: &str, max: usize, required: bool) -> Result<(), SdkError> {
    let trimmed = value.trim();
    if required && trimmed.is_empty() {
        return Err(SdkError::InvalidInput(format!("{label} is required")));
    }
    if trimmed != value {
        return Err(SdkError::InvalidInput(format!(
            "{label} must not have leading or trailing whitespace"
        )));
    }
    if value.chars().count() > max {
        return Err(SdkError::InvalidInput(format!(
            "{label} is too long (max {max} characters)"
        )));
    }
    Ok(())
}

fn check_opt(value: &Option<String>, label: &str, max: usize) -> Result<(), SdkError> {
    match value {
        Some(v) => check_text(v, label, max, true),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::observer::{decrypt_observer_payload, OBSERVER_AGENT_TAG, OBSERVER_FRAME_TAG};

    const CHANNEL: &str = "7c07e659-3610-42f4-9a5e-1e9973c09da9";

    fn create() -> CreateAgentRequest {
        CreateAgentRequest {
            channel_id: CHANNEL.into(),
            display_name: "Research helper".into(),
            system_prompt: "Find sources.".into(),
            runtime: None,
            provider: None,
            model: None,
            respond_to: None,
            parallelism: None,
            avatar_url: None,
            start: None,
        }
    }

    fn tags(event: &nostr::Event) -> Vec<Vec<String>> {
        event.tags.iter().map(|t| t.as_slice().to_vec()).collect()
    }

    #[test]
    fn request_serializes_to_the_desktop_contract() {
        let request = AgentManagementRequest::new(AgentManagementAction::Create(create())).unwrap();
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["type"], AGENT_MANAGEMENT_REQUEST);
        assert_eq!(json["action"], "create");
        assert_eq!(json["requestId"], request.request_id);
        assert_eq!(json["request"]["channelId"], CHANNEL);
        assert_eq!(json["request"]["displayName"], "Research helper");
        // Optional fields stay off the wire so strict readers keep accepting.
        assert!(json["request"].get("runtime").is_none());
        assert!(json["request"].get("start").is_none());
        assert!(json.get("review").is_none());

        let reviewed = AgentManagementRequest::new(AgentManagementAction::Create(create()))
            .unwrap()
            .with_review();
        assert!(reviewed.wants_review());
        assert_eq!(serde_json::to_value(&reviewed).unwrap()["review"], true);
    }

    #[test]
    fn update_and_delete_flatten_the_target() {
        let update =
            AgentManagementRequest::new(AgentManagementAction::Update(UpdateAgentRequest {
                channel_id: CHANNEL.into(),
                target: AgentTarget {
                    agent_pubkey: None,
                    agent_name: Some("Scout".into()),
                },
                display_name: None,
                system_prompt: Some("New prompt".into()),
                runtime: None,
                provider: None,
                model: None,
                respond_to: Some(RespondToRequest::Anyone),
            }))
            .unwrap();
        let json = serde_json::to_value(&update).unwrap();
        assert_eq!(json["action"], "update");
        assert_eq!(json["request"]["agentName"], "Scout");
        assert_eq!(json["request"]["respondTo"], "anyone");
        assert!(json["request"].get("agentPubkey").is_none());

        let pubkey = "a".repeat(64);
        let delete =
            AgentManagementRequest::new(AgentManagementAction::Delete(DeleteAgentRequest {
                channel_id: CHANNEL.into(),
                target: AgentTarget {
                    agent_pubkey: Some(pubkey.clone()),
                    agent_name: None,
                },
            }))
            .unwrap();
        let json = serde_json::to_value(&delete).unwrap();
        assert_eq!(json["action"], "delete");
        assert_eq!(json["request"]["agentPubkey"], pubkey);

        let back: AgentManagementRequest = serde_json::from_value(json).unwrap();
        assert_eq!(back, delete);
    }

    #[test]
    fn request_frame_is_owner_encrypted_telemetry() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let request = AgentManagementRequest::new(AgentManagementAction::Create(create())).unwrap();
        let event = build_agent_management_request_frame(&agent, &owner.public_key(), &request)
            .unwrap()
            .sign_with_keys(&agent)
            .unwrap();

        assert_eq!(event.kind.as_u16(), 24_200);
        let tags = tags(&event);
        assert!(tags.contains(&vec!["p".into(), owner.public_key().to_hex()]));
        assert!(tags.contains(&vec![
            OBSERVER_AGENT_TAG.into(),
            agent.public_key().to_hex()
        ]));
        assert!(tags.contains(&vec![
            OBSERVER_FRAME_TAG.into(),
            OBSERVER_FRAME_TELEMETRY.into()
        ]));

        let payload: serde_json::Value = decrypt_observer_payload(&owner, &event).unwrap();
        assert_eq!(payload["kind"], AGENT_MANAGEMENT_REQUEST);
        assert_eq!(payload["channelId"], CHANNEL);
        assert_eq!(payload["payload"]["type"], AGENT_MANAGEMENT_REQUEST);
        assert_eq!(payload["payload"]["action"], "create");
        assert_eq!(payload["payload"]["requestId"], request.request_id);
    }

    #[test]
    fn result_frame_is_agent_encrypted_control_and_round_trips() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let mut result =
            AgentManagementResult::new("req-1", "create", AgentManagementStatus::Executed);
        result.agent_pubkey = Some(agent.public_key().to_hex());
        let event = build_agent_management_result_frame(&owner, &agent.public_key(), &result)
            .unwrap()
            .sign_with_keys(&owner)
            .unwrap();

        let tags = tags(&event);
        assert!(tags.contains(&vec!["p".into(), agent.public_key().to_hex()]));
        assert!(tags.contains(&vec![
            OBSERVER_FRAME_TAG.into(),
            OBSERVER_FRAME_CONTROL.into()
        ]));

        let payload: serde_json::Value = decrypt_observer_payload(&agent, &event).unwrap();
        assert_eq!(payload["type"], AGENT_MANAGEMENT_RESULT);
        assert_eq!(payload["status"], "executed");
        assert_eq!(parse_agent_management_result(&payload).unwrap(), result);
        assert!(
            parse_agent_management_result(&serde_json::json!({"type": "cancel_turn"})).is_none()
        );
    }

    #[test]
    fn validation_rejects_bad_input() {
        let mut bad_channel = create();
        bad_channel.channel_id = "general".into();
        let err =
            AgentManagementRequest::new(AgentManagementAction::Create(bad_channel)).unwrap_err();
        assert!(err.to_string().contains("invalid channel UUID"));

        let mut parallel = create();
        parallel.parallelism = Some(0);
        assert!(AgentManagementRequest::new(AgentManagementAction::Create(parallel)).is_err());

        let empty_update = AgentManagementAction::Update(UpdateAgentRequest {
            channel_id: CHANNEL.into(),
            target: AgentTarget {
                agent_pubkey: None,
                agent_name: Some("Scout".into()),
            },
            display_name: None,
            system_prompt: None,
            runtime: None,
            provider: None,
            model: None,
            respond_to: None,
        });
        let err = AgentManagementRequest::new(empty_update).unwrap_err();
        assert!(err.to_string().contains("at least one field"));

        let both = AgentManagementAction::Delete(DeleteAgentRequest {
            channel_id: CHANNEL.into(),
            target: AgentTarget {
                agent_pubkey: Some("b".repeat(64)),
                agent_name: Some("Scout".into()),
            },
        });
        assert!(AgentManagementRequest::new(both)
            .unwrap_err()
            .to_string()
            .contains("not both"));

        let neither = AgentManagementAction::Delete(DeleteAgentRequest {
            channel_id: CHANNEL.into(),
            target: AgentTarget {
                agent_pubkey: None,
                agent_name: None,
            },
        });
        assert!(AgentManagementRequest::new(neither).is_err());

        assert!(RespondToRequest::parse("allowlist").is_err());
        assert_eq!(
            RespondToRequest::parse("anyone").unwrap(),
            RespondToRequest::Anyone
        );
    }
}
