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

use serde::{Deserialize, Serialize};

use crate::SdkError;
use buzz_core::engram::validate_slug;
use nostr::Event;

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

// ── Read arguments ──────────────────────────────────────────────────────────

/// Arguments for `channel.read` — the one read action.
///
/// Reads are actions like any other, because #6467 requires a host with no
/// relay route of its own to be able to serve them.
///
/// One action covers channel, thread, and mention-feed scope, because they
/// differ only by filter and a name per scope would split one permission —
/// *may this agent see this channel* — across three policy decisions.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelReadArgs {
    /// Channel to read.
    pub channel_id: String,
    /// Narrow to one thread by its root event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_event_id: Option<String>,
    /// Narrow to messages mentioning the requester — the wake path.
    ///
    /// The requester is never named; see [`super::BrokerRequest`] on why no body
    /// names its own subject.
    #[serde(default, skip_serializing_if = "is_false")]
    pub mentions_only: bool,
    /// Opaque position to resume from, as returned in [`MessagePage::next_cursor`].
    ///
    /// Absent on a first read, which starts at the host's default window. A
    /// cursor is **opaque**: callers must round-trip it verbatim and must not
    /// parse, compare, or synthesize one. That is deliberate — a timestamp
    /// cursor cannot page safely when more events than `limit` share one
    /// second, and it would commit every future host to one relay ordering
    /// strategy. The host defines ordering and cursor stability, including
    /// whether a cursor stays valid across restarts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// Maximum events to return, capped at [`MAX_PAGE_LIMIT`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

impl ChannelReadArgs {
    /// Read a whole channel from the host's default window.
    #[must_use]
    pub fn channel(channel_id: impl Into<String>) -> Self {
        Self {
            channel_id: channel_id.into(),
            ..Self::default()
        }
    }

    /// Validate and normalize.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError::InvalidInput`] for a malformed channel UUID, a
    /// malformed root event id, an over-long or non-printable cursor, or an
    /// out-of-range limit.
    pub fn validated(&self) -> Result<Self, SdkError> {
        Ok(Self {
            channel_id: channel(&self.channel_id)?,
            root_event_id: self
                .root_event_id
                .as_deref()
                .map(|id| event_id(id, "rootEventId"))
                .transpose()?,
            mentions_only: self.mentions_only,
            cursor: self.cursor.as_deref().map(cursor).transpose()?,
            limit: limit(self.limit)?,
        })
    }
}

// ── Write arguments ─────────────────────────────────────────────────────────

/// Arguments for `message.post`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessagePostArgs {
    /// Channel to post in.
    pub channel_id: String,
    /// Message body.
    pub content: String,
    /// Pubkeys to notify.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<PubkeyHex>,
}

impl MessagePostArgs {
    /// Validate and normalize.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError::InvalidInput`] for a malformed channel UUID or empty
    /// content, [`SdkError::ContentTooLarge`] for oversized content, and
    /// [`SdkError::TooManyMentions`] past [`MAX_MENTIONS`].
    pub fn validated(&self) -> Result<Self, SdkError> {
        Ok(Self {
            channel_id: channel(&self.channel_id)?,
            content: content(&self.content)?,
            mentions: mentions(&self.mentions)?,
        })
    }
}

/// Arguments for `message.reply`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageReplyArgs {
    /// Channel containing the parent.
    pub channel_id: String,
    /// Event being replied to.
    pub reply_to_event_id: String,
    /// Reply body.
    pub content: String,
    /// Pubkeys to notify.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<PubkeyHex>,
}

impl MessageReplyArgs {
    /// Validate and normalize.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError::InvalidInput`] for a malformed channel UUID, a
    /// malformed event id, or empty content; [`SdkError::ContentTooLarge`] for
    /// oversized content; [`SdkError::TooManyMentions`] past [`MAX_MENTIONS`].
    pub fn validated(&self) -> Result<Self, SdkError> {
        Ok(Self {
            channel_id: channel(&self.channel_id)?,
            reply_to_event_id: event_id(&self.reply_to_event_id, "replyToEventId")?,
            content: content(&self.content)?,
            mentions: mentions(&self.mentions)?,
        })
    }
}

/// Arguments for `reaction.add`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReactionAddArgs {
    /// Channel containing the target.
    pub channel_id: String,
    /// Event being reacted to.
    pub target_event_id: String,
    /// Reaction payload — an emoji or a `:shortcode:`.
    pub reaction: String,
}

