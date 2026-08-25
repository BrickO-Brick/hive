//! User identity endpoint — exposes okta_user_id for pubkey-to-corporate-identity mapping.

use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::state::AppState;

use super::{api_error, bridge::verify_bridge_auth, bridge::nip98_expected_url};

/// Response item for a single user identity.
#[derive(Serialize)]
pub struct UserIdentityResponse {
    /// Hex-encoded 32-byte public key.
    pub pubkey: String,
    /// Okta user ID linked to this Buzz profile.
    pub okta_user_id: String,
}

/// Request body for the identities endpoint.
#[derive(Deserialize)]
pub struct IdentitiesRequest {
    /// List of hex-encoded pubkeys to look up.
    pub pubkeys: Vec<String>,
}

/// `POST /api/users/identities` — fetch okta_user_id for a batch of pubkeys.
///
/// Authenticated via NIP-98. Returns only pubkeys that have an `okta_user_id` set.
/// Maximum 100 pubkeys per request.
pub async fn get_user_identities(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let raw_host = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let tenant = crate::tenant::bind_community(&state.db, raw_host)
        .await
        .map_err(|_| {
            api_error(
                StatusCode::NOT_FOUND,
                "relay: no community is configured for this host",
            )
        })?;

    let url = nip98_expected_url(&state.config.relay_url, &tenant, "/api/users/identities");
    let (pubkey, _event_id_bytes) = verify_bridge_auth(
        &headers,
        "POST",
        &url,
        Some(&body),
        state.config.require_auth_token,
    )?;

    // Enforce relay membership.
    super::relay_members::enforce_relay_membership(
        &state,
        tenant.community(),
        pubkey.as_bytes(),
        headers
            .get("x-buzz-auth-tag")
            .and_then(|v| v.to_str().ok()),
    )
    .await?;

    // Parse request body.
    let request: IdentitiesRequest = serde_json::from_slice(&body).map_err(|e| {
        api_error(
            StatusCode::BAD_REQUEST,
            &format!("invalid request body: {e}"),
        )
    })?;

    if request.pubkeys.len() > 100 {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "maximum 100 pubkeys per request",
        ));
    }

    // Decode hex pubkeys to bytes.
    let pubkey_bytes: Vec<Vec<u8>> = request
        .pubkeys
        .iter()
        .filter_map(|hex| hex::decode(hex.trim()).ok())
        .filter(|bytes| bytes.len() == 32)
        .collect();

    if pubkey_bytes.is_empty() {
        return Ok(Json(serde_json::json!([])));
    }

    // Query the database.
    let identities = state
        .db
        .get_user_identities(tenant.community(), &pubkey_bytes)
        .await
        .map_err(|e| {
            tracing::error!("get_user_identities failed: {e}");
            super::internal_error("failed to fetch user identities")
        })?;

    // Build response.
    let response: Vec<UserIdentityResponse> = identities
        .into_iter()
        .map(|u| UserIdentityResponse {
            pubkey: hex::encode(&u.pubkey),
            okta_user_id: u.okta_user_id.unwrap_or_default(),
        })
        .collect();

    tracing::info!(
        pubkey = %pubkey.to_hex(),
        route = "/api/users/identities",
        status = 200u16,
        result_count = response.len(),
        "user identities request"
    );

    Ok(Json(serde_json::to_value(response).unwrap_or_default()))
}
