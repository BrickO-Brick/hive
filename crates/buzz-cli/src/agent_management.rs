//! `buzz agents create|update|delete` transport: publish an agent-management
//! request to the owner's Buzz Desktop and, optionally, wait for its result.
//!
//! The wire contract lives in [`buzz_sdk::agent_management`]; this module only
//! adds the CLI's relay plumbing — one authenticated WebSocket that publishes
//! the telemetry frame and then listens for the matching control frame.

use std::time::Duration;

use buzz_core::kind::KIND_AGENT_OBSERVER_FRAME;
use buzz_core::observer::decrypt_observer_payload;
use buzz_sdk::agent_management::{
    build_agent_management_request_frame, parse_agent_management_result, AgentManagementRequest,
    AgentManagementResult, AgentManagementStatus,
};
use buzz_ws_client::{NostrWsConnection, RelayMessage};
use nostr::{Event, Keys, PublicKey, Tag};

use crate::error::CliError;

/// Default seconds to wait for the owner's Desktop to answer a request.
pub const DEFAULT_WAIT_SECS: u64 = 60;

/// Sign a management request frame addressed to `owner`.
pub fn sign_request(
    keys: &Keys,
    owner: &PublicKey,
    request: &AgentManagementRequest,
) -> Result<Event, CliError> {
    build_agent_management_request_frame(keys, owner, request)
        .map_err(|e| CliError::Usage(format!("invalid agent management request: {e}")))?
        .sign_with_keys(keys)
        .map_err(|e| CliError::Other(format!("could not sign agent management request: {e}")))
}

/// How a published request ended from the CLI's point of view.
#[derive(Debug)]
pub enum Outcome {
    /// The owner's client answered.
    Answered(AgentManagementResult),
    /// No answer arrived before the deadline; the request may still be pending
    /// (e.g. a review dialog is open on the owner's Desktop).
    TimedOut,
}

/// Publish `event` and, when `wait` is set, keep the connection open until a
/// control frame carrying a result for `request_id` arrives or `wait` elapses.
///
/// The subscription is opened *before* the publish so a fast Desktop cannot
/// answer in the gap. Results are matched on `request_id`; unrelated control
/// frames (cancel_turn, switch_model…) are ignored.
pub async fn publish_and_wait(
    ws_url: &str,
    keys: &Keys,
    auth_tag: Option<&Tag>,
    event: Event,
    request_id: &str,
    wait: Option<Duration>,
) -> Result<(String, Outcome), CliError> {
    let connect_budget = Duration::from_secs(75);
    let mut conn = tokio::time::timeout(connect_budget, async {
        let mut conn = NostrWsConnection::connect(ws_url).await?;
        conn.authenticate(keys, auth_tag).await?;
        Ok::<_, buzz_ws_client::WsClientError>(conn)
    })
    .await
    .map_err(|_| CliError::Other("timed out connecting to the relay".into()))?
    .map_err(|e| CliError::Other(e.to_string()))?;

    let sub_id = format!("agent-mgmt-{}", &request_id[..request_id.len().min(8)]);
    let agent_hex = keys.public_key().to_hex();
    if wait.is_some() {
        let filter = serde_json::json!({
            "kinds": [KIND_AGENT_OBSERVER_FRAME],
            "#p": [agent_hex],
            "limit": 0,
        });
        conn.send_raw(&serde_json::json!(["REQ", sub_id, filter]))
            .await
            .map_err(|e| CliError::Other(format!("could not subscribe for the result: {e}")))?;
    }

    let ok = conn
        .send_event(event)
        .await
        .map_err(|e| CliError::Other(e.to_string()))?;
    if !ok.accepted {
        return Err(CliError::Relay {
            status: 400,
            body: ok.message,
        });
    }

    let Some(wait) = wait else {
        let _ = conn.disconnect().await;
        return Ok((ok.event_id, Outcome::TimedOut));
    };

    let deadline = tokio::time::Instant::now() + wait;
    let outcome = loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break Outcome::TimedOut;
        }
        match conn.next_event(remaining).await {
            Ok(RelayMessage::Event { event, .. }) => {
                if let Some(result) = result_for(keys, &event, request_id) {
                    break Outcome::Answered(result);
                }
            }
            Ok(RelayMessage::Closed { message, .. }) => {
                return Err(CliError::Other(format!(
                    "relay closed the result subscription: {message}"
                )));
            }
            Ok(_) => {}
            Err(buzz_ws_client::WsClientError::Timeout) => break Outcome::TimedOut,
            Err(e) => return Err(CliError::Other(e.to_string())),
        }
    };
    let _ = conn.send_raw(&serde_json::json!(["CLOSE", sub_id])).await;
    let _ = conn.disconnect().await;
    Ok((ok.event_id, outcome))
}

/// Decrypt a control frame and return its result if it answers `request_id`.
fn result_for(keys: &Keys, event: &Event, request_id: &str) -> Option<AgentManagementResult> {
    if event.kind.as_u16() as u32 != KIND_AGENT_OBSERVER_FRAME {
        return None;
    }
    let payload: serde_json::Value = decrypt_observer_payload(keys, event).ok()?;
    let result = parse_agent_management_result(&payload)?;
    (result.request_id == request_id).then_some(result)
}

