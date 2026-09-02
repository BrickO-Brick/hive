use std::time::Duration;

use reqwest::Method;
use serde::{Deserialize, Serialize};
use url::Url;

const MANTAP_BASE_URL: &str = "https://mantap.onebrick.io";

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
    let response = app_state
        .http_client
        .post(format!("{MANTAP_BASE_URL}/auth/request-otp"))
        .json(&serde_json::json!({ "username": username, "password": password }))
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
    let login_response = app_state
        .http_client
        .post(format!("{MANTAP_BASE_URL}/auth/login"))
        .json(&serde_json::json!({ "username": username, "password": password, "otp": otp }))
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
