//! OneBrick Mantap SSO exchange and just-in-time Hive membership.

use std::sync::Arc;

use axum::{extract::State, http::HeaderMap, http::StatusCode, response::Json};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{TimeZone as _, Utc};
use hmac::{Hmac, KeyInit as _, Mac as _};
use serde::Deserialize;
use serde_json::Value;
use sha2::Sha256;
use uuid::Uuid;

use crate::handlers::side_effects::{publish_nip43_member_added, publish_nip43_membership_list};
use crate::state::AppState;

use super::{api_error, internal_error};

const EXPECTED_ISSUER: &str = "https://mantap.onebrick.io";
const EXPECTED_AUDIENCE: &str = "onebrick-hive";
const ALLOWED_EMAIL_DOMAIN: &str = "onebrick.io";

#[derive(Debug, Deserialize)]
/// JSON body for the one-time Mantap ticket exchange.
pub struct ExchangeRequest {
    ticket: String,
}

#[derive(Debug, Deserialize)]
struct JwtHeader {
    alg: String,
    typ: String,
}

#[derive(Debug, Deserialize)]
struct MantapClaims {
    iss: String,
    aud: String,
    sub: String,
    email: String,
    access: String,
    iat: i64,
    exp: i64,
    jti: String,
}

/// Exchange a short-lived Mantap ticket. NIP-98 binds the request body to the
/// browser-held Nostr key, so the ticket cannot provision an attacker key.
pub async fn exchange(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let (tenant, pubkey) =
        super::invites::authenticate(&state, &headers, "/api/onebrick/sso/exchange", &body).await?;
    let request: ExchangeRequest = serde_json::from_slice(&body)
        .map_err(|_| api_error(StatusCode::BAD_REQUEST, "invalid_request"))?;

    let secret = std::env::var("BUZZ_MANTAP_SSO_SHARED_SECRET").unwrap_or_default();
    if secret.len() < 32 {
        return Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "mantap_sso_unavailable",
        ));
    }
    let channel_id = std::env::var("BUZZ_MANTAP_SSO_CHANNEL_ID")
        .ok()
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
        .ok_or_else(|| api_error(StatusCode::SERVICE_UNAVAILABLE, "mantap_sso_unavailable"))?;
    let now = Utc::now().timestamp();
    let claims = validate_ticket(request.ticket.trim(), secret.as_bytes(), now)
        .map_err(|_| api_error(StatusCode::UNAUTHORIZED, "invalid_sso_ticket"))?;
    let expires_at = Utc
        .timestamp_opt(claims.exp, 0)
        .single()
        .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "invalid_sso_ticket"))?;
    let pubkey_hex = pubkey.to_hex();
    let outcome = state
        .db
        .provision_mantap_sso(buzz_db::mantap_sso::MantapSsoProvision {
            community_id: tenant.community(),
            channel_id,
            subject: &claims.sub,
            email: &claims.email,
            access: &claims.access,
            jti: &claims.jti,
            expires_at,
            pubkey: pubkey.as_bytes(),
            pubkey_hex: &pubkey_hex,
        })
        .await
        .map_err(|error| internal_error(&format!("Mantap SSO provisioning: {error}")))?;

    let (inserted, membership_changed, role) = match outcome {
        buzz_db::mantap_sso::MantapSsoProvisionOutcome::Provisioned {
            relay_member_inserted,
            relay_membership_changed,
            role,
        } => (relay_member_inserted, relay_membership_changed, role),
        buzz_db::mantap_sso::MantapSsoProvisionOutcome::Replayed => {
            return Err(api_error(StatusCode::UNAUTHORIZED, "sso_ticket_replayed"));
        }
        buzz_db::mantap_sso::MantapSsoProvisionOutcome::PubkeyConflict => {
            return Err(api_error(StatusCode::CONFLICT, "nostr_key_already_bound"));
        }
    };

    if inserted {
        if let Err(error) = publish_nip43_member_added(&tenant, &state, &pubkey_hex).await {
            tracing::warn!(%error, "failed to publish NIP-43 member-added after Mantap SSO");
        }
    }
    if membership_changed {
        if let Err(error) = publish_nip43_membership_list(&tenant, &state).await {
            tracing::warn!(%error, "failed to publish NIP-43 roster after Mantap SSO");
        }
    }

    tracing::info!(
        community = %tenant.community(),
        subject = %claims.sub,
        pubkey = %pubkey_hex,
        "Mantap identity provisioned for Hive"
    );
    Ok(Json(serde_json::json!({
        "status": if inserted { "joined" } else { "already_member" },
        "email": claims.email,
        "subject": claims.sub,
        "pubkey": pubkey_hex,
        "channel_id": channel_id,
        "role": role.as_str()
    })))
}