impl ReactionAddArgs {
    /// Validate and normalize.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError::InvalidInput`] for a malformed channel UUID, a
    /// malformed event id, or an empty reaction, and [`SdkError::EmojiTooLong`]
    /// past [`MAX_EMOJI_CHARS`].
    pub fn validated(&self) -> Result<Self, SdkError> {
        let reaction = self.reaction.trim();
        if reaction.is_empty() {
            return Err(SdkError::InvalidInput("reaction must not be empty".into()));
        }
        if reaction.chars().count() > MAX_EMOJI_CHARS {
            return Err(SdkError::EmojiTooLong);
        }
        Ok(Self {
            channel_id: channel(&self.channel_id)?,
            target_event_id: event_id(&self.target_event_id, "targetEventId")?,
            reaction: reaction.to_owned(),
        })
    }
}

/// Arguments for `profile.set`.
///
/// Only the requester's own profile is addressable, so there is no subject
/// field. Absent fields are left as they are; the host does not clear them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileSetArgs {
    /// Replacement display name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Replacement bio.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
    /// Replacement avatar URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picture: Option<String>,
}

impl ProfileSetArgs {
    /// Validate and normalize, requiring at least one field to change.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError::InvalidInput`] for an over-long field or a request
    /// that changes nothing.
    pub fn validated(&self) -> Result<Self, SdkError> {
        let normalized = Self {
            display_name: optional(self.display_name.as_ref(), "display name", MAX_NAME_CHARS)?,
            about: optional(self.about.as_ref(), "about", MAX_ABOUT_CHARS)?,
            picture: optional(self.picture.as_ref(), "picture", MAX_SCALAR_CHARS)?,
        };
        if normalized.display_name.is_none()
            && normalized.about.is_none()
            && normalized.picture.is_none()
        {
            return Err(SdkError::InvalidInput(
                "include at least one profile field to set".into(),
            ));
        }
        Ok(normalized)
    }
}

/// Arguments for `storage.address`.
///
/// Deriving a record's address needs the secret this contract exists to avoid
/// holding, which is why #6467 lists it among the operations to route through
/// the interface rather than compute locally.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageAddressArgs {
    /// Memory slug — `core` or `mem/…`, per NIP-AE.
    pub slug: String,
}

impl StorageAddressArgs {
    /// Validate and normalize.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError::InvalidInput`] when the slug fails the NIP-AE
    /// grammar.
    pub fn validated(&self) -> Result<Self, SdkError> {
        let slug = required(&self.slug, "slug", 255)?;
        validate_slug(&slug).map_err(|e| SdkError::InvalidInput(e.to_string()))?;
        Ok(Self { slug })
    }
}

// ── Agent arguments ─────────────────────────────────────────────────────────

/// Which agent an update or delete targets — exactly one selector, so a host
/// never has to guess which of two names wins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentTarget {
    /// Target by agent pubkey.
    Pubkey(PubkeyHex),
    /// Target by the agent's current name.
    Name(String),
}

impl AgentTarget {
    /// Validate and normalize the selector.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError::InvalidInput`] for an empty or over-long name.
    pub fn validated(&self) -> Result<Self, SdkError> {
        match self {
            Self::Pubkey(pubkey) => Ok(Self::Pubkey(PubkeyHex::parse(pubkey.as_str())?)),
            Self::Name(name) => Ok(Self::Name(required(name, "agent name", MAX_NAME_CHARS)?)),
        }
    }
}

/// Arguments for `agents.create`.
///
/// There is no owner field: the owner is whoever the host authenticated, so an
/// agent creating an agent owns it. See the [module docs](super) on ownership
/// recursion, and [`super::BrokerRequest`] on why no body names its own subject.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentsCreateArgs {
    /// Channel the new agent is attached to.
    pub channel_id: String,
    /// Name for the new agent.
    pub display_name: String,
    /// Instructions the new agent runs with.
    pub system_prompt: String,
    /// Preferred harness id; the host refuses a runtime it cannot resolve.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    /// Inference provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Model identifier, interpreted relative to the runtime.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Inbound author gate mode; absent = the host's owner-only default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub respond_to: Option<String>,
}

impl AgentsCreateArgs {
    /// Validate and normalize.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError::InvalidInput`] for a malformed channel UUID, an
    /// empty or over-long name or prompt, or an unsupported respond-to mode.
    pub fn validated(&self) -> Result<Self, SdkError> {
        Ok(Self {
            channel_id: channel(&self.channel_id)?,
            display_name: required(&self.display_name, "display name", MAX_NAME_CHARS)?,
            system_prompt: required(&self.system_prompt, "system prompt", MAX_PROMPT_CHARS)?,
            runtime: optional(self.runtime.as_ref(), "runtime", MAX_SCALAR_CHARS)?,
            provider: optional(self.provider.as_ref(), "provider", MAX_SCALAR_CHARS)?,
            model: optional(self.model.as_ref(), "model", MAX_SCALAR_CHARS)?,
            respond_to: respond_to(self.respond_to.as_ref())?,
        })
    }
}

