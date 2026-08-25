//! Agent ↔ broker contract — the operations an agent asks a host to perform.
//!
//! This module is a **contract only**. It defines the request envelope, the
//! closed set of [`Action`]s, the result shape, the HTTP binding, and a client
//! trait. It contains no host, no transport, and no signing: the only
//! implementation here is a test double.
//!
//! # Mental model
//!
//! ```text
//! agent → BrokerRequest → (POST /v1/action, bearer credential) → host
//!   host: authenticate → authorize → validate → execute → BrokerResponse
//! ```
//!
//! The agent holds its public key and a session credential. It holds no secret
//! key, has no relay connection of its own, and can reach the relay only by
//! asking. Everything it wants to do — including reading — is an action.
//!
//! # Why an operation enum rather than a "sign this" primitive
//!
//! [#6467](https://github.com/block/buzz/issues/6467) leaves this open. This
//! contract answers it: a closed enum of named business operations.
//!
//! A `sign(bytes)` primitive makes the broker a signing oracle. It can tell
//! *who* is asking but not *what for*, so the only policies it can express are
//! "all" and "none". Named operations invert that: a host can serve
//! `channel.read` while refusing `agents.create`, and a later policy or
//! information-flow layer has a per-operation surface to attach to. The cost is
//! that a new operation needs a new variant — deliberately, since adding one is
//! then a reviewable change to the contract rather than a new use of an existing
//! blank cheque.
//!
//! The same reasoning is why signing, publishing, and credential access are not
//! actions. `message.post` names an intent a host can reason about;
//! `publish(event)` names a mechanism it cannot.
//!
//! # How this satisfies #6467
//!
//! | #6467 requirement | Where |
//! |---|---|
//! | Identity separable from signing; pubkey-only identity | [`PubkeyHex`] is the only identity type; no secret-key type exists in this module. |
//! | Secret-dependent operations funnelled through the interface | Event signing is subsumed by the write actions (`message.post`, `message.reply`, `reaction.add`, `profile.set`, `agents.*`) — the agent states intent, the host signs. Encrypted-storage address derivation is [`Action::StorageAddress`]. NIP-42 relay auth, NIP-44 encryption, and NIP-98 request auth are **not** actions: they are mechanisms internal to whoever holds the key. |
//! | Relay auth is a control-flow choice | Nothing here mentions relay authentication, so there is no local auth step to skip. |
//! | Every relay-touching op, reads included, routable | [`Action::ChannelRead`] covers channel, thread, and mention-feed reads. No action assumes the caller can reach a relay. |
//! | Non-essential housekeeping skippable | [`Action::is_best_effort`] marks such actions; a host answers [`BrokerErrorCode::Unsupported`] and the agent carries on. |
//! | No secret leaks to children via env | No args type carries an environment map, and `deny_unknown_fields` means one cannot be smuggled in. Process spawning is a host concern this contract cannot express. |
//! | Lives in the shared client layer | `buzz-sdk`, which the CLI and the harness already depend on. |
//!
//! # The no-secret rule
//!
//! No secret key material crosses this boundary in either direction. What
//! enforces it is the wire schema, not a comment: every args and outcome type is
//! `deny_unknown_fields`, and tests pin each type's exact key set, so a
//! secret-bearing field cannot be added without a test failing.
//! [`AgentsCreateOutcome`] is the case that matters — it returns public identity
//! only, never the key it just minted.
//!
//! Two limits are worth stating. A `String` field can physically hold secret
//! text, so keeping secrets out of message content and error messages is host
//! policy this contract cannot enforce. And nothing stops a host from *holding*
//! keys — that is the point; it stops one from handing them over.
//!
//! # Ownership recursion
//!
//! [`Action::AgentsCreate`] has no owner field. The owner of a created agent is
//! whichever identity the host authenticated for the request, so an agent that
//! creates an agent owns it, and following the chain upward always terminates at
//! a human. Bounding the depth of that chain is a host concern: it depends on
//! resources and policy this contract cannot see. A request that could name its
//! own authority would let any caller mint agents under someone else.
//!
//! # Deferred operations
//!
//! `presence.set` and `typing.set` are not in v1. They are housekeeping a host
//! can decline anyway, and the closed enum makes adding them purely additive —
//! a new variant, a new wire name, no change to existing ones.
//!
//! Streaming reads are also deferred. Reads are request/response; waking on a
//! mention is `channel.read` with `mentionsOnly`, polled.
//!
//! # Non-goals
//!
//! - **Hosts.** Authentication, authorization, idempotency storage, execution,
//!   and depth caps all live in the host.
//! - **Transports.** [`BrokerClient`] exists so an in-process and an HTTP
//!   implementation are interchangeable; neither is here.
//! - **Relay changes.** A host does ordinary relay work as an ordinary client.
//!   The relay never learns a broker exists.
//! - **Grants and authorization fields.** There is no `authorization` field.
//!   One gets added, as a discriminated object, when a real grant format and
//!   verifier exist — not before, so no field looks security-bearing while
//!   enforcing nothing.
//! - **Secret-key custody.** How the host holds keys, and whether it refuses to
//!   start when a stale local key is present, are host decisions.