/// Render the CLI's JSON output for a request.
pub fn render(
    event_id: &str,
    request: &AgentManagementRequest,
    outcome: &Outcome,
) -> serde_json::Value {
    let mut out = serde_json::json!({
        "event_id": event_id,
        "accepted": true,
        "request_id": request.request_id,
        "action": request.action.name(),
    });
    let obj = out.as_object_mut().expect("object");
    match outcome {
        Outcome::Answered(result) => {
            obj.insert("status".into(), serde_json::json!(result.status));
            obj.insert(
                "saved".into(),
                (result.status == AgentManagementStatus::Executed).into(),
            );
            if let Some(v) = &result.agent_pubkey {
                obj.insert("agent_pubkey".into(), v.clone().into());
            }
            if let Some(v) = &result.agent_name {
                obj.insert("agent_name".into(), v.clone().into());
            }
            if let Some(v) = &result.persona_id {
                obj.insert("persona_id".into(), v.clone().into());
            }
            if let Some(v) = &result.error {
                obj.insert("error".into(), v.clone().into());
            }
            obj.insert("message".into(), status_message(result).into());
        }
        Outcome::TimedOut => {
            obj.insert("status".into(), "sent".into());
            obj.insert("saved".into(), false.into());
            obj.insert(
                "message".into(),
                if request.wants_review() {
                    "Draft sent to Buzz Desktop for owner review. Nothing changes until the owner saves it."
                } else {
                    "Request sent to the owner's Buzz Desktop; no result arrived yet. If the owner has not enabled unattended agent management it is waiting for their review."
                }
                .into(),
            );
        }
    }
    out
}

fn status_message(result: &AgentManagementResult) -> String {
    match result.status {
        AgentManagementStatus::Executed => match result.action.as_str() {
            "create" => "Agent created by the owner's Buzz Desktop.".into(),
            "update" => "Agent updated by the owner's Buzz Desktop.".into(),
            "delete" => "Agent deleted by the owner's Buzz Desktop.".into(),
            _ => "Request executed by the owner's Buzz Desktop.".into(),
        },
        AgentManagementStatus::PendingOwnerReview => {
            "Buzz Desktop opened a review dialog; nothing changes until the owner saves it.".into()
        }
        AgentManagementStatus::Dismissed => "The owner dismissed the request.".into(),
        AgentManagementStatus::Rejected => format!(
            "Buzz Desktop rejected the request: {}",
            result.error.as_deref().unwrap_or("no reason given")
        ),
        AgentManagementStatus::Failed => format!(
            "Buzz Desktop could not apply the request: {}",
            result.error.as_deref().unwrap_or("unknown error")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_sdk::agent_management::{
        build_agent_management_result_frame, AgentManagementAction, CreateAgentRequest,
    };

    const CHANNEL: &str = "7c07e659-3610-42f4-9a5e-1e9973c09da9";

    fn create_request() -> AgentManagementRequest {
        AgentManagementRequest::new(AgentManagementAction::Create(CreateAgentRequest {
            channel_id: CHANNEL.into(),
            display_name: "Scout".into(),
            system_prompt: "Help".into(),
            runtime: None,
            provider: None,
            model: None,
            respond_to: None,
            parallelism: None,
            avatar_url: None,
            start: None,
        }))
        .unwrap()
    }

    #[test]
    fn result_matching_is_keyed_by_request_id() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let request = create_request();
        let mut result = AgentManagementResult::new(
            &request.request_id,
            "create",
            AgentManagementStatus::Executed,
        );
        result.agent_pubkey = Some("c".repeat(64));
        let frame = build_agent_management_result_frame(&owner, &agent.public_key(), &result)
            .unwrap()
            .sign_with_keys(&owner)
            .unwrap();

        assert_eq!(
            result_for(&agent, &frame, &request.request_id).unwrap(),
            result
        );
        assert!(result_for(&agent, &frame, "other-request").is_none());
        // A frame for another agent does not decrypt.
        assert!(result_for(&Keys::generate(), &frame, &request.request_id).is_none());

        let rendered = render("ev", &request, &Outcome::Answered(result));
        assert_eq!(rendered["status"], "executed");
        assert_eq!(rendered["saved"], true);
        assert_eq!(rendered["agent_pubkey"], "c".repeat(64));
    }

    #[test]
    fn timed_out_render_distinguishes_review_drafts() {
        let request = create_request();
        let plain = render("ev", &request, &Outcome::TimedOut);
        assert_eq!(plain["status"], "sent");
        assert_eq!(plain["saved"], false);
        assert!(plain["message"].as_str().unwrap().contains("unattended"));

        let draft = render("ev", &request.with_review(), &Outcome::TimedOut);
        assert!(draft["message"].as_str().unwrap().contains("owner review"));
    }
}
