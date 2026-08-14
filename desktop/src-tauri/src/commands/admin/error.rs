//! Typed error for admin mutation commands.

/// Error from an admin mutation command, carrying whether the relay
/// authoritatively answered so the UI can decide idempotency-retry policy
/// without string-matching the message.
///
/// `relayStatus` is `Some(code)` only when the relay returned an HTTP status —
/// the request reached the relay and it answered. It is `None` for a
/// pre-response transport failure (`send()` error, DNS/connect/timeout) or a
/// pre-send failure (auth build, body serialisation): the relay never
/// committed anything, so a retry must reuse the same idempotency key.
///
/// A body-read failure mid-stream keeps the status it was reading (the relay
/// answered with headers/status but the body was lost) — the outcome is
/// unknown, so the caller preserves idempotency and lets the retry dedupe.
///
/// Serialises `rename_all = "camelCase"`; the JS bridge surfaces it as the
/// rejected `TauriInvokeError.payload`, from which the UI reads `relayStatus`.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminMutationError {
    /// Human-readable message — byte-identical to the string the command
    /// produced before typing, so existing message parsing is unaffected.
    pub message: String,
    /// The relay's HTTP status when a response was received; `None` for a
    /// transport/pre-send failure where no relay answer exists.
    pub relay_status: Option<u16>,
}

impl AdminMutationError {
    /// The relay answered with an HTTP status.
    pub(super) fn relay(status: reqwest::StatusCode, message: String) -> Self {
        Self {
            message,
            relay_status: Some(status.as_u16()),
        }
    }
}

/// Pre-send and transport failures carry no relay status: the relay never saw
/// the request (or never answered), so the outcome is unambiguously "no commit".
impl From<String> for AdminMutationError {
    fn from(message: String) -> Self {
        Self {
            message,
            relay_status: None,
        }
    }
}
