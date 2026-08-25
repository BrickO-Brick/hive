//! Broker actions — the closed set of operations an agent may ask a host to perform.
//!
//! An action is the unit of policy; see the [module docs](super) for why this is
//! an operation enum rather than a signing primitive.
//!
//! Two consequences of that choice are visible in the types below. Every args
//! and outcome type is `deny_unknown_fields`, so a credential or environment map
//! smuggled into a payload fails to deserialize instead of reaching an executor.
//! And the wire key set of every type is pinned by test, so a secret-bearing
//! field cannot be added without a test failing.
//!
//! [`Action`] and the shared validators live here; the payload types are split
//! into [`args`] and [`outcomes`] so each side of a call reviews on its own.

use serde::{Deserialize, Serialize};

use crate::SdkError;
use buzz_core::engram::validate_slug;

pub mod args;
pub mod outcomes;

pub use args::{
    ActionArgs, AgentTarget, AgentsCreateArgs, AgentsDeleteArgs, AgentsUpdateArgs, ChannelReadArgs,
    MessagePostArgs, MessageReplyArgs, ProfileSetArgs, ReactionAddArgs, StorageAddressArgs,
};
pub use outcomes::{
    ActionOutcome, AgentsCreateOutcome, AgentsDeleteOutcome, AgentsUpdateOutcome, BrokerMessage,
    EventPublished, MessagePage, StorageAddress,
};

/// Maximum characters in a display name or agent name.
pub const MAX_NAME_CHARS: usize = 120;

/// Maximum characters in a system prompt.
pub const MAX_PROMPT_CHARS: usize = 20_000;

/// Maximum characters in a short scalar field (runtime, provider, model).
pub const MAX_SCALAR_CHARS: usize = 300;

/// Maximum characters in a profile `about` blurb.
pub const MAX_ABOUT_CHARS: usize = 2_000;

/// Maximum bytes of message content, matching the SDK's channel-message cap.
pub const MAX_CONTENT_BYTES: usize = 64 * 1024;

/// Maximum characters in a reaction payload (emoji or `:shortcode:`).
pub const MAX_EMOJI_CHARS: usize = 66;

/// Maximum mentions attachable to one message.
pub const MAX_MENTIONS: usize = 50;

/// Maximum events a single read may return.
pub const MAX_PAGE_LIMIT: u32 = 500;

/// Events a read returns when the request sets no explicit `limit`.
///
/// A caller that omits `limit` is not agreeing to an unbounded page, so this is
/// the number a response is held to in that case — see
/// [`crate::broker::BrokerResponse::validate_for`]. It is deliberately well
/// under [`MAX_PAGE_LIMIT`]: the cap is what a host may ever send, this is what
/// it may send unasked.
pub const DEFAULT_PAGE_LIMIT: u32 = 100;

/// Maximum accepted length of a read cursor, in bytes.
pub const MAX_CURSOR_LEN: usize = 256;

/// Inbound author gate modes a requester may ask for.
///
/// `allowlist` is deliberately absent: it needs a pubkey list this request
/// shape does not carry, and a mode without its list would mint an agent
/// nobody can talk to.
pub const RESPOND_TO_MODES: [&str; 2] = ["owner-only", "anyone"];

/// A public key in lowercase hex — the only identity this contract has.
///
/// #6467 asks for identity to be separable from signing. This type is that
/// separation made structural: it holds 64 hex characters of public key and has
/// no counterpart in this module for the corresponding secret.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct PubkeyHex(String);

impl PubkeyHex {
    /// Parse a 64-character hex public key, normalizing to lowercase.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError::InvalidInput`] unless `value` is exactly 64 hex
    /// characters.
    pub fn parse(value: impl AsRef<str>) -> Result<Self, SdkError> {
        let value = value.as_ref().trim();
        if value.len() != 64 || !value.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(SdkError::InvalidInput(
                "pubkey must be 64 hex characters".into(),
            ));
        }
        Ok(Self(value.to_ascii_lowercase()))
    }

    /// The hex representation.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for PubkeyHex {
    type Error = SdkError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(value)
    }
}

impl From<PubkeyHex> for String {
    fn from(value: PubkeyHex) -> Self {
        value.0
    }
}

impl std::fmt::Display for PubkeyHex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// An action name the broker can dispatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Action {
    /// Read messages from a channel, thread, or mention feed after a cursor.
    ChannelRead,
    /// Post a top-level channel message.
    MessagePost,
    /// Reply to an existing message.
    MessageReply,
    /// React to an existing message.
    ReactionAdd,
    /// Publish the requester's own profile metadata.
    ProfileSet,
    /// Derive the address of one encrypted-memory record.
    StorageAddress,
    /// Mint a managed agent owned by the requester.
    AgentsCreate,
    /// Patch a managed agent the requester owns.
    AgentsUpdate,
    /// Remove a managed agent the requester owns.
    AgentsDelete,
}

impl Action {
    /// Every action in this protocol version, in wire-name order.
    pub const ALL: [Self; 9] = [
        Self::AgentsCreate,
        Self::AgentsDelete,
        Self::AgentsUpdate,
        Self::ChannelRead,
        Self::MessagePost,
        Self::MessageReply,
        Self::ProfileSet,
        Self::ReactionAdd,
        Self::StorageAddress,
    ];

