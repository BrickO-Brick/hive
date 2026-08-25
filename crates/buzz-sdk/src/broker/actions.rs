//! Broker actions — the closed set of operations an agent may ask a host to perform.
//!
//! An action is the unit of policy. `message.post` and `agents.delete` are
//! separate names so a host can permit one without permitting the other, and so
//! a later policy layer has something per-operation to attach to. There is
//! deliberately no `sign` action and no `publish` action: an interface that can
//! sign arbitrary bytes is a signing oracle, and a host holding it could not
//! reason about what it authorized.
//!
//! Two consequences of that choice are visible in the types below. Every args
//! type is `deny_unknown_fields`, so a credential or environment map smuggled
//! into a payload fails to deserialize instead of reaching an executor. Every
//! outcome type can structurally hold only public identifiers — no field of any
//! outcome can transport key material.

use serde::{Deserialize, Serialize};

use crate::SdkError;
use buzz_core::engram::validate_slug;

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
/// no counterpart in this module for the corresponding secret. Nothing here can
/// name, hold, or ask for one.
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
    /// #6467 requires non-essential signed housekeeping to be skippable, so
    /// that an agent can still run where it is unavailable. For a best-effort
    /// action, [`super::BrokerErrorCode::Unsupported`] is a normal answer and a
    /// caller must carry on. For every other action, `Unsupported` means the
    /// agent cannot do its job on this host and should say so out loud.
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
/// One action covers three scopes, because they differ only by filter and a
/// separate name per scope would be a separate policy decision for the same
/// underlying permission — *may this agent see this channel*. `rootEventId`
/// narrows to one thread; `mentionsOnly` narrows to messages that mention the
/// requester, which is the wake path.
///
/// `since` is an inclusive lower bound in Unix seconds, matching the relay's
/// filter granularity. A caller must de-duplicate by event id: second-precision
/// cursors can straddle events, so consecutive pages may overlap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelReadArgs {
    /// Channel to read.
    pub channel_id: String,
    /// Narrow to one thread by its root event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_event_id: Option<String>,
    /// Narrow to messages mentioning the requester.
    ///
    /// The requester is never named. The host answers for the identity it
    /// authenticated; a body that could ask "what mentions *someone else*"
    /// would be a body that picks its own subject.
    #[serde(default, skip_serializing_if = "is_false")]
    pub mentions_only: bool,
    /// Inclusive lower bound, Unix seconds. Absent = host's default window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
    /// Maximum events to return, capped at [`MAX_PAGE_LIMIT`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

impl ChannelReadArgs {
    /// Read a whole channel.
    #[must_use]
    pub fn channel(channel_id: impl Into<String>) -> Self {
        Self {
            channel_id: channel_id.into(),
            root_event_id: None,
            mentions_only: false,
            since: None,
            limit: None,
        }
    }

    /// Narrow this read to one thread.
    #[must_use]
    pub fn in_thread(mut self, root_event_id: impl Into<String>) -> Self {
        self.root_event_id = Some(root_event_id.into());
        self
    }

    /// Narrow this read to messages mentioning the requester.
    #[must_use]
    pub fn mentions_only(mut self) -> Self {
        self.mentions_only = true;
        self
    }

    /// Start this read at `since` (inclusive, Unix seconds).
    #[must_use]
    pub fn since(mut self, since: u64) -> Self {
        self.since = Some(since);
        self
    }

    /// Cap this read at `limit` events.
    #[must_use]
    pub fn limit(mut self, limit: u32) -> Self {
        self.limit = Some(limit);
        self
    }

    /// Validate and normalize.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError::InvalidInput`] for a malformed channel UUID, a
    /// malformed root event id, or an out-of-range limit.
    pub fn validated(&self) -> Result<Self, SdkError> {
        Ok(Self {
            channel_id: channel(&self.channel_id)?,
            root_event_id: self
                .root_event_id
                .as_deref()
                .map(|id| event_id(id, "rootEventId"))
                .transpose()?,
            mentions_only: self.mentions_only,
            since: self.since,
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
/// Encrypted-memory records are addressed by a tag derived from a conversation
/// key, so deriving one needs the secret this contract exists to avoid holding.
/// #6467 lists that derivation among the operations to route through the
/// interface, which is why it is an action rather than a local computation.
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

/// Which agent an update or delete targets.
///
/// Exactly one selector, because a request naming the target twice is ambiguous
/// and the host would have to guess which wins.
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
/// There is no owner field. The owner of a created agent is whoever the host
/// authenticated for this request — an agent creating an agent owns it, and the
/// chain of ownership ends at a human. A request that could name its own
/// authority would let any caller mint agents under someone else.
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

/// One message returned by a read.
///
/// A projection, not a Nostr event: no signature, no tag array. A caller that
/// needs to verify signatures needs the relay, which is exactly what a
/// broker-only deployment does not have. Trust here is trust in the host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrokerMessage {
    /// Event id (hex).
    pub event_id: String,
    /// Author's pubkey.
    pub author_pubkey: PubkeyHex,
    /// Event kind.
    pub kind: u32,
    /// Creation time, Unix seconds.
    pub created_at: u64,
    /// Message body.
    pub content: String,
    /// Thread root, when this message is threaded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_event_id: Option<String>,
    /// Immediate parent, when this message is a reply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_event_id: Option<String>,
    /// Pubkeys this message mentions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<PubkeyHex>,
}

/// Outcome of any read action.
///
/// `nextCursor` is the value to pass as `since` on the following call. It is
/// absent when the host has nothing further, which is how a caller learns to
/// stop rather than by comparing lengths against a limit it may not have set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessagePage {
    /// Messages in ascending `createdAt` order.
    pub messages: Vec<BrokerMessage>,
    /// Cursor for the next page, if more may exist.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<u64>,
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
/// Carries the new agent's **public** key only. There is no field for the
/// minted secret: it stays on the host, and this type could not transport it
/// even if a handler tried.
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
