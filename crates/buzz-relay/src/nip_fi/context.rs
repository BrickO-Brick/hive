//! Origin-sealed request context for NIP-FI final admission.
//!
//! [`SealedRequestContext`] can only be constructed by [`seal_context`], which
//! is module-private to `buzz-relay::nip_fi`.  External crates cannot name or
//! call either path.

use buzz_auth::{
    nip_fi::{
        OperationIntent, ProofTransport, ProtectedObjectKind, RouteCapability, VerifiedAssertion,
    },
    AuthService,
};
use chrono::{DateTime, Utc};
use nostr::PublicKey;
use uuid::Uuid;

/// Origin-sealed server-resolved request context, carrying the full
/// [`VerifiedAssertion`] for revalidation inside the final transaction.
///
/// All fields are private; construction is only possible via [`seal_context`]
/// inside this module.  The `FederatedAssertionVerifier` is not stored here —
/// it is passed into `commit_admission` so revalidation happens inside the
/// SERIALIZABLE transaction boundary.
pub(crate) struct SealedRequestContext {
    /// Nostr-proof transport that bound the actor.
    pub(super) transport: ProofTransport,
    /// Full 32-byte event ID of the NIP-42 AUTH or NIP-98 proof event.
    pub(super) proof_event_id: [u8; 32],
    /// Freshness deadline of the proof.
    pub(super) proof_expires_at: DateTime<Utc>,
    /// Server-resolved 32-byte Nostr public key of the proven actor.
    pub(super) actor: PublicKey,
    /// Community (tenant) UUID.
    pub(super) community_id: Uuid,
    /// Server-resolved canonical route capability.
    pub(super) capability: RouteCapability,
    /// Protected-object kind.
    pub(super) object_kind: ProtectedObjectKind,
    /// Operation intent.
    pub(super) intent: OperationIntent,
    /// Server-resolved 32-byte protected-object key.
    pub(super) object_key: [u8; 32],
    /// Object version / fingerprint witness at the time of the request.
    pub(super) object_version: Option<i64>,
    /// WebSocket connection UUID.
    pub(super) conn_id: Uuid,
    /// NIP-42 challenge string.
    pub(super) challenge: String,
    /// Canonical relay URL.
    pub(super) relay_url: String,
    /// The full verified assertion — carried for revalidation in the final
    /// transaction.  Contains `RevalidationDependencies` with the confidential
    /// compact JWS, key identity, snapshot generation, and hard deadline.
    pub(super) verified_assertion: VerifiedAssertion,
    /// Operation UUID for this request.
    pub(super) operation_id: Uuid,
}

impl std::fmt::Debug for SealedRequestContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SealedRequestContext")
            .field("transport", &self.transport)
            .field("conn_id", &self.conn_id)
            .field("community_id", &self.community_id)
            .field("capability", &self.capability)
            .field("object_kind", &self.object_kind)
            .field("operation_id", &self.operation_id)
            .finish_non_exhaustive()
    }
}

/// Seal a request context by performing NIP-42 proof verification and binding
/// the result to all server-resolved coordinates.
///
/// This is the only construction path for [`SealedRequestContext`].  Because
/// this function is `pub(super)` and `SealedRequestContext` has private
/// fields, external crates cannot produce a valid context through any path.
///
/// # Parameters
///
/// - `auth_service` — the relay's auth service.
/// - `auth_event` — the raw NIP-42 AUTH event (Schnorr + NIP-42 rules).
/// - `expected_challenge` — the server-generated challenge.
/// - `relay_url` — canonical relay URL for this connection.
/// - `verified_assertion` — the `VerifiedAssertion` from a prior call to
///   `FederatedAssertionVerifier::verify`.  Carried verbatim into the context
///   for revalidation inside `commit_admission`.
/// - The remaining parameters are server-resolved routing coordinates.
///
/// # Errors
///
/// Returns `buzz_auth::AuthError` if Schnorr verification fails or NIP-42
/// rules are violated.
#[allow(clippy::too_many_arguments)]
pub(super) async fn seal_context(
    auth_service: &AuthService,
    auth_event: nostr::Event,
    expected_challenge: &str,
    relay_url: &str,
    transport: ProofTransport,
    proof_event_id: [u8; 32],
    proof_expires_at: DateTime<Utc>,
    community_id: Uuid,
    capability: RouteCapability,
    object_kind: ProtectedObjectKind,
    intent: OperationIntent,
    object_key: [u8; 32],
    object_version: Option<i64>,
    conn_id: Uuid,
    verified_assertion: VerifiedAssertion,
    operation_id: Uuid,
) -> Result<(buzz_auth::AuthContext, SealedRequestContext), buzz_auth::AuthError> {
    let auth_ctx = auth_service
        .verify_auth_event(auth_event.clone(), expected_challenge, relay_url)
        .await?;
    let actor = auth_event.pubkey;
    let ctx = SealedRequestContext {
        transport,
        proof_event_id,
        proof_expires_at,
        actor,
        community_id,
        capability,
        object_kind,
        intent,
        object_key,
        object_version,
        conn_id,
        challenge: expected_challenge.to_string(),
        relay_url: relay_url.to_string(),
        verified_assertion,
        operation_id,
    };
    Ok((auth_ctx, ctx))
}

impl SealedRequestContext {
    /// Seal a request context directly from server-resolved coordinates,
    /// bypassing the `AuthService` round-trip that `seal_context` requires.
    ///
    /// The ingest handler already verified the NIP-42 AUTH event and resolved
    /// the actor pubkey — this path re-uses that verification rather than
    /// re-running it.  Called only from `NipFiVerifierImpl::commit_kind9_admission`
    /// where the auth handshake has already completed.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn seal_inline(
        transport: ProofTransport,
        proof_event_id: [u8; 32],
        proof_expires_at: DateTime<Utc>,
        actor: nostr::PublicKey,
        community_id: Uuid,
        capability: RouteCapability,
        object_kind: ProtectedObjectKind,
        intent: OperationIntent,
        object_key: [u8; 32],
        object_version: Option<i64>,
        conn_id: Uuid,
        challenge: String,
        relay_url: String,
        verified_assertion: VerifiedAssertion,
        operation_id: Uuid,
    ) -> Self {
        Self {
            transport,
            proof_event_id,
            proof_expires_at,
            actor,
            community_id,
            capability,
            object_kind,
            intent,
            object_key,
            object_version,
            conn_id,
            challenge,
            relay_url,
            verified_assertion,
            operation_id,
        }
    }
}

#[cfg(test)]
impl SealedRequestContext {
    /// Build a minimal sealed context for integration tests.
    ///
    /// **Test-only.  Never call in production code.**
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn for_test(
        actor: nostr::PublicKey,
        community_id: Uuid,
        capability: RouteCapability,
        object_kind: ProtectedObjectKind,
        intent: OperationIntent,
        object_key: [u8; 32],
        conn_id: Uuid,
        challenge: &str,
        relay_url: &str,
        proof_event_id: [u8; 32],
        proof_expires_at: DateTime<Utc>,
        verified_assertion: VerifiedAssertion,
        operation_id: Uuid,
    ) -> Self {
        Self {
            transport: ProofTransport::Nip42WebSocket,
            proof_event_id,
            proof_expires_at,
            actor,
            community_id,
            capability,
            object_kind,
            intent,
            object_key,
            object_version: None,
            conn_id,
            challenge: challenge.to_string(),
            relay_url: relay_url.to_string(),
            verified_assertion,
            operation_id,
        }
    }
}
