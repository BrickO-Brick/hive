use serde::Deserialize;
use tauri::State;

use crate::{
    app_state::AppState,
    events,
    models::ChannelInfo,
    nostr_convert,
    relay::{
        assert_expected_relay_scope, parse_command_response, query_relay_at, submit_event,
        submit_event_at_with_keys,
    },
};

#[derive(Deserialize)]
struct OpenDmAck {
    channel_id: String,
}

#[tauri::command]
pub async fn open_dm(
    pubkeys: Vec<String>,
    expected_relay_url: Option<String>,
    state: State<'_, AppState>,
) -> Result<ChannelInfo, String> {
    // Resolve the relay once for the open + metadata read pair. Callers with
    // a captured tenant scope (Projects agent sends) pass
    // `expected_relay_url`; a mismatch means the active community changed
    // while their callback was suspended, and opening a DM on the new tenant
    // would hand the stale callback a channel in the wrong community — fail
    // closed instead.
    let api_base_url = crate::relay::relay_api_base_url_with_override(&state);
    assert_expected_relay_scope(expected_relay_url.as_deref(), &api_base_url)?;

    // Submit a kind:41010 dm-open event; the relay replies with the channel id
    // in its OK message payload.
    let builder = events::build_dm_open(&pubkeys)?;
    let keys = state.signing_keys()?;
    let result = submit_event_at_with_keys(builder, &state, &api_base_url, &keys).await?;
    let ack: OpenDmAck = parse_command_response(&result.message)?;

    // Re-fetch the channel metadata so the frontend gets the same `ChannelInfo`
    // shape as `get_channel_details` — through the same scope-checked base.
    let metadata = query_relay_at(
        &state,
        &api_base_url,
        &[serde_json::json!({
            "kinds": [39000],
            "#d": [ack.channel_id],
            "limit": 1
        })],
    )
    .await?;

    metadata
        .first()
        .map(|ev| nostr_convert::channel_info_from_event(ev, None, None))
        .transpose()?
        .ok_or_else(|| "DM channel created but metadata not yet available".to_string())
}

#[tauri::command]
pub async fn hide_dm(channel_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let builder = events::build_dm_hide(&channel_id)?;
    submit_event(builder, &state).await?;
    Ok(())
}