/// Arguments for `agents.update`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentsUpdateArgs {
    /// Which agent to patch.
    pub target: AgentTarget,
    /// Rename the agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Replacement instructions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    /// Harness id to pin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    /// Inference provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Model identifier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Inbound author gate mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub respond_to: Option<String>,
}

impl AgentsUpdateArgs {
    /// Validate and normalize, requiring at least one field to change.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError::InvalidInput`] for a malformed target, an over-long
    /// field, an unsupported respond-to mode, or a request that changes nothing.
    pub fn validated(&self) -> Result<Self, SdkError> {
        let normalized = Self {
            target: self.target.validated()?,
            display_name: optional(self.display_name.as_ref(), "display name", MAX_NAME_CHARS)?,
            system_prompt: optional(
                self.system_prompt.as_ref(),
                "system prompt",
                MAX_PROMPT_CHARS,
            )?,
            runtime: optional(self.runtime.as_ref(), "runtime", MAX_SCALAR_CHARS)?,
            provider: optional(self.provider.as_ref(), "provider", MAX_SCALAR_CHARS)?,
            model: optional(self.model.as_ref(), "model", MAX_SCALAR_CHARS)?,
            respond_to: respond_to(self.respond_to.as_ref())?,
        };
        let unchanged = normalized.display_name.is_none()
            && normalized.system_prompt.is_none()
            && normalized.runtime.is_none()
            && normalized.provider.is_none()
            && normalized.model.is_none()
            && normalized.respond_to.is_none();
        if unchanged {
            return Err(SdkError::InvalidInput(
                "include at least one field to update".into(),
            ));
        }
        Ok(normalized)
    }
}

/// Arguments for `agents.delete`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentsDeleteArgs {
    /// Which agent to remove.
    pub target: AgentTarget,
}

impl AgentsDeleteArgs {
    /// Validate and normalize.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError::InvalidInput`] for a malformed target selector.
    pub fn validated(&self) -> Result<Self, SdkError> {
        Ok(Self {
            target: self.target.validated()?,
        })
    }
}

// ── Action union ────────────────────────────────────────────────────────────

/// An action name paired with its strictly typed arguments.
///
/// Flattened into [`super::BrokerRequest`], so the wire form is
/// `{ "action": "message.post", "args": { … } }` and an args shape can never be
/// paired with the wrong action name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", content = "args")]
pub enum ActionArgs {
    /// Read a channel, thread, or mention feed.
    #[serde(rename = "channel.read")]
    ChannelRead(ChannelReadArgs),
    /// Post a message.
    #[serde(rename = "message.post")]
    MessagePost(MessagePostArgs),
    /// Reply to a message.
    #[serde(rename = "message.reply")]
    MessageReply(MessageReplyArgs),
    /// React to a message.
    #[serde(rename = "reaction.add")]
    ReactionAdd(ReactionAddArgs),
    /// Set the requester's profile.
    #[serde(rename = "profile.set")]
    ProfileSet(ProfileSetArgs),
    /// Derive an encrypted-memory address.
    #[serde(rename = "storage.address")]
    StorageAddress(StorageAddressArgs),
    /// Mint a managed agent.
    #[serde(rename = "agents.create")]
    AgentsCreate(AgentsCreateArgs),
    /// Patch a managed agent.
    #[serde(rename = "agents.update")]
    AgentsUpdate(AgentsUpdateArgs),
    /// Remove a managed agent.
    #[serde(rename = "agents.delete")]
    AgentsDelete(AgentsDeleteArgs),
}

impl ActionArgs {
    /// The action these args belong to.
    #[must_use]
    pub fn action(&self) -> Action {
        match self {
            Self::ChannelRead(_) => Action::ChannelRead,
            Self::MessagePost(_) => Action::MessagePost,
            Self::MessageReply(_) => Action::MessageReply,
            Self::ReactionAdd(_) => Action::ReactionAdd,
            Self::ProfileSet(_) => Action::ProfileSet,
            Self::StorageAddress(_) => Action::StorageAddress,
            Self::AgentsCreate(_) => Action::AgentsCreate,
            Self::AgentsUpdate(_) => Action::AgentsUpdate,
            Self::AgentsDelete(_) => Action::AgentsDelete,
        }
    }

    /// Validate the arguments in place.
    ///
    /// # Errors
    ///
    /// Propagates the per-action validation error.
    pub fn validate(&self) -> Result<(), SdkError> {
        self.validated().map(|_| ())
    }

