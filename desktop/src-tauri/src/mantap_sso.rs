use std::time::Duration;

use aes_gcm::{
    aead::{Aead as _, KeyInit as _},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use url::Url;
use zeroize::Zeroizing;

const MANTAP_BASE_URL: &str = "https://mantap.onebrick.io";
// Mantap's browser-compatible auth proxy uses this compatibility key to wrap
// credentials before TLS transport. It is also embedded in the Mantap web
// client; authentication still relies on the user's password, OTP, and TLS.
const MANTAP_AUTH_COMPATIBILITY_KEY: &[u8; 32] = b"PAxy4298P0PuAk0r6Xa3EZwVaen1IUpS";
const MANTAP_AUTH_ENVIRONMENT: &str = "prd";

fn mantap_auth_post(
    client: &reqwest::Client,
    path: &str,
    username: &str,
) -> reqwest::RequestBuilder {
    client
        .post(format!("{MANTAP_BASE_URL}{path}"))
        .header(reqwest::header::ACCEPT, "application/json")
        .header("environment", MANTAP_AUTH_ENVIRONMENT)
        .header("X-Mantul-Username", username)
        .header("X-Mantul-Request-ID", uuid::Uuid::new_v4().to_string())
}

fn encrypt_mantap_payload_with_nonce<T: Serialize>(
    payload: &T,
    nonce_bytes: [u8; 12],
) -> Result<serde_json::Value, String> {
    let plaintext = Zeroizing::new(
        serde_json::to_vec(payload)
            .map_err(|error| format!("could not encode Mantap credentials: {error}"))?,
    );
    let cipher = Aes256Gcm::new_from_slice(MANTAP_AUTH_COMPATIBILITY_KEY)
        .map_err(|_| "could not initialize Mantap credential encryption".to_owned())?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
        .map_err(|_| "could not encrypt Mantap credentials".to_owned())?;
    let mut wrapped = Vec::with_capacity(nonce_bytes.len() + ciphertext.len());
    wrapped.extend_from_slice(&nonce_bytes);
    wrapped.extend_from_slice(&ciphertext);
    Ok(serde_json::json!({ "data": STANDARD.encode(wrapped) }))
}

fn encrypt_mantap_payload<T: Serialize>(payload: &T) -> Result<serde_json::Value, String> {
    let mut nonce = [0_u8; 12];
    getrandom::getrandom(&mut nonce)
        .map_err(|_| "could not prepare Mantap credential encryption".to_owned())?;
    encrypt_mantap_payload_with_nonce(payload, nonce)
}

fn mantap_error(payload: &serde_json::Value, fallback: &str) -> String {
    payload
        .get("message")
        .or_else(|| payload.get("error"))
        .and_then(serde_json::Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .unwrap_or(fallback)
        .to_owned()
}

#[tauri::command]
pub(crate) async fn request_mantap_otp(
    app_state: tauri::State<'_, crate::app_state::AppState>,
    username: String,
    password: String,
) -> Result<(), String> {
    let username = username.trim();
    if !username.to_ascii_lowercase().ends_with("@onebrick.io") || password.is_empty() {
        return Err("Enter a valid OneBrick email and password.".to_owned());
    }
    let payload =
        encrypt_mantap_payload(&serde_json::json!({ "username": username, "password": password }))?;
    let response = mantap_auth_post(&app_state.http_client, "/auth/request-otp", username)
        .json(&payload)
        .timeout(Duration::from_secs(35))
        .send()
        .await
        .map_err(|error| crate::relay::classify_request_error(&error))?;
    let status = response.status();
    let payload: serde_json::Value = response.json().await.unwrap_or_default();
    if !status.is_success() {
        let message = mantap_error(&payload, "Mantap could not send an OTP.");
        if !message.to_ascii_lowercase().contains("otp")
            || !message.to_ascii_lowercase().contains("resend")
        {
            return Err(message);
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct MantapExchangeResponse {
    email: String,
    subject: String,
    pubkey: String,
    channel_id: String,
    role: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MantapLoginInfo {
    email: String,
    subject: String,
    pubkey: String,
    channel_id: String,
    role: String,
}

#[tauri::command]
pub(crate) async fn start_mantap_login(
    app_handle: tauri::AppHandle,
    app_state: tauri::State<'_, crate::app_state::AppState>,
    username: String,
    password: String,
    otp: String,
) -> Result<MantapLoginInfo, String> {
    let username = username.trim();
    if !username.to_ascii_lowercase().ends_with("@onebrick.io")
        || password.is_empty()
        || otp.len() != 4
        || !otp.chars().all(|value| value.is_ascii_digit())
    {
        return Err("Enter valid Mantap credentials and a 4-digit OTP.".to_owned());
    }
    let payload = encrypt_mantap_payload(
        &serde_json::json!({ "username": username, "password": password, "otp": otp }),
    )?;
    let login_response = mantap_auth_post(&app_state.http_client, "/auth/login", username)
        .json(&payload)
        .timeout(Duration::from_secs(35))
        .send()
        .await
        .map_err(|error| crate::relay::classify_request_error(&error))?;
    let login_status = login_response.status();
    let login_payload: serde_json::Value = login_response.json().await.unwrap_or_default();
    if !login_status.is_success() {
        return Err(mantap_error(&login_payload, "Mantap rejected this OTP."));
    }
    let access_token = login_payload
        .pointer("/data/accessToken")
        .or_else(|| login_payload.pointer("/data/data/accessToken"))
        .or_else(|| login_payload.get("accessToken"))
        .and_then(serde_json::Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| "Mantap did not return a valid session.".to_owned())?;
    let launch_response = app_state
        .http_client
        .post(format!("{MANTAP_BASE_URL}/v2/hive/launch"))
        .bearer_auth(access_token)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| crate::relay::classify_request_error(&error))?;
    let launch_status = launch_response.status();
    let launch_payload: serde_json::Value = launch_response.json().await.unwrap_or_default();
    if !launch_status.is_success() {
        return Err(mantap_error(&launch_payload, "Mantap could not open Hive."));
    }
    let launch_url = launch_payload
        .get("launch_url")
        .or_else(|| launch_payload.pointer("/data/launch_url"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Mantap did not return a Hive ticket.".to_owned())?;
    let parsed =
        Url::parse(launch_url).map_err(|_| "Mantap returned an invalid Hive ticket.".to_owned())?;
    let ticket = parsed
        .fragment()
        .and_then(|fragment| fragment.strip_prefix("ticket="))
        .filter(|ticket| !ticket.is_empty() && ticket.len() <= 8192)
        .ok_or_else(|| "Mantap did not return a valid Hive ticket.".to_owned())?;

    // A reinstall can leave Hive in recovery mode with a fresh ephemeral key.
    // Mantap has authenticated the user by this point, so make that key durable
    // before NIP-98 needs it to bind the one-time ticket to this installation.
    // The command is lost-only and refuses to replace a temporarily locked
    // keyring identity.
    if app_state
        .identity_lost
        .load(std::sync::atomic::Ordering::Acquire)
    {
        crate::commands::persist_current_identity(app_handle).await?;
    }

    let body = serde_json::to_vec(&serde_json::json!({ "ticket": ticket }))
        .map_err(|error| format!("could not encode Mantap ticket exchange: {error}"))?;
    let url = format!(
        "{}/api/onebrick/sso/exchange",
        crate::relay::relay_api_base_url_with_override(&app_state)
    );
    let authorization =
        crate::relay::build_nip98_auth_header(&Method::POST, &url, &body, &app_state)?;
    let response = app_state
        .http_client
        .post(&url)
        .header(reqwest::header::AUTHORIZATION, authorization)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| crate::relay::classify_request_error(&error))?;
    let status = response.status();
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "Hive returned an invalid Mantap sign-in response".to_owned())?;
    if !status.is_success() {
        let code = payload
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("mantap_sign_in_failed");
        return Err(match code {
            "invalid_sso_ticket" | "sso_ticket_replayed" => {
                "This Mantap sign-in expired. Please try again.".to_owned()
            }
            "nostr_key_already_bound" => {
                "This Hive identity is already linked to another Mantap user.".to_owned()
            }
            "mantap_sso_unavailable" => "Mantap sign-in is temporarily unavailable.".to_owned(),
            _ => "Could not sign in to Hive with Mantap.".to_owned(),
        });
    }
    let exchanged: MantapExchangeResponse = serde_json::from_value(payload)
        .map_err(|_| "Hive returned an invalid Mantap sign-in response".to_owned())?;
    if exchanged.pubkey != app_state.signing_keys()?.public_key().to_hex() {
        return Err("Mantap sign-in returned a different Hive identity".to_owned());
    }
    Ok(MantapLoginInfo {
        email: exchanged.email,
        subject: exchanged.subject,
        pubkey: exchanged.pubkey,
        channel_id: exchanged.channel_id,
        role: exchanged.role,
    })
}

#[tauri::command]
pub(crate) fn cancel_mantap_login() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mantap_credentials_use_the_encrypted_browser_contract() -> Result<(), String> {
        let credentials = serde_json::json!({
            "username": "bricki@onebrick.io",
            "password": "not-a-real-password",
        });
        let wrapped = encrypt_mantap_payload_with_nonce(&credentials, [7_u8; 12])?;
        assert_eq!(wrapped.as_object().map(serde_json::Map::len), Some(1));

        let encoded = wrapped
            .get("data")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "encrypted envelope did not contain data".to_owned())?;
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|error| format!("encrypted envelope was not base64: {error}"))?;
        let (nonce, ciphertext) = bytes
            .split_at_checked(12)
            .ok_or_else(|| "encrypted envelope did not contain a nonce".to_owned())?;
        let cipher = Aes256Gcm::new_from_slice(MANTAP_AUTH_COMPATIBILITY_KEY)
            .map_err(|_| "could not initialize test decryption".to_owned())?;
        let decrypted = cipher
            .decrypt(Nonce::from_slice(nonce), ciphertext)
            .map_err(|_| "could not decrypt the production envelope".to_owned())?;
        let decoded: serde_json::Value = serde_json::from_slice(&decrypted)
            .map_err(|error| format!("decrypted credentials were invalid JSON: {error}"))?;
        assert_eq!(decoded, credentials);
        Ok(())
    }

    #[test]
    fn mantap_auth_requests_match_the_browser_realm_headers() -> Result<(), String> {
        let request =
            mantap_auth_post(&reqwest::Client::new(), "/auth/login", "bricki@onebrick.io")
                .build()
                .map_err(|error| error.to_string())?;

        assert_eq!(
            request.url().as_str(),
            "https://mantap.onebrick.io/auth/login"
        );
        assert_eq!(
            request
                .headers()
                .get("environment")
                .and_then(|v| v.to_str().ok()),
            Some("prd")
        );
        assert_eq!(
            request
                .headers()
                .get("X-Mantul-Username")
                .and_then(|v| v.to_str().ok()),
            Some("bricki@onebrick.io")
        );
        assert!(request.headers().contains_key("X-Mantul-Request-ID"));
        Ok(())
    }
}
