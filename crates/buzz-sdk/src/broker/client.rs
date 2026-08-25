//! Client trait and HTTP binding for the broker contract.
//!
//! # HTTP binding
//!
//! ```text
//! POST /v1/action
//! Authorization: Bearer <opaque session credential>
//! Content-Type: application/json
//!
//! <BrokerRequest as JSON>
//! ```
//!
//! The response body is a [`BrokerResponse`] as JSON. Every terminal
//! disposition — including [`super::BrokerResult::Failed`] — is a well-formed
//! envelope, so a host that has an answer returns `200` and puts the verdict in
//! `status`. HTTP status codes carry no information the envelope does not, and a
//! client must read the envelope rather than the status line.
//!
//! A non-2xx response is only meaningful when there is *no* envelope: the
//! credential was rejected before dispatch, the path does not exist, or an
//! intermediary answered instead of the host. Those surface as
//! [`BrokerTransportError`], which is not a `Failed` result — it means no answer
//! arrived, so the caller learned nothing about side effects and may retry with
//! identical bytes per the [`BrokerRequest`] retry contract.
//!
//! # The credential
//!
//! The credential is **opaque to this contract**. It is a bearer token the agent
//! received at startup and can only replay; it is not a key, not a signature,
//! and not derived from anything the agent holds.
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

use super::{BrokerRequest, BrokerResponse};

/// Path of the single broker endpoint.
pub const BROKER_ACTION_PATH: &str = "/v1/action";

/// Header carrying the opaque session credential, as `Bearer <credential>`.
pub const BROKER_CREDENTIAL_HEADER: &str = "authorization";

/// A transport-level failure: no [`BrokerResponse`] was obtained.
///
/// Distinct from [`super::BrokerResult::Failed`], which is a host's considered
/// verdict. These variants all mean the same thing to a caller — the request's
/// fate is unknown — and differ only in what to tell an operator.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BrokerTransportError {
    /// The host could not be reached, or the connection failed mid-request.
    #[error("broker unreachable: {0}")]
    Unreachable(String),
    /// The credential was rejected before the host produced an envelope.
    #[error("broker rejected the session credential")]
    CredentialRejected,
    /// A response arrived but was not a well-formed [`BrokerResponse`].
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
/// Implementations must be usable as `dyn BrokerClient`.
pub trait BrokerClient: Send + Sync {
    /// Execute `request` and return the host's terminal response.
    ///
    /// # Errors
    ///
    /// Returns [`BrokerTransportError`] when no response could be obtained.
    /// A host that answered — even to refuse — returns `Ok` with the verdict in
    /// [`BrokerResponse::result`].
    fn execute<'a>(&'a self, request: &'a BrokerRequest) -> BrokerFuture<'a>;
}
