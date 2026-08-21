//! The broker authority pipeline.
//!
//! One function owns the whole trusted path for a request:
//!
//! ```text
//! verified frame → authorize → validate → claim → dispatch → complete → response
//! ```
//!
//! It is deliberately a single Rust function rather than a chain of steps
//! coordinated from elsewhere. Every stage boundary is a place where a caller
//! could otherwise substitute its own answer for "who is asking" or "has this
//! already run", and a crash between two coordinated steps is a side effect
//! nobody recorded.
//!
//! # What this module does not decide
//!
//! It does not verify signatures or decrypt frames — that already happened, and
//! its result arrives as [`VerifiedRequest`], which can only be built from
//! transport-derived identity. It does not implement capabilities either;
//! those are [`CapabilityHandler`]s.

use buzz_sdk_pkg::broker::{
    BrokerError, BrokerErrorCode, BrokerRequest, BrokerResponse, BrokerResult, Capability,
    CapabilityOutcome,
};

use super::store::{self, ClaimOutcome, ExecutionKey, ExecutionState};

/// A request whose frame has already been verified and decrypted.
///
/// Constructing this type is the assertion that `owner_pubkey`,
/// `requester_pubkey`, and `relay_scope` came from the **verified transport**,
/// not from the request body. Nothing in [`BrokerRequest`] can influence them,
/// which is what prevents a signer from naming someone else as owner.
pub struct VerifiedRequest {
    /// Owner whose credentials back this host.
    pub owner_pubkey: String,
    /// Verified signer of the frame.
    pub requester_pubkey: String,
    /// Relay the frame arrived on.
    pub relay_scope: String,
    /// The exact decrypted payload bytes, used for the idempotency digest.
    pub payload: Vec<u8>,
}

/// Whether a requester may invoke a capability.
///
/// Base authentication (a verified signer, a real owner binding) is the
/// broker's job and has happened before this point. This trait is the
/// *capability scope* decision, which is domain policy: channel membership, for
/// instance, is an `agents.*` rule rather than something the broker asserts
/// about every capability it might ever host.
pub trait Authorizer {
    /// Authorize `request` for `capability`, or explain the refusal.
    fn authorize(
        &self,
        request: &VerifiedRequest,
        capability: Capability,
        parsed: &BrokerRequest,
    ) -> Result<(), BrokerError>;
}

/// The outcome of running one capability.
///
/// `Failed` asserts no side effects persisted. `Indeterminate` asserts nothing:
/// a handler returns it when it cannot tell, and the broker records it so the
/// request is never silently retried.
pub enum HandlerOutcome {
    /// Completed, with this outcome.
    Succeeded(CapabilityOutcome),
    /// Did not complete; no side effects persisted.
    Failed(BrokerError),
    /// Whether side effects persisted is unknown.
    Indeterminate(BrokerError),
}

/// One broker capability implementation.
pub trait CapabilityHandler {
    /// Execute the capability.
    ///
    /// Called at most once per idempotency key. A handler that mutates in
    /// several phases and cannot report which completed must return
    /// [`HandlerOutcome::Indeterminate`] rather than guess.
    fn execute(&self, request: &VerifiedRequest, parsed: &BrokerRequest) -> HandlerOutcome;
}

/// Resolves a capability name to its handler.
pub trait CapabilityRegistry {
    /// The handler for `capability`, or `None` when this host does not offer it.
    fn handler(&self, capability: Capability) -> Option<&dyn CapabilityHandler>;
}

/// Everything the pipeline needs that is not the request itself.
pub struct BrokerContext<'a> {
    /// Capability scope policy.
    pub authorizer: &'a dyn Authorizer,
    /// Capability implementations.
    pub registry: &'a dyn CapabilityRegistry,
    /// Durable execution log.
    pub conn: &'a mut rusqlite::Connection,
    /// Current unix time, injected so tests are not clock-dependent.
    pub now: i64,
}