use serde::{Deserialize, Serialize};

use crate::SdkError;

pub mod actions;
pub mod client;

pub use actions::{
    Action, ActionArgs, ActionOutcome, AgentTarget, AgentsCreateArgs, AgentsCreateOutcome,
    AgentsDeleteArgs, AgentsDeleteOutcome, AgentsUpdateArgs, AgentsUpdateOutcome, BrokerMessage,
    ChannelReadArgs, EventPublished, MessagePage, MessagePostArgs, MessageReplyArgs,
    ProfileSetArgs, PubkeyHex, ReactionAddArgs, StorageAddress, StorageAddressArgs,
};
pub use client::{
    BrokerClient, BrokerFuture, BrokerTransportError, BROKER_ACTION_PATH, BROKER_CREDENTIAL_HEADER,
};

/// Wire `type` discriminator for a broker request payload.
pub const BROKER_REQUEST_TYPE: &str = "broker_request";

/// Wire `type` discriminator for a broker response payload.
pub const BROKER_RESULT_TYPE: &str = "broker_result";

/// Current broker protocol version.
///
/// There is no "absent means 1" compatibility rule: the protocol is unshipped,
/// so `protocolVersion` is required and an unknown value is rejected outright.
pub const BROKER_PROTOCOL_VERSION: u16 = 1;

/// Maximum accepted length of a `requestId`, in bytes.
pub const MAX_REQUEST_ID_LEN: usize = 128;

/// A request to execute one broker action.
///
/// # What this envelope deliberately omits
///
/// There is no requester, owner, scope, or relay field. Those are derived by the
/// host from the authenticated session credential. **A body that could name its
/// own subject would let any caller act as anyone** — that one rule is why
/// `channel.read` cannot ask about another identity's mentions, why
/// `profile.set` has no subject, and why `agents.create` has no owner.
///
/// # Retry contract
///
/// Retrying means resending the identical serialized request with the same
/// `requestId`, which is why a client never sends this type directly: call
/// [`Self::prepare`] to freeze it into a [`PreparedRequest`] and hand *that* to
/// [`BrokerClient::execute`]. The host hashes the bytes it receives and compares
/// that digest against the digest recorded under the same idempotency key:
///
/// - same key, same digest → the recorded outcome is replayed, nothing re-runs
/// - same key, different digest → rejected as a request-ID conflict
///
/// A typed value cannot carry that guarantee. Two serializations of one value
/// can differ in bytes across serde versions or implementations, and the
/// difference would surface as a spurious [`BrokerErrorCode::RequestIdConflict`]
/// on retry. Serializing once removes the possibility rather than warning about
/// it. There is no client-computed digest field: idempotency is decided
/// host-side, and a caller-supplied digest would be a claim the host has to
/// recompute anyway.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BrokerRequest {
    /// Payload discriminator — must equal [`BROKER_REQUEST_TYPE`].
    pub r#type: String,
    /// Protocol version — must equal [`BROKER_PROTOCOL_VERSION`].
    pub protocol_version: u16,
    /// Caller-chosen idempotency key, unique per logical operation.
    pub request_id: String,
    /// Action contract version the caller wrote `args` against.
    pub action_version: u16,
    /// The action to invoke, with its strictly typed arguments.
    #[serde(flatten)]
    pub action: ActionArgs,
}

impl BrokerRequest {
    /// Build a request for `action` at the current protocol version.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError::InvalidInput`] if `request_id` is empty, longer than
    /// [`MAX_REQUEST_ID_LEN`], or not printable ASCII, or if the action's
    /// arguments fail validation.
    pub fn new(request_id: impl Into<String>, action: ActionArgs) -> Result<Self, SdkError> {
        let request = Self {
            r#type: BROKER_REQUEST_TYPE.to_string(),
            protocol_version: BROKER_PROTOCOL_VERSION,
            request_id: request_id.into(),
            action_version: action.action().current_version(),
            action,
        };
        request.validate()?;
        Ok(request)
    }

