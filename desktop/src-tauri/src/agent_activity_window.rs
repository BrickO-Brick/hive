//! Native companion-window lifecycle for an agent activity feed.

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

const PUBKEY_HEX_LENGTH: usize = 64;

fn normalized_pubkey(pubkey: &str) -> Result<String, String> {
    let normalized = pubkey.trim().to_ascii_lowercase();
    if normalized.len() != PUBKEY_HEX_LENGTH
        || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("agent pubkey must be 64 hexadecimal characters".to_string());
    }
    Ok(normalized)
}

fn window_label(channel_id: &Uuid, pubkey: &str) -> String {
    format!("agent-activity-{pubkey}-{channel_id}")
}

/// Open an agent's channel-scoped activity feed without replacing the main
/// window's thread panel. Each agent/channel pair owns one reusable window.
#[tauri::command]
pub fn open_agent_activity_window(
    app: tauri::AppHandle,
    channel_id: String,
    pubkey: String,
) -> Result<bool, String> {
    let channel_id =
        Uuid::parse_str(channel_id.trim()).map_err(|_| "channel id must be a UUID".to_string())?;
    let pubkey = normalized_pubkey(&pubkey)?;
    let label = window_label(&channel_id, &pubkey);

    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(true);
    }

    let route = format!("index.html#/channels/{channel_id}?agentSession={pubkey}");
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App(route.into()))
        .title("Agent activity")
        .inner_size(560.0, 760.0)
        .min_inner_size(420.0, 520.0)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{normalized_pubkey, window_label};
    use uuid::Uuid;

    #[test]
    fn normalizes_valid_pubkeys() {
        let uppercase = "AB".repeat(32);
        assert_eq!(normalized_pubkey(&uppercase), Ok("ab".repeat(32)));
    }

    #[test]
    fn labels_distinguish_pubkeys_with_the_same_prefix() {
        let channel_id = Uuid::nil();
        let first = format!("{}{}", "ab".repeat(6), "cd".repeat(26));
        let second = format!("{}{}", "ab".repeat(6), "ef".repeat(26));

        assert_ne!(
            window_label(&channel_id, &first),
            window_label(&channel_id, &second)
        );
    }

    #[test]
    fn rejects_invalid_pubkeys() {
        assert!(normalized_pubkey("abc").is_err());
        assert!(normalized_pubkey(&"zz".repeat(32)).is_err());
    }
}
