//! Client trait and HTTP binding for the broker contract.
//!
//! # HTTP binding
//!
//! ```text
//! POST /v1/action
//! Authorization: Bearer <opaque session credential>
//! Content-Type: application/json
//!
//! <PreparedRequest::body(), verbatim>
//! ```
//!
//! The response body is a [`BrokerResponse`] as JSON. Every terminal
//! disposition the *host* reached — including [`super::BrokerResult::Failed`],
//! and including a rejected credential — is a well-formed envelope returned with
//! `200`, because the verdict lives in `status` and a second copy in the status
//! line could only ever disagree with it.
//!
//! Both directions follow one JSON rule worth stating at the binding, since it
//! constrains how an implementer configures a serializer: an optional member
//! means absent by being **omitted**, and an explicit `null` is rejected. See
//! [the contract docs](super#optional-members-omission-is-the-only-spelling-of-absence).
//!
//! A client must nonetheless **attempt to parse an envelope regardless of HTTP
//! status**. A host or intermediary may map dispositions onto conventional
//! statuses for observability or for middleware that cannot read bodies; if a
//! valid envelope is present, it is the answer and the status line is
//! decoration. Only when no envelope can be parsed does the status matter, and
//! then only as detail for an operator: see [`BrokerTransportError`].
//!
//! # The credential
//!
//! The credential is **opaque to this contract**. It is a bearer token the agent
//! received at startup and can only replay; it is not a key, not a signature,
//! and not derived from anything the agent holds.
//!
//! A rejected credential is a host verdict, not a transport failure: it arrives
//! as `Failed` with [`super::BrokerErrorCode::Unauthenticated`], which carries
//! the promise every `Failed` carries — the action did not run. Modelling it as
//! a transport error would have thrown that knowledge away and told the caller
//! to reconcile something that provably never happened.
//!
//! Binding a credential to a specific (agent, conversation) pair — so that a
//! leaked token cannot act as a different agent or outside the conversation it
//! was issued for — **is the host's concern**. This contract documents the
//! expectation and cannot enforce it: the request body carries no requester and
//! no scope, precisely so the host's binding is the only thing that decides
//! authority. A scope field here would be a claim the host must ignore.
//!
//! Since the credential is the whole of the agent's authority, transport
//! confidentiality is not optional. A host serving this over anything but a
//! loopback socket or TLS is publishing its agents' authority.

use std::future::Future;
use std::pin::Pin;

use super::{BrokerResponse, BrokerResult, PreparedRequest};

/// Path of the single broker endpoint.
pub const BROKER_ACTION_PATH: &str = "/v1/action";

/// Header carrying the opaque session credential, as `Bearer <credential>`.
pub const BROKER_CREDENTIAL_HEADER: &str = "authorization";

/// No usable [`BrokerResponse`] was obtained, so the request's fate is unknown.
///
/// Every variant means the same thing to a caller: nothing can be concluded
/// about side effects, and the only safe next step is to retry the identical
/// bytes (which the host will deduplicate) or to reconcile by reading state.
/// The variants differ only in what to tell an operator.
///
/// Host verdicts never appear here — not even a rejected credential, which is
/// [`super::BrokerErrorCode::Unauthenticated`] inside a `Failed` envelope. This
/// type is strictly for the absence of an answer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BrokerTransportError {
    /// The host could not be reached, or the connection failed mid-request.
    #[error("broker unreachable: {0}")]
    Unreachable(String),
    /// An HTTP response arrived carrying no parseable envelope.
    ///
    /// Typically an intermediary answering instead of the host: a proxy `401`,
    /// a `404` for a missing route, a `502`. The status is recorded for
    /// operators and carries no contractual meaning — an intermediary's `401`
    /// does not prove the host never ran the action.
    #[error("no broker envelope in HTTP {status} response: {detail}")]
    NoEnvelope {
        /// The HTTP status observed.
        status: u16,
        /// Operator-facing detail about what arrived instead.
        detail: String,
    },
    /// An envelope arrived but did not validate against the request that was
    /// sent — wrong `requestId`, wrong action, a malformed outcome, or a status
    /// contradicting its own error code.
    ///
    /// Produced by [`ValidatedResponse::validate`], which every
    /// [`BrokerClientExt::execute`] call runs. A host that answers something
    /// other than what was asked has given no verdict at all, which is why this
    /// is a transport failure rather than a `Failed` result.
    #[error("malformed broker response: {0}")]
    MalformedResponse(String),
}

/// A future returned by [`BrokerClient::send`].
///
/// Spelled as a boxed future rather than `async fn` in the trait because this
/// trait must be object-safe: the harness holds one client and must not know
/// whether it talks to an in-process host or an HTTP one.
pub type BrokerFuture<'a> =
    Pin<Box<dyn Future<Output = Result<BrokerResponse, BrokerTransportError>> + Send + 'a>>;

/// A future returned by [`BrokerClientExt::execute`].
pub type ValidatedFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ValidatedResponse, BrokerTransportError>> + Send + 'a>>;