    /// The action this request invokes.
    #[must_use]
    pub fn action(&self) -> Action {
        self.action.action()
    }

    /// Validate, then serialize once into the bytes every attempt will send.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError`] when [`Self::validate`] fails, or
    /// [`SdkError::InvalidInput`] if serialization fails.
    pub fn prepare(self) -> Result<PreparedRequest, SdkError> {
        self.validate()?;
        let body = serde_json::to_vec(&self).map_err(|e| {
            SdkError::InvalidInput(format!("broker request is not serializable: {e}"))
        })?;
        Ok(PreparedRequest {
            request: self,
            body,
        })
    }

    /// Validate every field the host must agree on before executing anything.
    ///
    /// Callers validate before sending; the host revalidates on receipt,
    /// because only the host's verdict is authoritative.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError`] for a wrong `type`, an unsupported
    /// `protocolVersion` or `actionVersion`, a malformed `requestId`, or
    /// arguments that fail their own validation.
    pub fn validate(&self) -> Result<(), SdkError> {
        if self.r#type != BROKER_REQUEST_TYPE {
            return Err(SdkError::InvalidInput(format!(
                "broker request type must be \"{BROKER_REQUEST_TYPE}\", got \"{}\"",
                self.r#type
            )));
        }
        if self.protocol_version != BROKER_PROTOCOL_VERSION {
            return Err(SdkError::InvalidInput(format!(
                "unsupported broker protocolVersion {} (expected {BROKER_PROTOCOL_VERSION})",
                self.protocol_version
            )));
        }
        validate_request_id(&self.request_id)?;
        let action = self.action();
        if self.action_version != action.current_version() {
            return Err(SdkError::InvalidInput(format!(
                "unsupported actionVersion {} for {} (expected {})",
                self.action_version,
                action.as_str(),
                action.current_version()
            )));
        }
        self.action.validate()
    }
}

/// Validate a `requestId`: non-empty, bounded, printable ASCII without spaces.
///
/// The bound and character set exist because this value becomes part of a
/// durable idempotency key and appears in audit records.
///
/// # Errors
///
/// Returns [`SdkError::InvalidInput`] when the id is empty, exceeds
/// [`MAX_REQUEST_ID_LEN`] bytes, or contains a byte outside `0x21..=0x7e`.
pub fn validate_request_id(request_id: &str) -> Result<(), SdkError> {
    if request_id.is_empty() {
        return Err(SdkError::InvalidInput("requestId must not be empty".into()));
    }
    if request_id.len() > MAX_REQUEST_ID_LEN {
        return Err(SdkError::InvalidInput(format!(
            "requestId exceeds {MAX_REQUEST_ID_LEN} bytes (got {})",
            request_id.len()
        )));
    }
    if let Some(bad) = request_id
        .bytes()
        .find(|b| !(0x21..=0x7e).contains(b))
        .map(|b| format!("0x{b:02x}"))
    {
        return Err(SdkError::InvalidInput(format!(
            "requestId must be printable ASCII without spaces (found byte {bad})"
        )));
    }
    Ok(())
}

/// A validated request together with the exact bytes to send.
///
/// This is what [`BrokerClient::execute`] takes, so the retry contract is
/// structural rather than documented: the first attempt and every retry send
/// `body` verbatim, and no implementation gets the chance to reserialize.
///
/// Construct one with [`BrokerRequest::prepare`]. The typed [`BrokerRequest`] is
/// kept alongside so a client can correlate the response without reparsing —
/// see [`BrokerResponse::validate_for`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedRequest {
    request: BrokerRequest,
    body: Vec<u8>,
}

impl PreparedRequest {
    /// The frozen JSON body. Every attempt sends exactly these bytes.
    #[must_use]
    pub fn body(&self) -> &[u8] {
        &self.body
    }

    /// The typed request these bytes encode.
    #[must_use]
    pub fn request(&self) -> &BrokerRequest {
        &self.request
    }

    /// The idempotency key the host keys replay on.
    #[must_use]
    pub fn request_id(&self) -> &str {
        &self.request.request_id
    }

    /// The action being invoked.
    #[must_use]
    pub fn action(&self) -> Action {
        self.request.action()
    }
}