fn validate_ticket(ticket: &str, secret: &[u8], now: i64) -> Result<MantapClaims, ()> {
    if ticket.len() > 8192 || secret.len() < 32 {
        return Err(());
    }
    let parts: Vec<&str> = ticket.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return Err(());
    }
    let header: JwtHeader =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).map_err(|_| ())?)
            .map_err(|_| ())?;
    if header.alg != "HS256" || header.typ != "JWT" {
        return Err(());
    }
    let signature = URL_SAFE_NO_PAD.decode(parts[2]).map_err(|_| ())?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).map_err(|_| ())?;
    mac.update(format!("{}.{}", parts[0], parts[1]).as_bytes());
    mac.verify_slice(&signature).map_err(|_| ())?;

    let mut claims: MantapClaims =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).map_err(|_| ())?)
            .map_err(|_| ())?;
    claims.email = claims.email.trim().to_ascii_lowercase();
    let email_domain = claims.email.rsplit_once('@').map(|(_, domain)| domain);
    if claims.iss != EXPECTED_ISSUER
        || claims.aud != EXPECTED_AUDIENCE
        || email_domain != Some(ALLOWED_EMAIL_DOMAIN)
        || !matches!(claims.access.as_str(), "reader" | "editor" | "admin")
        || claims.sub.is_empty()
        || claims.sub.len() > 255
        || claims.jti.is_empty()
        || claims.jti.len() > 255
        || claims.iat > now + 5
        || claims.exp <= now
        || claims.exp <= claims.iat
        || claims.exp - claims.iat > 120
    {
        return Err(());
    }
    Ok(claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use serde_json::json;

    fn ticket(secret: &[u8], payload: Value) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let input = format!("{header}.{payload}");
        let mut mac = Hmac::<Sha256>::new_from_slice(secret).unwrap();
        mac.update(input.as_bytes());
        format!(
            "{input}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        )
    }

    #[test]
    fn accepts_mantap_ticket_and_normalizes_email() {
        let secret = [7_u8; 32];
        let now = 1_800_000_000;
        let claims = validate_ticket(
            &ticket(
                &secret,
                json!({
                    "iss": EXPECTED_ISSUER, "aud": EXPECTED_AUDIENCE,
                    "sub": "mantul-user:42", "email": "SaGaD@OneBrick.io",
                    "access": "reader", "iat": now, "exp": now + 45, "jti": "ticket-42"
                }),
            ),
            &secret,
            now,
        )
        .unwrap();
        assert_eq!(claims.email, "sagad@onebrick.io");
    }

    #[test]
    fn rejects_wrong_audience_domain_expiry_and_signature() {
        let secret = [8_u8; 32];
        let now = 1_800_000_000;
        for payload in [
            json!({"iss":EXPECTED_ISSUER,"aud":"other","sub":"u","email":"sagad@onebrick.io","access":"reader","iat":now,"exp":now+45,"jti":"a"}),
            json!({"iss":EXPECTED_ISSUER,"aud":EXPECTED_AUDIENCE,"sub":"u","email":"sagad@example.com","access":"reader","iat":now,"exp":now+45,"jti":"b"}),
            json!({"iss":EXPECTED_ISSUER,"aud":EXPECTED_AUDIENCE,"sub":"u","email":"sagad@onebrick.io","access":"reader","iat":now-50,"exp":now-5,"jti":"c"}),
        ] {
            assert!(validate_ticket(&ticket(&secret, payload), &secret, now).is_err());
        }
        let valid = ticket(
            &secret,
            json!({"iss":EXPECTED_ISSUER,"aud":EXPECTED_AUDIENCE,"sub":"u","email":"sagad@onebrick.io","access":"reader","iat":now,"exp":now+45,"jti":"d"}),
        );
        assert!(validate_ticket(&valid, &[9_u8; 32], now).is_err());
    }
}