    /// Return a normalized copy with every field validated.
    ///
    /// # Errors
    ///
    /// Propagates the per-action validation error.
    pub fn validated(&self) -> Result<Self, SdkError> {
        Ok(match self {
            Self::ChannelRead(args) => Self::ChannelRead(args.validated()?),
            Self::MessagePost(args) => Self::MessagePost(args.validated()?),
            Self::MessageReply(args) => Self::MessageReply(args.validated()?),
            Self::ReactionAdd(args) => Self::ReactionAdd(args.validated()?),
            Self::ProfileSet(args) => Self::ProfileSet(args.validated()?),
            Self::StorageAddress(args) => Self::StorageAddress(args.validated()?),
            Self::AgentsCreate(args) => Self::AgentsCreate(args.validated()?),
            Self::AgentsUpdate(args) => Self::AgentsUpdate(args.validated()?),
            Self::AgentsDelete(args) => Self::AgentsDelete(args.validated()?),
        })
    }
}

// ── Outcomes ────────────────────────────────────────────────────────────────

/// One message returned by a read: the signed Nostr event, verbatim.
///
/// The event is authoritative. It is carried whole — signature and tags
/// included — rather than reduced to a projection, because Schnorr verification
/// is local and needs no relay: see [`Self::verify`]. A keyless agent therefore
/// still gets independently verifiable authorship and content, and only has to
/// trust the host for *completeness* (that no message was withheld) and for
/// authorization. Reducing to a projection would have widened that trust to
/// cover authorship too, and dropped the tags later consumers need.
///
/// The wire form is the event's own JSON, so this adds no envelope of its own.
/// Ancestry and mentions are exposed as derived accessors rather than sibling
/// fields, so there is nothing that can disagree with the signed bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BrokerMessage(pub Event);

impl BrokerMessage {
    /// The signed event.
    #[must_use]
    pub fn event(&self) -> &Event {
        &self.0
    }

    /// Verify the event's id and Schnorr signature.
    ///
    /// This is the caller's provenance check and it is entirely local. A host
    /// that fabricated or altered a message fails here regardless of what it
    /// claims. It is deliberately *not* called by
    /// [`super::BrokerResponse::validate_for`]: whether to pay for verification,
    /// and what to do when it fails, is the caller's policy.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError::InvalidInput`] when the id does not match the
    /// content or the signature does not match the author.
    pub fn verify(&self) -> Result<(), SdkError> {
        self.0.verify().map_err(|e| {
            SdkError::InvalidInput(format!("broker returned an unverifiable event: {e}"))
        })
    }

    /// The author's pubkey, in this contract's identity type.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError::InvalidInput`] if the event's author is not
    /// expressible as 64 hex characters.
    pub fn author(&self) -> Result<PubkeyHex, SdkError> {
        PubkeyHex::parse(self.0.pubkey.to_hex())
    }

    /// NIP-10 `root`/`reply` ancestry, parsed from the signed tags.
    #[must_use]
    pub fn thread(&self) -> buzz_core::nip10::ThreadMarkers {
        buzz_core::nip10::parse_thread_markers(&self.0.tags)
    }

    /// Pubkeys this message mentions, from the signed `p` tags.
    #[must_use]
    pub fn mentions(&self) -> Vec<String> {
        self.0
            .tags
            .public_keys()
            .map(nostr::PublicKey::to_hex)
            .collect()
    }
}

/// Outcome of any read action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessagePage {
    /// Messages in the host's declared order.
    pub messages: Vec<BrokerMessage>,
    /// Opaque cursor to pass as [`ChannelReadArgs::cursor`] on the next call.
    ///
    /// Absent when the host has nothing further, which is how a caller learns
    /// to stop rather than by comparing lengths against a limit it may not have
    /// set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// Outcome of an action that published one event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventPublished {
    /// The published event's id (hex).
    pub event_id: String,
    /// The published event's kind.
    pub kind: u32,
    /// Creation time the host stamped, Unix seconds.
    pub created_at: u64,
}

/// Outcome of `storage.address`.
///
/// Addressing material only. A `d` tag is a keyed hash of the slug, so it
/// identifies a record without revealing the slug or the key that derived it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageAddress {
    /// Author the record is addressed under.
    pub author_pubkey: PubkeyHex,
    /// Event kind holding the record.
    pub kind: u32,
    /// Derived `d` tag (64 hex characters).
    pub d_tag: String,
}