/// A host response that has been checked against the request it answers.
///
/// The only way to obtain one is [`ValidatedResponse::validate`], which is what
/// [`BrokerClientExt::execute`] calls. That is the point: correlation is not
/// advice an implementation may skip, because a caller using `execute` cannot be
/// handed anything else, and an implementation cannot produce this type without
/// passing the request it is answering.
///
/// [`BrokerResponse::validate_for`] remains public for a host validating its own
/// output, but a client never has to remember to call it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedResponse(BrokerResponse);

impl ValidatedResponse {
    /// Check `response` against the request it claims to answer.
    ///
    /// # Errors
    ///
    /// Returns [`BrokerTransportError::MalformedResponse`] when the response
    /// does not correlate, carries an outcome for a different action, asserts a
    /// malformed identifier, or pairs a status with a code that contradicts it.
    /// A response that fails here is not a host verdict — nothing can be
    /// concluded about side effects from it.
    pub fn validate(
        response: BrokerResponse,
        request: &PreparedRequest,
    ) -> Result<Self, BrokerTransportError> {
        response
            .validate_for(request)
            .map_err(|e| BrokerTransportError::MalformedResponse(e.to_string()))?;
        Ok(Self(response))
    }

    /// The terminal disposition the host reached.
    #[must_use]
    pub fn result(&self) -> &BrokerResult {
        &self.0.result
    }

    /// The correlated `requestId`.
    #[must_use]
    pub fn request_id(&self) -> &str {
        &self.0.request_id
    }

    /// Whether the host replayed a previously recorded outcome.
    #[must_use]
    pub fn replayed(&self) -> bool {
        self.0.replayed
    }

    /// The underlying envelope, for logging or re-serialization.
    #[must_use]
    pub fn envelope(&self) -> &BrokerResponse {
        &self.0
    }

    /// Consume this wrapper, yielding the validated envelope.
    #[must_use]
    pub fn into_envelope(self) -> BrokerResponse {
        self.0
    }
}

/// Permission to call [`BrokerClient::send`], which only
/// [`BrokerClientExt::execute`] can mint.
///
/// This is what makes validation *structurally* the only door rather than the
/// recommended one. `send` must be public — an out-of-crate implementation has
/// to define it — but a caller must not be able to invoke it and receive an
/// uncorrelated envelope. A token with a private field satisfies both: any crate
/// can accept one in a signature, only this module can construct one, and
/// `execute` constructs it on the caller's behalf.
///
/// An implementation should ignore its value; it carries no data.
///
/// What this does not do: an implementation, having legitimately received a
/// token, could stash the envelope it saw in its own state and expose it. That
/// is not a bypass worth designing against — code that does it has deliberately
/// implemented a transport in order to exfiltrate its own input, which is a
/// different thing from a caller forgetting to correlate a response. Closing the
/// accidental path is the goal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Dispatch(());

/// Something that can execute broker requests.
///
/// One method, because there is one endpoint. Every operation is an
/// [`super::Action`] inside the request, so adding an action never changes this
/// trait and an implementation never needs updating to carry one.
///
/// This trait is the **transport primitive**: frozen bytes out, one envelope
/// back. It is not the caller's interface. Callers use
/// [`BrokerClientExt::execute`], which is where response correlation happens,
/// which no implementation can replace, and which holds the only [`Dispatch`]
/// token `send` will accept.
///
/// Implementations must be usable as `dyn BrokerClient`.
pub trait BrokerClient: Send + Sync {
    /// Send `request`'s frozen bytes and return whatever envelope came back.
    ///
    /// An implementation's whole job is transport: send [`PreparedRequest::body`]
    /// verbatim, parse an envelope regardless of HTTP status, and return it
    /// unjudged. It must not attempt to interpret the verdict, and it need not
    /// correlate the response — [`BrokerClientExt::execute`] does that for every
    /// implementation.
    ///
    /// The [`Dispatch`] argument is why this cannot be called directly by a
    /// caller outside this module; that is deliberate.
    ///
    /// # Errors
    ///
    /// Returns [`BrokerTransportError`] when no envelope could be obtained or
    /// parsed. A host that answered — even to refuse — returns `Ok`, with the
    /// verdict in [`BrokerResponse::result`].
    fn send<'a>(&'a self, request: &'a PreparedRequest, dispatch: Dispatch) -> BrokerFuture<'a>;
}

/// The caller-facing half of [`BrokerClient`]: send, then validate.
///
/// Blanket-implemented for every [`BrokerClient`], including `dyn BrokerClient`,
/// and **not overridable** — coherence forbids a second implementation, so there
/// is exactly one definition of what validating a response means and no client
/// can weaken it.
pub trait BrokerClientExt: BrokerClient {
    /// Send `request` and return a response already checked against it.
    ///
    /// # Errors
    ///
    /// Returns [`BrokerTransportError`] when no envelope arrived, or
    /// [`BrokerTransportError::MalformedResponse`] when the envelope that
    /// arrived does not answer `request`. Both mean the same thing to a caller:
    /// no verdict, so nothing is known about side effects.
    fn execute<'a>(&'a self, request: &'a PreparedRequest) -> ValidatedFuture<'a>;
}

impl<C: BrokerClient + ?Sized> BrokerClientExt for C {
    fn execute<'a>(&'a self, request: &'a PreparedRequest) -> ValidatedFuture<'a> {
        Box::pin(async move {
            let response = self.send(request, Dispatch(())).await?;
            ValidatedResponse::validate(response, request)
        })
    }
}
