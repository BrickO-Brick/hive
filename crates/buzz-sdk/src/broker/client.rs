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

use super::{BrokerResponse, PreparedRequest};

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
    /// sent — wrong `requestId`, wrong action, or a malformed outcome.
    ///
    /// See [`BrokerResponse::validate_for`].
    #[error("malformed broker response: {0}")]
    MalformedResponse(String),
}

/// A future returned by [`BrokerClient::execute`].
///
/// Spelled as a boxed future rather than `async fn` in the trait because this
/// trait must be object-safe: the harness holds one client and must not know
/// whether it talks to an in-process host or an HTTP one.
pub type BrokerFuture<'a> =
    Pin<Box<dyn Future<Output = Result<BrokerResponse, BrokerTransportError>> + Send + 'a>>;

/// Something that can execute broker requests.
///
/// One method, because there is one endpoint. Every operation is an
/// [`super::Action`] inside the request, so adding an action never changes this
/// trait and an implementation never needs updating to carry one.
///
/// The argument is a [`PreparedRequest`] rather than a typed request so that an
/// implementation cannot reserialize between attempts; see the
/// [`super::BrokerRequest`] retry contract.
///
/// Implementations must be usable as `dyn BrokerClient`.
pub trait BrokerClient: Send + Sync {
    /// Send `request`'s frozen bytes and return the host's terminal response.
    ///
    /// Implementations should call [`BrokerResponse::validate_for`] before
    /// returning `Ok`, so a caller never has to consider a response that does
    /// not answer its request.
    ///
    /// # Errors
    ///
    /// Returns [`BrokerTransportError`] when no usable response could be
    /// obtained. A host that answered — even to refuse — returns `Ok` with the
    /// verdict in [`BrokerResponse::result`].
    fn execute<'a>(&'a self, request: &'a PreparedRequest) -> BrokerFuture<'a>;
}