/// Machine-readable broker error code.
/// These name failures the *broker* is responsible for. Failures inside an
/// action arrive as [`BrokerErrorCode::ActionFailed`] with detail in the
/// message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrokerErrorCode {
    /// The envelope or action arguments failed validation.
    InvalidRequest,
    /// The `protocolVersion` is not supported by this host.
    UnsupportedProtocolVersion,
    /// The action name is unknown to this host.
    UnknownAction,
    /// The `actionVersion` is not supported for this action.
    UnsupportedActionVersion,
    /// The host knows this action but does not offer it.
    ///
    /// For an action where [`Action::is_best_effort`] holds, this is a normal
    /// answer and the agent carries on. Otherwise the agent cannot do its job
    /// on this host.
    Unsupported,
    /// The session credential was missing, malformed, or rejected.
    ///
    /// A host verdict, delivered as [`BrokerResult::Failed`], never as a
    /// transport error: the request was refused before execution, so the caller
    /// knows no side effects occurred.
    Unauthenticated,
    /// The requester is authenticated but not permitted this action.
    Unauthorized,
    /// Reuse of a `requestId` with different request content.
    RequestIdConflict,
    /// The action ran and reported a domain failure.
    ActionFailed,
    /// The host could not determine whether side effects occurred.
    ///
    /// Only ever paired with [`BrokerResult::Indeterminate`].
    OutcomeUnknown,
    /// An unexpected host-side fault.
    Internal,
}

impl BrokerErrorCode {
    /// Stable wire string for this code.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::UnsupportedProtocolVersion => "unsupported_protocol_version",
            Self::UnknownAction => "unknown_action",
            Self::UnsupportedActionVersion => "unsupported_action_version",
            Self::Unsupported => "unsupported",
            Self::Unauthenticated => "unauthenticated",
            Self::Unauthorized => "unauthorized",
            Self::RequestIdConflict => "request_id_conflict",
            Self::ActionFailed => "action_failed",
            Self::OutcomeUnknown => "outcome_unknown",
            Self::Internal => "internal",
        }
    }
}

/// A broker error: a machine-readable code plus a human-readable message.
///
/// Messages are for operators and must never carry secrets — no nsec, no
/// credentials, no decrypted payloads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerError {
    /// Machine-readable failure code.
    pub code: BrokerErrorCode,
    /// Operator-facing description. Secret-free.
    pub message: String,
}

impl BrokerError {
    /// Construct an error from a code and message.
    pub fn new(code: BrokerErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// An [`BrokerErrorCode::InvalidRequest`] error.
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(BrokerErrorCode::InvalidRequest, message)
    }

    /// An [`BrokerErrorCode::Unsupported`] error.
    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(BrokerErrorCode::Unsupported, message)
    }

    /// An [`BrokerErrorCode::Unauthorized`] error.
    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(BrokerErrorCode::Unauthorized, message)
    }
}

/// The terminal disposition of a broker request.
///
/// A discriminated union, so "succeeded with an error" and "failed with an
/// outcome" are unrepresentable rather than merely discouraged.
///
/// [`Self::Indeterminate`] is distinct from [`Self::Failed`] on purpose:
/// `Failed` promises no side effects took hold, while `Indeterminate` promises
/// nothing at all and demands reconciliation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum BrokerResult {
    /// The action completed and produced this outcome.
    Succeeded {
        /// Action-specific success payload.
        #[serde(flatten)]
        outcome: ActionOutcome,
    },
    /// The action did not complete; no side effects are expected to persist.
    Failed {
        /// Why it failed.
        error: BrokerError,
    },
    /// Whether side effects occurred could not be determined.
    Indeterminate {
        /// What is unknown, and why.
        error: BrokerError,
    },
}

impl BrokerResult {
    /// A successful result carrying `outcome`.
    #[must_use]
    pub fn succeeded(outcome: ActionOutcome) -> Self {
        Self::Succeeded { outcome }
    }

    /// A failed result carrying `error`.
    #[must_use]
    pub fn failed(error: BrokerError) -> Self {
        Self::Failed { error }
    }

    /// An indeterminate result carrying `error`.
    #[must_use]
    pub fn indeterminate(error: BrokerError) -> Self {
        Self::Indeterminate { error }
    }

    /// The outcome, when this is a success.
    #[must_use]
    pub fn outcome(&self) -> Option<&ActionOutcome> {
        match self {
            Self::Succeeded { outcome } => Some(outcome),
            Self::Failed { .. } | Self::Indeterminate { .. } => None,
        }
    }

    /// The error, for the two non-success variants.
    #[must_use]
    pub fn error(&self) -> Option<&BrokerError> {
        match self {
            Self::Succeeded { .. } => None,
            Self::Failed { error } | Self::Indeterminate { error } => Some(error),
        }
    }
}