/// Outcome of a successful `agents.create`.
///
/// Carries the new agent's **public** key only: pubkey, name, channel, and
/// nothing else. There is no field for the minted secret — it stays on the
/// host — and `deny_unknown_fields` plus a test pinning this exact key set is
/// what enforces that rather than a comment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentsCreateOutcome {
    /// The new agent's pubkey.
    pub agent_pubkey: PubkeyHex,
    /// The new agent's name as stored.
    pub display_name: String,
    /// Channel the agent was attached to.
    pub channel_id: String,
}

/// Outcome of a successful `agents.update`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentsUpdateOutcome {
    /// The patched agent's pubkey.
    pub agent_pubkey: PubkeyHex,
    /// The agent's name after the update.
    pub display_name: String,
    /// Names of the fields the host actually changed, sorted.
    pub updated_fields: Vec<String>,
}

/// Outcome of a successful `agents.delete`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentsDeleteOutcome {
    /// The removed agent's pubkey.
    pub agent_pubkey: PubkeyHex,
    /// The removed agent's name.
    pub display_name: String,
}

/// An action-specific success payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", content = "outcome")]
pub enum ActionOutcome {
    /// `channel.read` succeeded.
    #[serde(rename = "channel.read")]
    ChannelRead(MessagePage),
    /// `message.post` succeeded.
    #[serde(rename = "message.post")]
    MessagePost(EventPublished),
    /// `message.reply` succeeded.
    #[serde(rename = "message.reply")]
    MessageReply(EventPublished),
    /// `reaction.add` succeeded.
    #[serde(rename = "reaction.add")]
    ReactionAdd(EventPublished),
    /// `profile.set` succeeded.
    #[serde(rename = "profile.set")]
    ProfileSet(EventPublished),
    /// `storage.address` succeeded.
    #[serde(rename = "storage.address")]
    StorageAddress(StorageAddress),
    /// `agents.create` succeeded.
    #[serde(rename = "agents.create")]
    AgentsCreate(AgentsCreateOutcome),
    /// `agents.update` succeeded.
    #[serde(rename = "agents.update")]
    AgentsUpdate(AgentsUpdateOutcome),
    /// `agents.delete` succeeded.
    #[serde(rename = "agents.delete")]
    AgentsDelete(AgentsDeleteOutcome),
}

impl ActionOutcome {
    /// The action that produced this outcome.
    #[must_use]
    pub fn action(&self) -> Action {
        match self {
            Self::ChannelRead(_) => Action::ChannelRead,
            Self::MessagePost(_) => Action::MessagePost,
            Self::MessageReply(_) => Action::MessageReply,
            Self::ReactionAdd(_) => Action::ReactionAdd,
            Self::ProfileSet(_) => Action::ProfileSet,
            Self::StorageAddress(_) => Action::StorageAddress,
            Self::AgentsCreate(_) => Action::AgentsCreate,
            Self::AgentsUpdate(_) => Action::AgentsUpdate,
            Self::AgentsDelete(_) => Action::AgentsDelete,
        }
    }

    /// Validate the identifiers and cursors this outcome asserts.
    ///
    /// A well-typed outcome can still carry a malformed id or an unusable
    /// cursor, and a caller that trusted either would fail later and further
    /// away. Signature verification is deliberately *not* here — that is
    /// [`BrokerMessage::verify`], and whether to pay for it is the caller's
    /// choice.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError::InvalidInput`] for a malformed event id, `d` tag,
    /// channel UUID, or cursor, an empty name, or an over-long page.
    pub fn validate(&self) -> Result<(), SdkError> {
        match self {
            Self::ChannelRead(page) => {
                if page.messages.len() > MAX_PAGE_LIMIT as usize {
                    return Err(SdkError::InvalidInput(format!(
                        "page holds {} messages, over the {MAX_PAGE_LIMIT} cap",
                        page.messages.len()
                    )));
                }
                page.next_cursor.as_deref().map(cursor).transpose()?;
            }
            Self::MessagePost(published)
            | Self::MessageReply(published)
            | Self::ReactionAdd(published)
            | Self::ProfileSet(published) => {
                event_id(&published.event_id, "eventId")?;
            }
            Self::StorageAddress(address) => {
                event_id(&address.d_tag, "dTag")?;
            }
            Self::AgentsCreate(outcome) => {
                channel(&outcome.channel_id)?;
                required(&outcome.display_name, "display name", MAX_NAME_CHARS)?;
            }
            Self::AgentsUpdate(AgentsUpdateOutcome { display_name, .. })
            | Self::AgentsDelete(AgentsDeleteOutcome { display_name, .. }) => {
                required(display_name, "display name", MAX_NAME_CHARS)?;
            }
        }
        Ok(())
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

// ── Shared validators ───────────────────────────────────────────────────────

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
