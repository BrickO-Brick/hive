//! Authenticated, channel-scoped OneBrick participant directory.
//!
//! Mantap SSO owns a member's server-side display name, while a signed Nostr
//! profile is optional. This endpoint provides the safe fallback the web client
//! needs without exposing email addresses or members from another tenant.

use std::sync::Arc;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ParticipantDirectoryEntry {
    pubkey: String,
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

    let participants = members
        .into_iter()
        .map(|member| {
            let display_name = display_names.get(&member.pubkey).cloned().flatten();
            let pubkey = nostr::PublicKey::from_slice(&member.pubkey)
                .map_err(|_| internal_error("participant directory contains an invalid pubkey"))?
                .to_hex();
            Ok(ParticipantDirectoryEntry {
                pubkey,
                display_name,
                role: member.role,
            })
        })
        .collect::<Result<Vec<_>, (StatusCode, Json<Value>)>>()?;

    Ok(Json(ParticipantDirectoryResponse { participants }))
}

#[cfg(test)]
mod tests {
    use super::bounded_display_name;

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
}