    /// Stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ChannelRead => "channel.read",
            Self::MessagePost => "message.post",
            Self::MessageReply => "message.reply",
            Self::ReactionAdd => "reaction.add",
            Self::ProfileSet => "profile.set",
            Self::StorageAddress => "storage.address",
            Self::AgentsCreate => "agents.create",
            Self::AgentsUpdate => "agents.update",
            Self::AgentsDelete => "agents.delete",
        }
    }

    /// The action contract version this build implements.
    #[must_use]
    pub fn current_version(self) -> u16 {
        1
    }

    /// Whether a host may refuse this action without harming the agent.
    ///
    /// #6467 requires non-essential signed housekeeping to be skippable, so an
    /// agent can still run where it is unavailable. See
    /// [`super::BrokerErrorCode::Unsupported`] for how a caller reacts.
    #[must_use]
    pub fn is_best_effort(self) -> bool {
        matches!(self, Self::ReactionAdd)
    }

    /// Resolve a wire name.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError::InvalidInput`] for an unknown action name.
    pub fn parse(name: &str) -> Result<Self, SdkError> {
        Self::ALL
            .into_iter()
            .find(|action| action.as_str() == name)
            .ok_or_else(|| SdkError::InvalidInput(format!("unknown broker action \"{name}\"")))
    }
}

// ── Shared validators ───────────────────────────────────────────────────────

fn is_false(value: &bool) -> bool {
    !*value
}

fn required(value: &str, label: &str, max: usize) -> Result<String, SdkError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(SdkError::InvalidInput(format!("{label} must not be empty")));
    }
    if value.chars().count() > max {
        return Err(SdkError::InvalidInput(format!(
            "{label} is too long (max {max} characters)"
        )));
    }
    Ok(value.to_owned())
}

fn optional(value: Option<&String>, label: &str, max: usize) -> Result<Option<String>, SdkError> {
    value.map(|value| required(value, label, max)).transpose()
}

fn channel(value: &str) -> Result<String, SdkError> {
    let value = required(value, "channel", 128)?;
    uuid::Uuid::parse_str(&value)
        .map_err(|_| SdkError::InvalidInput(format!("invalid channel UUID: {value}")))?;
    Ok(value)
}

fn event_id(value: &str, label: &str) -> Result<String, SdkError> {
    let value = required(value, label, 64)?;
    if value.len() != 64 || !value.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(SdkError::InvalidInput(format!(
            "{label} must be 64 hex characters"
        )));
    }
    Ok(value.to_ascii_lowercase())
}

fn content(value: &str) -> Result<String, SdkError> {
    if value.trim().is_empty() {
        return Err(SdkError::InvalidInput("content must not be empty".into()));
    }
    if value.len() > MAX_CONTENT_BYTES {
        return Err(SdkError::ContentTooLarge {
            max: MAX_CONTENT_BYTES,
            got: value.len(),
        });
    }
    Ok(value.to_owned())
}

fn mentions(values: &[PubkeyHex]) -> Result<Vec<PubkeyHex>, SdkError> {
    if values.len() > MAX_MENTIONS {
        return Err(SdkError::TooManyMentions);
    }
    values
        .iter()
        .map(|pubkey| PubkeyHex::parse(pubkey.as_str()))
        .collect()
}

fn limit(value: Option<u32>) -> Result<Option<u32>, SdkError> {
    match value {
        None => Ok(None),
        Some(0) => Err(SdkError::InvalidInput("limit must be at least 1".into())),
        Some(limit) if limit > MAX_PAGE_LIMIT => Err(SdkError::InvalidInput(format!(
            "limit exceeds {MAX_PAGE_LIMIT} (got {limit})"
        ))),
        Some(limit) => Ok(Some(limit)),
    }
}

/// Validate an opaque read cursor: printable ASCII, bounded, never parsed.
///
/// The bound exists so a host cannot be made to store an unbounded token; the
/// character set keeps it safe to log. Nothing here interprets the value.
fn cursor(value: &str) -> Result<String, SdkError> {
    if value.is_empty() {
        return Err(SdkError::InvalidInput(
            "cursor must not be empty (omit it to start from the host's default window)".into(),
        ));
    }
    if value.len() > MAX_CURSOR_LEN {
        return Err(SdkError::InvalidInput(format!(
            "cursor exceeds {MAX_CURSOR_LEN} bytes (got {})",
            value.len()
        )));
    }
    if !value.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err(SdkError::InvalidInput(
            "cursor must be printable ASCII without spaces".into(),
        ));
    }
    Ok(value.to_owned())
}

fn respond_to(value: Option<&String>) -> Result<Option<String>, SdkError> {
    let value = optional(value, "respond-to", MAX_SCALAR_CHARS)?;
    if let Some(mode) = value.as_deref() {
        if !RESPOND_TO_MODES.contains(&mode) {
            return Err(SdkError::InvalidInput(format!(
                "respond-to must be one of {}",
                RESPOND_TO_MODES.join(", ")
            )));
        }
    }
    Ok(value)
}
