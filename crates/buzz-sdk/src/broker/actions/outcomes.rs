//! Outcome types — the success payload of each [`Action`], and the tagged union
//! that pairs a wire action name with its outcome.
//!
//! Outcomes are shared where actions agree on what success means: the four
//! event-publishing actions all return [`EventPublished`]. Every type is
//! `deny_unknown_fields` with its exact wire key set pinned by test, which is
//! what enforces the no-secret rule — see the [contract docs](crate::broker).

use serde::{Deserialize, Serialize};

use super::{
    channel, cursor, event_id, required, Action, PubkeyHex, MAX_NAME_CHARS, MAX_PAGE_LIMIT,
};
use crate::SdkError;
use nostr::Event;

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
    /// [`crate::broker::BrokerResponse::validate_for`]: whether to pay for verification,
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
    /// Opaque cursor to pass as [`super::args::ChannelReadArgs::cursor`] on the next call.
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