/// A broker result addressed back to the requester.
///
/// `replayed` is **response metadata**: it describes this delivery, not the
/// domain outcome, and is never persisted as part of the stored result. A
/// replayed response is byte-identical in `result` to the original.
///
/// Note: this struct cannot use `deny_unknown_fields`, because serde does not
/// support combining it with `#[serde(flatten)]`. Strictness is enforced where
/// it guards execution — on [`BrokerRequest`] and each args type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerResponse {
    /// Payload discriminator — must equal [`BROKER_RESULT_TYPE`].
    pub r#type: String,
    /// Protocol version — must equal [`BROKER_PROTOCOL_VERSION`].
    pub protocol_version: u16,
    /// Correlates with the originating [`BrokerRequest::request_id`].
    pub request_id: String,
    /// The terminal disposition.
    #[serde(flatten)]
    pub result: BrokerResult,
    /// True when this response replays a previously recorded outcome.
    #[serde(default, skip_serializing_if = "is_false")]
    pub replayed: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl BrokerResponse {
    /// Build a fresh (non-replayed) response for `request_id`.
    pub fn new(request_id: impl Into<String>, result: BrokerResult) -> Self {
        Self {
            r#type: BROKER_RESULT_TYPE.to_string(),
            protocol_version: BROKER_PROTOCOL_VERSION,
            request_id: request_id.into(),
            result,
            replayed: false,
        }
    }

    /// Mark this response as replaying a recorded outcome.
    #[must_use]
    pub fn replayed(mut self) -> Self {
        self.replayed = true;
        self
    }

    /// Validate discriminator, version, and request id.
    ///
    /// This checks only what a response asserts about itself. It cannot tell
    /// whether the response answers the request that was sent — for that, and
    /// for outcome-field validation, use [`Self::validate_for`]. A client should
    /// always prefer `validate_for`.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError::InvalidInput`] on a wrong `type`, an unsupported
    /// `protocolVersion`, a malformed `requestId`, an outcome with malformed
    /// identifiers, or an error code paired with the wrong status.
    pub fn validate(&self) -> Result<(), SdkError> {
        if self.r#type != BROKER_RESULT_TYPE {
            return Err(SdkError::InvalidInput(format!(
                "broker result type must be \"{BROKER_RESULT_TYPE}\", got \"{}\"",
                self.r#type
            )));
        }
        if self.protocol_version != BROKER_PROTOCOL_VERSION {
            return Err(SdkError::InvalidInput(format!(
                "unsupported broker protocolVersion {} (expected {BROKER_PROTOCOL_VERSION})",
                self.protocol_version
            )));
        }
        validate_request_id(&self.request_id)?;
        match &self.result {
            BrokerResult::Succeeded { outcome } => outcome.validate()?,
            // `OutcomeUnknown` is the one code that describes not knowing
            // whether side effects landed. Paired with `Failed` — which promises
            // they did not — it would be self-contradictory, so it is rejected
            // rather than left for each caller to notice.
            BrokerResult::Failed { error } if error.code == BrokerErrorCode::OutcomeUnknown => {
                return Err(SdkError::InvalidInput(
                    "outcome_unknown is only valid with an indeterminate status".into(),
                ));
            }
            BrokerResult::Failed { .. } | BrokerResult::Indeterminate { .. } => {}
        }
        Ok(())
    }

    /// Validate this response *as the answer to `request`*.
    ///
    /// A response that validates in isolation can still be the wrong answer: a
    /// host (or a confused proxy) could return a `message.post` success to a
    /// `channel.read`, and a caller matching on the outcome enum would quietly
    /// take the wrong branch. This is the check that makes such a response
    /// unusable instead of merely surprising, which is why
    /// [`BrokerClient::execute`] implementations are expected to run it before
    /// returning `Ok` and to report a failure as
    /// [`BrokerTransportError::MalformedResponse`].
    ///
    /// Signature verification of read results is deliberately not included; see
    /// [`BrokerMessage::verify`].
    ///
    /// # Errors
    ///
    /// Returns everything [`Self::validate`] returns, plus
    /// [`SdkError::InvalidInput`] when the `requestId` does not correlate or a
    /// success outcome names a different action than the request.
    pub fn validate_for(&self, request: &PreparedRequest) -> Result<(), SdkError> {
        self.validate()?;
        if self.request_id != request.request_id() {
            return Err(SdkError::InvalidInput(format!(
                "response requestId \"{}\" does not match request \"{}\"",
                self.request_id,
                request.request_id()
            )));
        }
        if let BrokerResult::Succeeded { outcome } = &self.result {
            let expected = request.action();
            if outcome.action() != expected {
                return Err(SdkError::InvalidInput(format!(
                    "response carries a {} outcome for a {} request",
                    outcome.action().as_str(),
                    expected.as_str()
                )));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
