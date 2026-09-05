//! Authenticated, channel-scoped OneBrick participant directory.
//!
//! Mantap SSO owns a member's server-side display name, while a signed Nostr
//! profile is optional. This endpoint provides the safe fallback the web client
//! needs without exposing email addresses or members from another tenant.

use std::{collections::BTreeMap, sync::Arc};

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use crate::state::AppState;

use super::{api_error, internal_error, onebrick_github};

const MAX_DIRECTORY_MEMBERS: usize = 1_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ParticipantDirectoryEntry {
    pubkey: String,
    linked_pubkeys: Vec<String>,
    display_name: Option<String>,
    role: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct ParticipantDirectoryResponse {
    participants: Vec<ParticipantDirectoryEntry>,
}

fn bounded_display_name(value: Option<String>) -> Option<String> {
    value.and_then(|name| {
        let trimmed = name.trim();
        (!trimmed.is_empty()).then(|| trimmed.chars().take(100).collect())
    })
}

#[derive(Debug)]
struct ParticipantKey {
    display_name: Option<String>,
    pubkey: String,
    role: String,
    subject: Option<String>,
    verified_at_millis: i64,
}

fn collapse_participant_keys(keys: Vec<ParticipantKey>) -> Vec<ParticipantDirectoryEntry> {
    let mut groups = BTreeMap::<String, Vec<ParticipantKey>>::new();
    for key in keys {
        let group_key = key.subject.as_ref().map_or_else(
            || format!("pubkey:{}", key.pubkey),
            |subject| format!("mantap:{subject}"),
        );
        groups.entry(group_key).or_default().push(key);
    }

    groups
        .into_values()
        .filter_map(|mut group| {
            group.sort_by(|left, right| {
                right
                    .verified_at_millis
                    .cmp(&left.verified_at_millis)
                    .then_with(|| left.pubkey.cmp(&right.pubkey))
            });
            let primary = group.first()?;
            let display_name = primary
                .display_name
                .clone()
                .or_else(|| group.iter().find_map(|key| key.display_name.clone()));
            Some(ParticipantDirectoryEntry {
                pubkey: primary.pubkey.clone(),
                linked_pubkeys: group.iter().map(|key| key.pubkey.clone()).collect(),
                display_name,
                role: primary.role.clone(),
            })
        })
        .collect()
}

pub(crate) async fn participants(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<ParticipantDirectoryResponse>, (StatusCode, Json<Value>)> {
    let path = format!("/api/onebrick/channels/{channel_id}/participants");
    let (tenant, caller) = onebrick_github::authenticated_member(&state, &headers, &path).await?;

    let members = state
        .db
        .get_members(tenant.community(), channel_id)
        .await
        .map_err(|error| internal_error(&format!("participant directory roster: {error}")))?;
    if members.len() > MAX_DIRECTORY_MEMBERS {
        return Err(api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "channel participant directory exceeds the supported size",
        ));
    }
    if !members
        .iter()
        .any(|member| member.pubkey.as_slice() == caller.to_bytes().as_slice())
    {
        return Err(api_error(StatusCode::NOT_FOUND, "channel not found"));
    }

    let pubkeys = members
        .iter()
        .map(|member| member.pubkey.clone())
        .collect::<Vec<_>>();
    let users = state
        .db
        .get_users_bulk(tenant.community(), &pubkeys)
        .await
        .map_err(|error| internal_error(&format!("participant directory profiles: {error}")))?;
    let display_names = users
        .into_iter()
        .map(|user| (user.pubkey, bounded_display_name(user.display_name)))
        .collect::<std::collections::HashMap<_, _>>();

    let bindings = state
        .db
        .get_mantap_sso_bindings_bulk(tenant.community(), &pubkeys)
        .await
        .map_err(|error| internal_error(&format!("participant directory identities: {error}")))?;
    let bindings_by_pubkey = bindings
        .into_iter()
        .map(|binding| {
            (
                binding.pubkey,
                (binding.subject, binding.last_verified_at.timestamp_millis()),
            )
        })
        .collect::<std::collections::HashMap<_, _>>();

    let participant_keys = members
        .into_iter()
        .map(|member| {
            let display_name = display_names.get(&member.pubkey).cloned().flatten();
            let binding = bindings_by_pubkey.get(&member.pubkey);
            let pubkey = nostr::PublicKey::from_slice(&member.pubkey)
                .map_err(|_| internal_error("participant directory contains an invalid pubkey"))?
                .to_hex();
            Ok(ParticipantKey {
                pubkey,
                display_name,
                role: member.role,
                subject: binding.map(|(subject, _)| subject.clone()),
                verified_at_millis: binding.map_or(0, |(_, verified_at)| *verified_at),
            })
        })
        .collect::<Result<Vec<_>, (StatusCode, Json<Value>)>>()?;
    let participants = collapse_participant_keys(participant_keys);

    Ok(Json(ParticipantDirectoryResponse { participants }))
}

#[cfg(test)]
mod tests {
    use super::{
        bounded_display_name, collapse_participant_keys, ParticipantDirectoryEntry, ParticipantKey,
    };

    #[test]
    fn display_names_are_trimmed_bounded_and_empty_values_are_omitted() {
        assert_eq!(
            bounded_display_name(Some("  Siti Rahma  ".to_string())),
            Some("Siti Rahma".to_string())
        );
        assert_eq!(bounded_display_name(Some("   ".to_string())), None);
        assert_eq!(
            bounded_display_name(Some("a".repeat(101))),
            Some("a".repeat(100))
        );
    }

    #[test]
    fn collapses_browser_keys_by_authoritative_subject_and_prefers_latest_key() {
        let participants = collapse_participant_keys(vec![
            ParticipantKey {
                display_name: Some("bricki".to_string()),
                pubkey: "old-key".to_string(),
                role: "member".to_string(),
                subject: Some("mantap-user-1".to_string()),
                verified_at_millis: 10,
            },
            ParticipantKey {
                display_name: Some("bricki".to_string()),
                pubkey: "new-key".to_string(),
                role: "member".to_string(),
                subject: Some("mantap-user-1".to_string()),
                verified_at_millis: 20,
            },
            ParticipantKey {
                display_name: Some("BrickO".to_string()),
                pubkey: "agent-key".to_string(),
                role: "bot".to_string(),
                subject: None,
                verified_at_millis: 0,
            },
        ]);
        assert_eq!(
            participants,
            vec![
                ParticipantDirectoryEntry {
                    pubkey: "new-key".to_string(),
                    linked_pubkeys: vec!["new-key".to_string(), "old-key".to_string()],
                    display_name: Some("bricki".to_string()),
                    role: "member".to_string(),
                },
                ParticipantDirectoryEntry {
                    pubkey: "agent-key".to_string(),
                    linked_pubkeys: vec!["agent-key".to_string()],
                    display_name: Some("BrickO".to_string()),
                    role: "bot".to_string(),
                },
            ]
        );
    }
}