/// Run one broker request end to end and produce the response to deliver.
///
/// Returns `Err` only for a host fault that leaves no deliverable response
/// (a database that cannot be reached, say). Every refusal a requester should
/// hear about — invalid, unauthorized, conflicting, interrupted — comes back as
/// an `Ok` response describing it.
pub fn execute(
    request: &VerifiedRequest,
    ctx: BrokerContext<'_>,
) -> Result<BrokerResponse, String> {
    // Bound and hash the payload before parsing it. The digest is over the
    // exact bytes received, so a retry that resends them matches without any
    // canonical encoding having to be agreed on.
    let digest = match super::request_digest(&request.payload) {
        Ok(digest) => digest,
        Err(error) => {
            return Ok(BrokerResponse::new(
                UNKNOWN_REQUEST_ID,
                BrokerResult::failed(BrokerError::invalid_request(error)),
            ))
        }
    };

    let parsed: BrokerRequest = match serde_json::from_slice(&request.payload) {
        Ok(parsed) => parsed,
        Err(error) => {
            // Unparseable: there is no trustworthy request id to echo, and
            // inventing one would let a malformed frame address someone
            // else's execution record.
            return Ok(BrokerResponse::new(
                UNKNOWN_REQUEST_ID,
                BrokerResult::failed(BrokerError::invalid_request(format!(
                    "malformed broker request: {error}"
                ))),
            ));
        }
    };

    let request_id = parsed.request_id.clone();
    if let Err(error) = parsed.validate() {
        return Ok(BrokerResponse::new(
            &request_id,
            BrokerResult::failed(BrokerError::invalid_request(error.to_string())),
        ));
    }

    let capability = parsed.capability();

    // Authorize before claiming: a refused request must leave no trace that
    // could later be replayed as though it had been accepted.
    if let Err(error) = ctx.authorizer.authorize(request, capability, &parsed) {
        return Ok(BrokerResponse::new(
            &request_id,
            BrokerResult::failed(error),
        ));
    }

    let Some(handler) = ctx.registry.handler(capability) else {
        return Ok(BrokerResponse::new(
            &request_id,
            BrokerResult::failed(BrokerError::new(
                BrokerErrorCode::UnknownCapability,
                format!("this host does not offer {}", capability.as_str()),
            )),
        ));
    };

    let key = ExecutionKey {
        relay_scope: store::normalized_relay_scope(&request.relay_scope).to_string(),
        owner_pubkey: request.owner_pubkey.clone(),
        requester_pubkey: request.requester_pubkey.clone(),
        capability: capability.as_str().to_string(),
        request_id: request_id.clone(),
    };

    match store::claim(ctx.conn, &key, &digest, parsed.capability_version, ctx.now)? {
        ClaimOutcome::Claimed => {}
        ClaimOutcome::Replay(record) => {
            return Ok(replay_response(&request_id, record.result_json.as_deref()))
        }
        ClaimOutcome::Interrupted(_) => {
            // A previous attempt started and never reported. Side effects may
            // exist, so this is reported rather than retried.
            return Ok(BrokerResponse::new(
                &request_id,
                BrokerResult::indeterminate(BrokerError::new(
                    BrokerErrorCode::OutcomeUnknown,
                    "a previous attempt at this request did not complete; \
                     its effects are unknown and it will not be retried automatically",
                )),
            ));
        }
        ClaimOutcome::DigestConflict { .. } => {
            return Ok(BrokerResponse::new(
                &request_id,
                BrokerResult::failed(BrokerError::new(
                    BrokerErrorCode::RequestIdConflict,
                    "this requestId was already used for a different request; \
                     retry with the identical payload or choose a new requestId",
                )),
            ));
        }
    }

    // The row is now `executing`. Everything after this point must reach
    // `complete`, or the next attempt correctly reports `indeterminate`.
    let result = match handler.execute(request, &parsed) {
        HandlerOutcome::Succeeded(outcome) => BrokerResult::succeeded(outcome),
        HandlerOutcome::Failed(error) => BrokerResult::failed(error),
        HandlerOutcome::Indeterminate(error) => BrokerResult::indeterminate(error),
    };

    let state = match &result {
        BrokerResult::Succeeded { .. } => ExecutionState::Succeeded,
        BrokerResult::Failed { .. } => ExecutionState::Failed,
        BrokerResult::Indeterminate { .. } => ExecutionState::Indeterminate,
    };
    let result_json = serde_json::to_string(&result)
        .map_err(|error| format!("failed to encode broker result: {error}"))?;
    store::complete(ctx.conn, &key, state, &result_json, ctx.now)?;

    Ok(BrokerResponse::new(&request_id, result))
}

/// Request id used when the payload is too malformed to yield one.
const UNKNOWN_REQUEST_ID: &str = "unknown";

/// Rebuild a response from a stored terminal result.
///
/// A row that is terminal but has no decodable result cannot be re-executed —
/// its side effects already happened — so it degrades to `indeterminate`.
fn replay_response(request_id: &str, result_json: Option<&str>) -> BrokerResponse {
    let stored = result_json.and_then(|json| serde_json::from_str::<BrokerResult>(json).ok());
    match stored {
        Some(result) => BrokerResponse::new(request_id, result).replayed(),
        None => BrokerResponse::new(
            request_id,
            BrokerResult::indeterminate(BrokerError::new(
                BrokerErrorCode::OutcomeUnknown,
                "this request already ran, but its recorded outcome could not be read",
            )),
        )
        .replayed(),
    }
}

#[cfg(test)]
mod tests;
