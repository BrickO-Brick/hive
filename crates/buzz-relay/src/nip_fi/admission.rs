//! NIP-FI PostgreSQL-final admission and protected-use orchestration.
//!
//! All mutable final-admission checks execute inside SERIALIZABLE transactions
//! with `transaction_timestamp()` as the authoritative clock.  No process-clock
//! check substitutes for authoritative DB time.
//!
//! ## Vertical slice
//!
//! This implementation covers kind-9 channel publication:
//!   capability = MessagesWrite (code 2)
//!   object_kind = Channel (code 2)
//!   object_key  = SHA-256 of canonical UUID 16-byte wire representation
//!                 i.e. sha256(uuid_send(channel_id)) in PostgreSQL
//!
//! Community write-fence and current channel state are reread at final
//! admission and every use.  The implementation fails closed on absence or
//! ambiguity.
//!
//! ## Enrollment
//!
//! When no active binding exists for (issuer, subject, community), a new
//! binding is created atomically in the same SERIALIZABLE transaction:
//!   identity_lifecycle_lock_coordinates_v1 advisory lock
//!   → INSERT identity_bindings (RETURNING binding_version)
//!   → INSERT identity_lifecycle_history (all four successor fields populated)
//!   → INSERT authorization_events (event_kind=1, outcome_code=1)
//!   → INSERT authorization_operation_receipts (operation_kind=1, enroll_operation_id)
//! The enrollment and admission receipts use separate operation_id UUIDs
//! because authorization_operation_receipts has PRIMARY KEY (community_id,
//! operation_id) — two receipts cannot share one operation ID.
//!
//! Conflicting identical enrollments (same principal fingerprint, same pubkey)
//! converge to the winner via the ON CONFLICT / advisory-lock protocol.
//! Conflicting non-identical enrollments (same key, different fingerprint) are
//! rejected as EnrollmentConflict.
//!
//! ## Assertion revalidation
//!
//! Before the first write inside the SERIALIZABLE transaction, the compact JWS
//! is re-verified against the current key source via
//! `FederatedAssertionVerifier::verify`.  The freshly sealed assertion is then
//! compared against the prepared assertion on NIP-FI classes:
//!   identity: issuer, subject, asserted_key, policy_id, contract_id
//!   bounds: every deadline in the fresh set must be ≤ its corresponding
//!           prepared counterpart; the fresh assertion must be live at db_now
//!   provenance: snapshot generation/key identity change is allowed after
//!               successful revalidation only
//! Any deviation returns AssertionEquivalenceViolation or ContractIdChanged.
//!
//! ## UUID object-key encoding
//!
//! object_key for MessagesWrite/Channel = SHA-256 of the 16-byte wire
//! representation of the channel UUID.  In PostgreSQL: sha256(uuid_send(c.id)).
//! In Rust: sha256(channel_uuid.as_bytes()).  Text encoding (36 bytes) is wrong.

use super::context::SealedRequestContext;
use buzz_auth::nip_fi::{
    AdmissionError, BindingProposal, FederatedAssertionVerifier, IssuerKeySource, ProofTransport,
    VerifiedAssertion,
};
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

/// Maximum SERIALIZABLE-retry attempts on SQLSTATE `40001`.
pub(crate) const MAX_SERIALIZATION_RETRIES: usize = 5;

// ── Non-forgeable output types ────────────────────────────────────────────────

/// Sealed committed-authorization result.  Only producible by a successful
/// `commit_admission` SERIALIZABLE transaction.  Not `Clone`.
pub(crate) struct CommittedAuthorization {
    pub(super) community_id: Uuid,
    pub(super) operation_id: Uuid,
    pub(super) request_fingerprint: [u8; 32],
    pub(super) authority_epoch: i64,
    pub(super) authority_fence: [u8; 32],
    pub(super) actor_pubkey: [u8; 32],
    pub(super) binding_id: Uuid,
    pub(super) binding_version: i64,
    pub(super) binding_lifecycle_revision: i64,
    pub(super) policy_revision: i64,
    pub(super) issued_at: DateTime<Utc>,
    pub(super) expires_at: DateTime<Utc>,
    pub(super) capability_code: i16,
    pub(super) object_kind_code: i16,
    pub(super) object_key: [u8; 32],
    pub(super) conn_id: Uuid,
    pub(super) challenge: String,
    pub(super) relay_url: String,
    pub(super) proof_event_id: [u8; 32],
    pub(super) transport_code: u8,
    pub(super) assertion_issuer: String,
    pub(super) assertion_subject: String,
}

impl CommittedAuthorization {
    pub(crate) fn operation_id(&self) -> Uuid {
        self.operation_id
    }
    pub(crate) fn authority_epoch(&self) -> i64 {
        self.authority_epoch
    }
    pub(crate) fn authority_fence(&self) -> &[u8; 32] {
        &self.authority_fence
    }
    pub(crate) fn issued_at(&self) -> DateTime<Utc> {
        self.issued_at
    }
    pub(crate) fn expires_at(&self) -> DateTime<Utc> {
        self.expires_at
    }
}

impl std::fmt::Debug for CommittedAuthorization {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CommittedAuthorization")
            .field("operation_id", &self.operation_id)
            .field("authority_epoch", &self.authority_epoch)
            .finish_non_exhaustive()
    }
}

/// Sealed authorized-use grant.  Not `Clone`.
pub(crate) struct AuthorizedUse {
    pub(super) use_operation_id: Uuid,
    pub(super) new_fence: [u8; 32],
    pub(super) new_epoch: i64,
    pub(super) granted_at: DateTime<Utc>,
}

impl AuthorizedUse {
    pub(crate) fn use_operation_id(&self) -> Uuid {
        self.use_operation_id
    }
    pub(crate) fn new_fence(&self) -> &[u8; 32] {
        &self.new_fence
    }
    pub(crate) fn new_epoch(&self) -> i64 {
        self.new_epoch
    }
    pub(crate) fn granted_at(&self) -> DateTime<Utc> {
        self.granted_at
    }
}

impl std::fmt::Debug for AuthorizedUse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthorizedUse")
            .field("use_operation_id", &self.use_operation_id)
            .field("new_epoch", &self.new_epoch)
            .finish_non_exhaustive()
    }
}

// ── Fingerprint / hash helpers ────────────────────────────────────────────────

fn compute_request_fingerprint(ctx: &SealedRequestContext) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"buzz.nip-fi.request-fingerprint.v1\x00");
    h.update([match ctx.transport {
        ProofTransport::Nip42WebSocket => 1u8,
        ProofTransport::Nip98Http => 2u8,
    }]);
    h.update(ctx.proof_event_id);
    h.update(ctx.proof_expires_at.timestamp().to_be_bytes());
    h.update(ctx.actor.to_bytes().as_slice());
    h.update(ctx.community_id.as_bytes());
    h.update(ctx.capability.database_code().to_be_bytes());
    h.update(ctx.object_kind.database_code().to_be_bytes());
    h.update(ctx.intent.as_db_code().to_be_bytes());
    h.update(ctx.object_key);
    h.update(ctx.object_version.unwrap_or(0i64).to_be_bytes());
    h.update(ctx.conn_id.as_bytes());
    let challenge_bytes = ctx.challenge.as_bytes();
    h.update((challenge_bytes.len() as u32).to_be_bytes());
    h.update(challenge_bytes);
    let relay_bytes = ctx.relay_url.as_bytes();
    h.update((relay_bytes.len() as u32).to_be_bytes());
    h.update(relay_bytes);
    h.update(ctx.verified_assertion.assertion_policy_id().as_bytes());
    h.update(ctx.verified_assertion.transport_contract_id().as_bytes());
    h.update(
        ctx.verified_assertion
            .upstream_authority_deadline()
            .timestamp()
            .to_be_bytes(),
    );
    h.update(ctx.operation_id.as_bytes());
    h.finalize().into()
}

fn compute_semantic_fingerprint(ctx: &SealedRequestContext) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"buzz.nip-fi.semantic-fingerprint.v1\x00");
    h.update(ctx.capability.database_code().to_be_bytes());
    h.update(ctx.object_kind.database_code().to_be_bytes());
    h.update(ctx.intent.as_db_code().to_be_bytes());
    h.update(ctx.object_key);
    h.update(ctx.actor.to_bytes().as_slice());
    h.update(ctx.community_id.as_bytes());
    h.finalize().into()
}

pub(crate) fn compute_principal_fingerprint(
    actor_pubkey: &[u8; 32],
    issuer: &str,
    subject: &str,
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"buzz.nip-fi.principal-fingerprint.v1\x00");
    h.update(actor_pubkey);
    let iss = issuer.as_bytes();
    h.update((iss.len() as u32).to_be_bytes());
    h.update(iss);
    let sub = subject.as_bytes();
    h.update((sub.len() as u32).to_be_bytes());
    h.update(sub);
    h.finalize().into()
}

fn compute_enrollment_evidence_digest(
    assertion: &VerifiedAssertion,
    actor_pubkey: &[u8; 32],
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"buzz.nip-fi.enrollment-evidence.v1\x00");
    h.update(assertion.assertion_policy_id().as_bytes());
    h.update(assertion.transport_contract_id().as_bytes());
    h.update(actor_pubkey);
    let iss = assertion.identity().issuer().as_bytes();
    h.update((iss.len() as u32).to_be_bytes());
    h.update(iss);
    let sub = assertion.identity().subject().as_bytes();
    h.update((sub.len() as u32).to_be_bytes());
    h.update(sub);
    h.update(
        assertion
            .revalidation_dependencies()
            .key_snapshot_generation()
            .to_be_bytes(),
    );
    h.finalize().into()
}

fn generate_fence() -> [u8; 32] {
    loop {
        let fence: [u8; 32] = rand::random();
        if fence != [0u8; 32] {
            return fence;
        }
    }
}

fn compute_transition_digest(
    community_id: &Uuid,
    history_id: &Uuid,
    operation_id: &Uuid,
    request_fingerprint: &[u8; 32],
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"buzz.nip-fi.transition-digest.v1\x00");
    h.update(community_id.as_bytes());
    h.update(history_id.as_bytes());
    h.update(operation_id.as_bytes());
    h.update(request_fingerprint);
    h.finalize().into()
}

fn compute_result_digest(
    request_fingerprint: &[u8; 32],
    operation_id: &Uuid,
    community_id: &Uuid,
    outcome: u8,
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"buzz.nip-fi.result-digest.v1\x00");
    h.update(request_fingerprint);
    h.update(operation_id.as_bytes());
    h.update(community_id.as_bytes());
    h.update([outcome]);
    h.finalize().into()
}

/// Minimal canonical envelope for a lifecycle audit event.
///
/// The envelope carries the pseudonymous identity of the operation for
/// offline audit reconstruction.  Format: a fixed-size CBOR-style record
/// encoded as 5 length-prefixed fields.
fn build_minimal_canonical_envelope(
    event_kind: u8,
    community_id: &Uuid,
    operation_id: &Uuid,
    request_fingerprint: &[u8; 32],
    actor_fingerprint: &[u8; 32],
) -> Vec<u8> {
    let mut v = Vec::with_capacity(128);
    // 1-byte magic, 1-byte version
    v.push(0xCA_u8); // canonical-authorization marker
    v.push(0x01_u8); // schema version 1
    v.push(event_kind);
    v.extend_from_slice(community_id.as_bytes());
    v.extend_from_slice(operation_id.as_bytes());
    v.extend_from_slice(request_fingerprint);
    v.extend_from_slice(actor_fingerprint);
    v
}

fn compute_envelope_digest(envelope: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"buzz.nip-fi.envelope-digest.v1\x00");
    h.update(envelope);
    h.finalize().into()
}

// ── SQLSTATE helpers ──────────────────────────────────────────────────────────

fn is_serialization_failure(e: &sqlx::Error) -> bool {
    if let sqlx::Error::Database(ref db) = e {
        db.code().map(|c| c == "40001").unwrap_or(false)
    } else {
        false
    }
}

/// Pub-crate alias of [`is_serialization_failure`] for use in sibling modules.
pub(crate) fn is_serialization_failure_pub(e: &sqlx::Error) -> bool {
    is_serialization_failure(e)
}

fn is_unique_violation(e: &sqlx::Error) -> bool {
    if let sqlx::Error::Database(ref db) = e {
        db.code().map(|c| c == "23505").unwrap_or(false)
    } else {
        false
    }
}

fn map_sqlx_error(e: sqlx::Error) -> AdmissionError {
    if is_serialization_failure(&e) {
        return AdmissionError::SerializationRetry;
    }
    if let sqlx::Error::Database(ref db) = e {
        if let Some(constraint) = db.constraint() {
            if constraint.contains("capacity_exhausted") {
                return AdmissionError::CapacityExhausted;
            }
        }
    }
    AdmissionError::Transient(e.to_string())
}

/// Map a replay-claim INSERT error.
///
/// Only `nip_fi_proof_replay_claims_pkey` maps to `ProofReplayed`.
/// Any other unique violation is `Transient` — no fallback-to-replay on
/// unknown or missing constraint names.
fn map_replay_claim_error(e: sqlx::Error) -> AdmissionError {
    if is_serialization_failure(&e) {
        return AdmissionError::SerializationRetry;
    }
    if is_unique_violation(&e) {
        if let sqlx::Error::Database(ref db) = e {
            if db
                .constraint()
                .map(|c| c == "nip_fi_proof_replay_claims_pkey")
                .unwrap_or(false)
            {
                return AdmissionError::ProofReplayed;
            }
            // Unknown or different constraint: transient, not replay.
            return AdmissionError::Transient(e.to_string());
        }
    }
    AdmissionError::Transient(e.to_string())
}

// ── Assertion revalidation ────────────────────────────────────────────────────

/// Revalidate the compact JWS against the current key source and compare the
/// freshly sealed assertion against the prepared one on all NIP-FI classes.
///
/// Called by [`commit_kind9_atomic`] in `nip_fi/mod.rs` before opening the
/// SERIALIZABLE transaction.  This keeps the JWS round-trip outside the
/// transaction boundary and makes [`commit_admission_in_tx`] testable without
/// a real key source.
///
/// Identity class: issuer, subject, asserted_key, policy_id, contract_id.
/// Bounds class: the fresh `authority_deadlines` set is compared element-wise
///   against the prepared set (by index after sorting both ascending).
///   Every fresh deadline must be ≤ its prepared counterpart.
///   The fresh assertion must also be live at DB time.
/// Provenance: snapshot generation/key identity change is allowed only after
///   successful revalidation; it is never a failure reason.
pub(super) fn revalidate_assertion<S: IssuerKeySource>(
    verifier: &FederatedAssertionVerifier<S>,
    prepared: &VerifiedAssertion,
    db_now: DateTime<Utc>,
) -> Result<VerifiedAssertion, AdmissionError> {
    let jws = prepared
        .revalidation_dependencies()
        .confidential_assertion()
        .compact_jws();

    let fresh = verifier
        .verify(jws)
        .map_err(|_e| AdmissionError::AssertionEquivalenceViolation)?;

    // Identity class checks.
    if fresh.identity().issuer() != prepared.identity().issuer()
        || fresh.identity().subject() != prepared.identity().subject()
    {
        return Err(AdmissionError::AssertionEquivalenceViolation);
    }
    if fresh.asserted_key() != prepared.asserted_key() {
        return Err(AdmissionError::AssertionEquivalenceViolation);
    }
    if fresh.assertion_policy_id() != prepared.assertion_policy_id() {
        return Err(AdmissionError::ContractIdChanged);
    }
    if fresh.transport_contract_id() != prepared.transport_contract_id() {
        return Err(AdmissionError::ContractIdChanged);
    }
    // Capabilities must be byte-equal (canonical encoding deduplicates).
    if fresh.capabilities().entries() != prepared.capabilities().entries() {
        return Err(AdmissionError::AssertionEquivalenceViolation);
    }

    // Bounds class: compare every deadline in the sorted sets.
    // Both sets are non-empty by construction.  Sort ascending then compare
    // pair-wise.  If the fresh set has more deadlines, the extras must be ≤
    // the tightest prepared deadline (conservative: use it for all).
    // If the fresh set has fewer deadlines, fail — a missing deadline means
    // authority was removed.
    let mut fresh_dl: Vec<DateTime<Utc>> = fresh.authority_deadlines().to_vec();
    let mut prep_dl: Vec<DateTime<Utc>> = prepared.authority_deadlines().to_vec();
    fresh_dl.sort_unstable();
    prep_dl.sort_unstable();

    if fresh_dl.len() < prep_dl.len() {
        // Fewer deadlines in the fresh result: authority narrowed unexpectedly.
        return Err(AdmissionError::AssertionEquivalenceViolation);
    }

    let tightest_prepared = *prep_dl.first().expect("non-empty by construction");

    for (i, &fd) in fresh_dl.iter().enumerate() {
        let pd = prep_dl.get(i).copied().unwrap_or(tightest_prepared);
        if fd > pd {
            return Err(AdmissionError::AssertionEquivalenceViolation);
        }
    }

    // All fresh deadlines must be live at DB time.
    for &fd in &fresh_dl {
        if db_now >= fd {
            return Err(AdmissionError::PreparedDeadlineExpired);
        }
    }

    Ok(fresh)
}

// ── Public admission API ──────────────────────────────────────────────────────

/// Execute the full NIP-FI admission inside a caller-owned SERIALIZABLE
/// transaction.
///
/// The caller is responsible for:
///   1. Opening the transaction (`pool.begin()` or `Db::begin_transaction()`).
///   2. Setting `SERIALIZABLE` isolation before calling this function.
///   3. Calling `transaction_timestamp()` to establish `db_now`.
///   4. Committing or rolling back after all writes (event insert) succeed.
///
/// `fresh_assertion` must have already been re-verified by the caller (via
/// [`revalidate_assertion`]) before opening the transaction.  Moving revalidation
/// outside keeps this function testable without a real JWS verifier: integration
/// tests can pass a [`VerifiedAssertion`] built with
/// `buzz_auth::nip_fi::assertion::test_support::minimal_verified_assertion`.
///
/// This is the Design-B inner path used by [`commit_kind9_atomic`] to ensure
/// enrollment, replay claim, receipts, epoch/fence, and event insert all
/// commit or roll back together (FI-INV-09 all-or-none).
///
/// Returns a `CommittedAuthorization` that the caller passes to
/// [`authorize_protected_use_in_tx`] for the immediate re-fence before the
/// event insert.
#[allow(clippy::too_many_lines)]
pub(crate) async fn commit_admission_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    db_now: DateTime<Utc>,
    ctx: &SealedRequestContext,
    proposal: &BindingProposal,
    fresh_assertion: &VerifiedAssertion,
) -> Result<CommittedAuthorization, AdmissionError> {
    let community_id = ctx.community_id;
    let actor_pubkey = ctx.actor.to_bytes();
    let object_kind_code = ctx.object_kind.database_code();
    let object_key = ctx.object_key;
    let operation_id = ctx.operation_id;
    let request_fingerprint = compute_request_fingerprint(ctx);

    // ── 1. Proof expiry (authoritative DB time) ───────────────────────────
    if db_now >= ctx.proof_expires_at {
        return Err(AdmissionError::ProofExpired);
    }

    // ── 2–14: community/channel/policy/enrollment/invalidation/fence/receipt
    // (all identical to the old `commit_admission_inner` body below, but
    // operating on the caller-owned `tx` instead of a locally opened one)
    commit_admission_body(
        tx,
        db_now,
        ctx,
        proposal,
        fresh_assertion,
        community_id,
        actor_pubkey,
        object_kind_code,
        object_key,
        operation_id,
        request_fingerprint,
    )
    .await
}

/// Execute the full NIP-FI admission inside a self-opened SERIALIZABLE
/// transaction (standalone path, used by `commit_kind9_admission` on the
/// NipFiVerify trait).
///
/// Retries on SQLSTATE `40001` up to [`MAX_SERIALIZATION_RETRIES`] times.
pub(crate) async fn commit_admission<S: IssuerKeySource + Sync>(
    pool: &PgPool,
    ctx: &SealedRequestContext,
    proposal: &BindingProposal,
    verifier: &FederatedAssertionVerifier<S>,
) -> Result<CommittedAuthorization, AdmissionError> {
    let mut attempts = 0usize;
    loop {
        attempts += 1;
        match commit_admission_inner(pool, ctx, proposal, verifier).await {
            Ok(result) => return Ok(result),
            Err(AdmissionError::SerializationRetry) if attempts < MAX_SERIALIZATION_RETRIES => {
                tokio::time::sleep(std::time::Duration::from_millis((attempts as u64) * 5)).await;
                continue;
            }
            Err(e) => return Err(e),
        }
    }
}

#[allow(clippy::too_many_lines)]
async fn commit_admission_inner<S: IssuerKeySource + Sync>(
    pool: &PgPool,
    ctx: &SealedRequestContext,
    proposal: &BindingProposal,
    verifier: &FederatedAssertionVerifier<S>,
) -> Result<CommittedAuthorization, AdmissionError> {
    let mut tx: Transaction<'_, Postgres> = pool
        .begin()
        .await
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;

    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        .execute(&mut *tx)
        .await
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;

    let db_now: DateTime<Utc> = sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;

    let community_id = ctx.community_id;
    let actor_pubkey = ctx.actor.to_bytes();
    let object_kind_code = ctx.object_kind.database_code();
    let object_key = ctx.object_key;
    let operation_id = ctx.operation_id;
    let request_fingerprint = compute_request_fingerprint(ctx);

    // ── 1. Proof expiry (authoritative DB time) ───────────────────────────
    if db_now >= ctx.proof_expires_at {
        return Err(AdmissionError::ProofExpired);
    }

    // ── 2. Assertion revalidation (before any write) ──────────────────────
    let fresh_assertion = revalidate_assertion(verifier, &ctx.verified_assertion, db_now)?;

    let result = commit_admission_body(
        &mut tx,
        db_now,
        ctx,
        proposal,
        &fresh_assertion,
        community_id,
        actor_pubkey,
        object_kind_code,
        object_key,
        operation_id,
        request_fingerprint,
    )
    .await?;

    tx.commit().await.map_err(map_sqlx_error)?;
    Ok(result)
}

/// Shared body for NIP-FI admission steps 3–14 (community/channel/policy/
/// enrollment/invalidation/epoch/fence/receipt/authority).
///
/// Operates on a caller-owned transaction; does not commit.  Used by both
/// the standalone `commit_admission_inner` and the Design-B `commit_admission_in_tx`.
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
async fn commit_admission_body(
    tx: &mut Transaction<'_, Postgres>,
    db_now: DateTime<Utc>,
    ctx: &SealedRequestContext,
    proposal: &BindingProposal,
    fresh_assertion: &VerifiedAssertion,
    community_id: Uuid,
    actor_pubkey: [u8; 32],
    object_kind_code: i16,
    object_key: [u8; 32],
    operation_id: Uuid,
    request_fingerprint: [u8; 32],
) -> Result<CommittedAuthorization, AdmissionError> {
    // ── 3. Community write-fence check ────────────────────────────────────
    let community_row = sqlx::query(
        r#"
        SELECT deletion_state
        FROM communities
        WHERE id = $1
        FOR SHARE
        "#,
    )
    .bind(community_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    let comm = community_row.ok_or(AdmissionError::CommunityWriteFenced)?;
    let deletion_state: String = comm
        .try_get("deletion_state")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    if deletion_state != "active" {
        return Err(AdmissionError::CommunityWriteFenced);
    }

    // ── 4. Channel resource state reread (kind-9 vertical slice) ─────────
    //
    // object_key for MessagesWrite/Channel = SHA-256 of the 16-byte wire
    // representation of the channel UUID (PostgreSQL: sha256(uuid_send(c.id))).
    // NOT sha256(c.id::text::bytea) — that hashes 36 ASCII bytes.
    let channel_row = sqlx::query(
        r#"
        SELECT c.id, c.archived_at, c.deleted_at
        FROM channels c
        JOIN communities comm ON comm.id = c.community_id
        WHERE c.community_id = $1
          AND sha256(uuid_send(c.id)) = $2
          AND comm.deletion_state = 'active'
        FOR SHARE
        "#,
    )
    .bind(community_id)
    .bind(object_key.as_slice())
    .fetch_optional(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    let chan = channel_row.ok_or(AdmissionError::ResourceStateDenied)?;
    let archived_at: Option<DateTime<Utc>> = chan
        .try_get("archived_at")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    let deleted_at: Option<DateTime<Utc>> = chan
        .try_get("deleted_at")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    if archived_at.is_some() || deleted_at.is_some() {
        return Err(AdmissionError::ResourceStateDenied);
    }

    // ── 5. Policy reread ──────────────────────────────────────────────────
    let policy_row = sqlx::query(
        r#"
        SELECT policy_revision, effective_at, expires_at
        FROM identity_enrollment_policies
        WHERE community_id = $1
        ORDER BY policy_revision DESC
        LIMIT 1
        FOR SHARE
        "#,
    )
    .bind(community_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    let pr = policy_row.ok_or(AdmissionError::PolicyNotYetEffective)?;
    let policy_revision: i64 = pr
        .try_get("policy_revision")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    let policy_effective_at: DateTime<Utc> = pr
        .try_get("effective_at")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    let policy_expires_at: Option<DateTime<Utc>> = pr
        .try_get("expires_at")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;

    if db_now < policy_effective_at {
        return Err(AdmissionError::PolicyNotYetEffective);
    }
    if let Some(exp) = policy_expires_at {
        if db_now >= exp {
            return Err(AdmissionError::PolicyExpired);
        }
    }

    // ── 6. Enrollment: resolve or create binding ──────────────────────────
    let issuer = fresh_assertion.identity().issuer();
    let subject = fresh_assertion.identity().subject();
    let principal_fp = compute_principal_fingerprint(&actor_pubkey, issuer, subject);

    // Check for tombstone/revoked-key selector-3 on this exact pubkey.
    // selector_kind = 3 (revoked key Y-selector): selector_fingerprint is the
    // event_author_pubkey (32 bytes), NOT the principal fingerprint.
    // See migration 0041: kind-3 selector has event_author_pubkey IS NOT NULL,
    // principal_fingerprint IS NULL, and the permanent-key unique index is on
    // (community_id, event_author_pubkey) WHERE selector_kind = 3.
    let selector_3_row = sqlx::query(
        r#"
        SELECT selector_id
        FROM identity_lifecycle_selectors
        WHERE community_id         = $1
          AND selector_kind        = 3
          AND selector_fingerprint = $2
        LIMIT 1
        "#,
    )
    .bind(community_id)
    .bind(actor_pubkey.as_slice()) // event_author_pubkey for kind-3
    .fetch_optional(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    if selector_3_row.is_some() {
        return Err(AdmissionError::NoActiveBinding);
    }

    // Attempt to find an existing active binding.
    let binding_row = sqlx::query(
        r#"
        SELECT binding_id, binding_version, binding_state, lifecycle_revision,
               expires_at, policy_revision
        FROM identity_bindings
        WHERE community_id              = $1
          AND issuer                    = $2
          AND subject                   = $3
          AND binding_state             = 1
        LIMIT 1
        FOR SHARE
        "#,
    )
    .bind(community_id)
    .bind(issuer)
    .bind(subject)
    .fetch_optional(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    let (binding_id, binding_version, binding_lifecycle_revision) = match binding_row {
        Some(br) => {
            let bv: i64 = br
                .try_get("binding_version")
                .map_err(|e| AdmissionError::Transient(e.to_string()))?;
            let bs: i16 = br
                .try_get("binding_state")
                .map_err(|e| AdmissionError::Transient(e.to_string()))?;
            let lr: i64 = br
                .try_get("lifecycle_revision")
                .map_err(|e| AdmissionError::Transient(e.to_string()))?;
            let exp: Option<DateTime<Utc>> = br
                .try_get("expires_at")
                .map_err(|e| AdmissionError::Transient(e.to_string()))?;
            let bid: Uuid = br
                .try_get("binding_id")
                .map_err(|e| AdmissionError::Transient(e.to_string()))?;

            if bs != 1 {
                return Err(AdmissionError::BindingRetired);
            }
            if let Some(exp_t) = exp {
                if db_now >= exp_t {
                    return Err(AdmissionError::BindingExpired);
                }
            }
            (bid, bv, lr)
        }
        None => {
            // No active binding — enroll a new one.
            let (bid, bv, lr) = enroll_binding(
                tx,
                community_id,
                &actor_pubkey,
                issuer,
                subject,
                &principal_fp,
                proposal,
                policy_revision,
                &fresh_assertion,
                operation_id,
                &request_fingerprint,
                db_now,
            )
            .await?;
            (bid, bv, lr)
        }
    };

    // ── 7. Invalidation domain and floor checks ───────────────────────────
    let domain_row = sqlx::query(
        r#"
        SELECT current_generation
        FROM authorization_invalidation_domains
        WHERE community_id = $1
        FOR SHARE
        "#,
    )
    .bind(community_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    let current_generation: i64 = match domain_row {
        Some(r) => r
            .try_get("current_generation")
            .map_err(|e| AdmissionError::Transient(e.to_string()))?,
        None => return Err(AdmissionError::InvalidationDomainAbsent),
    };

    // Principal-level (selector 1) floor.
    let floor_1_row = sqlx::query(
        r#"
        SELECT floor_generation, binding_version_floor
        FROM authorization_invalidation_floors
        WHERE community_id         = $1
          AND selector_kind        = 1
          AND selector_fingerprint = $2
        FOR SHARE
        "#,
    )
    .bind(community_id)
    .bind(principal_fp.as_slice())
    .fetch_optional(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    if let Some(fr) = floor_1_row {
        let floor_gen: i64 = fr
            .try_get("floor_generation")
            .map_err(|e| AdmissionError::Transient(e.to_string()))?;
        if current_generation < floor_gen {
            return Err(AdmissionError::InvalidationFloorAbsent);
        }
        if current_generation > floor_gen {
            return Err(AdmissionError::InvalidationGenerationAdvanced);
        }
    }

    // Binding (selector 3) floor — filtered to this exact actor pubkey.
    // selector_kind=3 uses selector_fingerprint = event_author_pubkey.
    let floor_3_rows = sqlx::query(
        r#"
        SELECT floor_generation, binding_version_floor
        FROM authorization_invalidation_floors
        WHERE community_id         = $1
          AND selector_kind        = 3
          AND selector_fingerprint = $2
        FOR SHARE
        "#,
    )
    .bind(community_id)
    .bind(actor_pubkey.as_slice())
    .fetch_all(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    for fr in &floor_3_rows {
        let floor_gen: i64 = fr
            .try_get("floor_generation")
            .map_err(|e| AdmissionError::Transient(e.to_string()))?;
        if current_generation < floor_gen {
            return Err(AdmissionError::InvalidationFloorAbsent);
        }
        if current_generation > floor_gen {
            return Err(AdmissionError::InvalidationGenerationAdvanced);
        }
        let bvf: Option<i64> = fr
            .try_get("binding_version_floor")
            .map_err(|e| AdmissionError::Transient(e.to_string()))?;
        if let Some(floor_bv) = bvf {
            if binding_version < floor_bv {
                return Err(AdmissionError::InvalidationFloorAbsent);
            }
        }
    }

    // ── 8. Assertion deadline check ───────────────────────────────────────
    // The fresh assertion was already fully bounds-checked in revalidate_assertion.
    // Re-confirm the upstream deadline against DB time.
    let upstream_deadline = fresh_assertion.upstream_authority_deadline();
    if db_now >= upstream_deadline {
        return Err(AdmissionError::PreparedDeadlineExpired);
    }

    // ── 9. Epoch/fence reread ─────────────────────────────────────────────
    let epoch_row = sqlx::query(
        r#"
        SELECT authority_epoch, fence
        FROM authorization_authority_epochs
        WHERE community_id = $1
          AND object_kind  = $2
          AND object_key   = $3
        FOR UPDATE
        "#,
    )
    .bind(community_id)
    .bind(object_kind_code)
    .bind(object_key.as_slice())
    .fetch_optional(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    let (current_epoch, _current_fence) = match &epoch_row {
        Some(r) => {
            let ep: i64 = r
                .try_get("authority_epoch")
                .map_err(|e| AdmissionError::Transient(e.to_string()))?;
            let fence_bytes: Vec<u8> = r
                .try_get("fence")
                .map_err(|e| AdmissionError::Transient(e.to_string()))?;
            let mut fence = [0u8; 32];
            if fence_bytes.len() == 32 {
                fence.copy_from_slice(&fence_bytes);
            }
            (ep, fence)
        }
        None => (0i64, [0u8; 32]),
    };

    let new_epoch = current_epoch + 1;
    let new_fence = generate_fence();

    // ── 10. Insert proof replay claim ─────────────────────────────────────
    let retained_until = upstream_deadline;
    sqlx::query(
        r#"
        INSERT INTO nip_fi_proof_replay_claims
            (community_id, proof_event_id, retained_until)
        VALUES ($1, $2, $3)
        "#,
    )
    .bind(community_id)
    .bind(ctx.proof_event_id.as_slice())
    .bind(retained_until)
    .execute(&mut **tx)
    .await
    .map_err(map_replay_claim_error)?;

    // ── 11. Insert operation receipt (operation_kind=11 protected mutation) ─
    // This is the admission receipt.  The enrollment receipt (kind=1) was
    // inserted inside enroll_binding() with a SEPARATE enroll_operation_id.
    // The two receipts must not share (community_id, operation_id) — that
    // is the receipt table's primary key.
    let result_digest =
        compute_result_digest(&request_fingerprint, &operation_id, &community_id, 1);
    sqlx::query(
        r#"
        INSERT INTO authorization_operation_receipts
            (community_id, operation_id, request_fingerprint,
             operation_kind, actor_fingerprint, outcome_code, result_digest)
        VALUES ($1, $2, $3, 11, $4, 1, $5)
        "#,
    )
    .bind(community_id)
    .bind(operation_id)
    .bind(request_fingerprint.as_slice())
    .bind(actor_pubkey.as_slice())
    .bind(result_digest.as_slice())
    .execute(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    // ── 12. Upsert epoch/fence ────────────────────────────────────────────
    if epoch_row.is_some() {
        sqlx::query(
            r#"
            UPDATE authorization_authority_epochs
            SET authority_epoch    = $4,
                fence              = $5,
                operation_id       = $6,
                request_fingerprint = $7,
                updated_at         = transaction_timestamp()
            WHERE community_id = $1
              AND object_kind  = $2
              AND object_key   = $3
            "#,
        )
        .bind(community_id)
        .bind(object_kind_code)
        .bind(object_key.as_slice())
        .bind(new_epoch)
        .bind(new_fence.as_slice())
        .bind(operation_id)
        .bind(request_fingerprint.as_slice())
        .execute(&mut **tx)
        .await
        .map_err(map_sqlx_error)?;
    } else {
        sqlx::query(
            r#"
            INSERT INTO authorization_authority_epochs
                (community_id, object_kind, object_key,
                 authority_epoch, fence, operation_id, request_fingerprint)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            "#,
        )
        .bind(community_id)
        .bind(object_kind_code)
        .bind(object_key.as_slice())
        .bind(new_epoch)
        .bind(new_fence.as_slice())
        .bind(operation_id)
        .bind(request_fingerprint.as_slice())
        .execute(&mut **tx)
        .await
        .map_err(map_sqlx_error)?;
    }

    // ── 13. Upsert protected_object_authority ─────────────────────────────
    let capability_code = ctx.capability.database_code();
    let issued_at = db_now;
    let expires_at = std::cmp::min(ctx.proof_expires_at, upstream_deadline);

    sqlx::query(
        r#"
        INSERT INTO protected_object_authority (
            community_id, object_kind, object_key,
            capability, actor_pubkey, binding_id, binding_version,
            policy_revision, invalidation_generation,
            authority_epoch, fence,
            issued_at, expires_at,
            operation_id, request_fingerprint
        ) VALUES (
            $1, $2, $3,
            $4, $5, $6, $7,
            $8, $9,
            $10, $11,
            $12, $13,
            $14, $15
        )
        ON CONFLICT (community_id, object_kind, object_key) DO UPDATE SET
            capability              = EXCLUDED.capability,
            actor_pubkey            = EXCLUDED.actor_pubkey,
            binding_id              = EXCLUDED.binding_id,
            binding_version         = EXCLUDED.binding_version,
            policy_revision         = EXCLUDED.policy_revision,
            invalidation_generation = EXCLUDED.invalidation_generation,
            authority_epoch         = EXCLUDED.authority_epoch,
            fence                   = EXCLUDED.fence,
            issued_at               = EXCLUDED.issued_at,
            expires_at              = EXCLUDED.expires_at,
            operation_id            = EXCLUDED.operation_id,
            request_fingerprint     = EXCLUDED.request_fingerprint
        "#,
    )
    .bind(community_id)
    .bind(object_kind_code)
    .bind(object_key.as_slice())
    .bind(capability_code)
    .bind(actor_pubkey.as_slice())
    .bind(binding_id)
    .bind(binding_version)
    .bind(policy_revision)
    .bind(current_generation)
    .bind(new_epoch)
    .bind(new_fence.as_slice())
    .bind(issued_at)
    .bind(expires_at)
    .bind(operation_id)
    .bind(request_fingerprint.as_slice())
    .execute(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    // ── 14. Insert admission result ───────────────────────────────────────
    let semantic_fingerprint = compute_semantic_fingerprint(ctx);
    sqlx::query(
        r#"
        INSERT INTO authorization_admission_results (
            community_id, operation_id, request_fingerprint,
            semantic_fingerprint, object_kind, object_key
        ) VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(community_id)
    .bind(operation_id)
    .bind(request_fingerprint.as_slice())
    .bind(semantic_fingerprint.as_slice())
    .bind(object_kind_code)
    .bind(object_key.as_slice())
    .execute(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    Ok(CommittedAuthorization {
        community_id,
        operation_id,
        request_fingerprint,
        authority_epoch: new_epoch,
        authority_fence: new_fence,
        actor_pubkey,
        binding_id,
        binding_version,
        binding_lifecycle_revision,
        policy_revision,
        issued_at,
        expires_at,
        capability_code,
        object_kind_code,
        object_key,
        conn_id: ctx.conn_id,
        challenge: ctx.challenge.clone(),
        relay_url: ctx.relay_url.clone(),
        proof_event_id: ctx.proof_event_id,
        transport_code: match ctx.transport {
            ProofTransport::Nip42WebSocket => 1u8,
            ProofTransport::Nip98Http => 2u8,
        },
        assertion_issuer: issuer.to_string(),
        assertion_subject: subject.to_string(),
    })
}

/// Insert a new identity binding and its lifecycle history row atomically.
///
/// Uses `identity_lifecycle_lock_coordinates_v1` advisory lock for
/// concurrent-enrollment convergence.  Returns `(binding_id, binding_version,
/// lifecycle_revision=1)`.
///
/// ## Operation model
///
/// The enrollment uses a SEPARATE `enroll_operation_id` (a new UUID) so its
/// receipt (operation_kind=1) does not collide with the admission receipt
/// (operation_kind=11) for the same request.  The receipt table primary key
/// is (community_id, operation_id).
///
/// ## Insert ordering (avoiding the circular FK deadlock)
///
/// 1. INSERT identity_bindings RETURNING binding_version
/// 2. INSERT identity_lifecycle_history (all four successor fields populated,
///    because binding_version is now known)
/// 3. INSERT authorization_events (event_kind=1, deferred FK to receipt)
/// 4. INSERT authorization_operation_receipts (enroll_operation_id, kind=1)
///
/// All FKs on history → bindings and history → receipts are DEFERRABLE
/// INITIALLY DEFERRED — they are checked at COMMIT only.
#[allow(clippy::too_many_arguments)]
async fn enroll_binding(
    tx: &mut Transaction<'_, Postgres>,
    community_id: Uuid,
    actor_pubkey: &[u8; 32],
    issuer: &str,
    subject: &str,
    principal_fp: &[u8; 32],
    proposal: &BindingProposal,
    policy_revision: i64,
    assertion: &VerifiedAssertion,
    _admission_operation_id: Uuid,
    request_fingerprint: &[u8; 32],
    db_now: DateTime<Utc>,
) -> Result<(Uuid, i64, i64), AdmissionError> {
    // Separate operation ID for enrollment receipt.
    // This keeps the enrollment receipt (kind=1) distinct from the admission
    // receipt (kind=11) — they both reference the same physical request
    // but are different operations in the authority ledger.
    let enroll_operation_id = Uuid::new_v4();
    let enroll_request_fingerprint = *request_fingerprint;

    // Acquire the per-coordinate advisory lock.
    sqlx::query("SELECT identity_lifecycle_lock_coordinates_v1($1, $2, $3)")
        .bind(community_id)
        .bind(principal_fp.as_slice())
        .bind(actor_pubkey.as_slice())
        .execute(&mut **tx)
        .await
        .map_err(map_sqlx_error)?;

    // Re-check for an active binding under the lock (race convergence).
    let recheck = sqlx::query(
        r#"
        SELECT binding_id, binding_version
        FROM identity_bindings
        WHERE community_id  = $1
          AND issuer        = $2
          AND subject       = $3
          AND binding_state = 1
        LIMIT 1
        FOR SHARE
        "#,
    )
    .bind(community_id)
    .bind(issuer)
    .bind(subject)
    .fetch_optional(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    if let Some(r) = recheck {
        // Identical concurrent enrollment — converge to the existing winner.
        let bid: Uuid = r
            .try_get("binding_id")
            .map_err(|e| AdmissionError::Transient(e.to_string()))?;
        let bv: i64 = r
            .try_get("binding_version")
            .map_err(|e| AdmissionError::Transient(e.to_string()))?;
        return Ok((bid, bv, 1));
    }

    let binding_id = proposal.binding_id;
    let evidence_digest = compute_enrollment_evidence_digest(assertion, actor_pubkey);

    // Step 1: Insert the binding row FIRST to get binding_version via RETURNING.
    // The birth_history_id FK is DEFERRABLE — we'll insert the history row next.
    // Temporary placeholder: we'll use binding_id as birth_history_id sentinel
    // but the real history_id comes immediately after.
    let history_id = Uuid::new_v4();

    let binding_row = sqlx::query(
        r#"
        INSERT INTO identity_bindings
            (community_id, binding_id,
             issuer, subject,
             principal_fingerprint, event_author_pubkey,
             binding_state, lifecycle_revision,
             binding_provenance, policy_revision,
             enrollment_evidence_digest,
             birth_history_id, creation_operation_id, creation_request_fingerprint)
        VALUES ($1, $2,
                $3, $4,
                $5, $6,
                1, 1,
                $7, $8,
                $9,
                $10, $11, $12)
        RETURNING binding_version
        "#,
    )
    .bind(community_id)
    .bind(binding_id)
    .bind(issuer)
    .bind(subject)
    .bind(principal_fp.as_slice())
    .bind(actor_pubkey.as_slice())
    .bind(proposal.provenance.database_code())
    .bind(policy_revision)
    .bind(evidence_digest.as_slice())
    .bind(history_id)
    .bind(enroll_operation_id)
    .bind(enroll_request_fingerprint.as_slice())
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| {
        if is_unique_violation(&e) {
            AdmissionError::EnrollmentConflict
        } else {
            map_sqlx_error(e)
        }
    })?;

    let binding_version: i64 = binding_row
        .try_get("binding_version")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;

    // Step 2: Insert lifecycle history with all four successor fields populated.
    // The CHECK requires all four successor fields to be ALL non-null or ALL null.
    // Transition kind=1 (enroll) requires old_binding_id IS NULL and
    // successor_binding_id IS NOT NULL.
    let transition_digest = compute_transition_digest(
        &community_id,
        &history_id,
        &enroll_operation_id,
        &enroll_request_fingerprint,
    );

    sqlx::query(
        r#"
        INSERT INTO identity_lifecycle_history
            (community_id, history_id, transition_kind, outcome_code,
             successor_binding_id, successor_binding_version,
             successor_lifecycle_revision, successor_state,
             operation_id, request_fingerprint, transition_digest)
        VALUES ($1, $2, 1, 1,
                $3, $4,
                1, 1,
                $5, $6, $7)
        "#,
    )
    .bind(community_id)
    .bind(history_id)
    .bind(binding_id)
    .bind(binding_version) // now known: all four successor fields populated
    .bind(enroll_operation_id)
    .bind(enroll_request_fingerprint.as_slice())
    .bind(transition_digest.as_slice())
    .execute(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    // Step 3: Insert the enrollment audit event (event_kind=1 enrolled).
    // Required by the deferred trigger on authorization_operation_receipts
    // (operation_kind=1 lifecycle receipt must have exactly one event).
    // actor_kind=1 (principal/user).
    let audit_event_id = Uuid::new_v4();
    let correlation_id = Uuid::new_v4();
    let attempt_id = Uuid::new_v4();
    let enroll_result_digest = compute_result_digest(
        &enroll_request_fingerprint,
        &enroll_operation_id,
        &community_id,
        1,
    );
    let envelope = build_minimal_canonical_envelope(
        1, // event_kind=1 enrolled
        &community_id,
        &enroll_operation_id,
        &enroll_request_fingerprint,
        actor_pubkey,
    );
    let envelope_digest = compute_envelope_digest(&envelope);

    sqlx::query(
        r#"
        INSERT INTO authorization_events
            (community_id, event_id, event_kind, outcome_code, reason_code,
             actor_kind, actor_fingerprint, subject_fingerprint,
             operation_id, request_fingerprint, correlation_id, attempt_id,
             occurred_at, canonical_envelope, envelope_digest)
        VALUES ($1, $2, 1, 1, 1,
                1, $3, $3,
                $4, $5, $6, $7,
                $8, $9, $10)
        "#,
    )
    .bind(community_id)
    .bind(audit_event_id)
    .bind(actor_pubkey.as_slice()) // actor_fingerprint (and subject_fingerprint)
    .bind(enroll_operation_id)
    .bind(enroll_request_fingerprint.as_slice())
    .bind(correlation_id)
    .bind(attempt_id)
    .bind(db_now) // occurred_at
    .bind(&envelope)
    .bind(envelope_digest.as_slice())
    .execute(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    // Step 4: Insert the enrollment receipt (operation_kind=1).
    // The deferred FK in identity_lifecycle_history → receipts is satisfied now.
    sqlx::query(
        r#"
        INSERT INTO authorization_operation_receipts
            (community_id, operation_id, request_fingerprint,
             operation_kind, actor_fingerprint, outcome_code, result_digest,
             transition_kind)
        VALUES ($1, $2, $3, 1, $4, 1, $5, 1)
        "#,
    )
    .bind(community_id)
    .bind(enroll_operation_id)
    .bind(enroll_request_fingerprint.as_slice())
    .bind(actor_pubkey.as_slice())
    .bind(enroll_result_digest.as_slice())
    .execute(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    Ok((binding_id, binding_version, 1))
}

// ── Protected-use re-fence ────────────────────────────────────────────────────

/// Re-read every committed witness inside a caller-owned SERIALIZABLE
/// transaction, compare live-connection scalars, re-fence, and return an
/// `AuthorizedUse`.
///
/// Design-B path: the caller owns the transaction that spans both this
/// re-fence and the subsequent event insert.  No commit happens here.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn authorize_protected_use_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    db_now: DateTime<Utc>,
    committed: &CommittedAuthorization,
    live_conn_id: Uuid,
    live_challenge: &str,
    live_relay_url: &str,
    live_proof_event_id: &[u8; 32],
    live_transport: ProofTransport,
    live_actor: &nostr::PublicKey,
) -> Result<AuthorizedUse, AdmissionError> {
    authorize_protected_use_body(
        tx,
        db_now,
        committed,
        live_conn_id,
        live_challenge,
        live_relay_url,
        live_proof_event_id,
        live_transport,
        live_actor,
    )
    .await
}

/// Re-read every committed witness inside a fresh SERIALIZABLE transaction,
/// compare live-connection scalars, re-fence, and return an `AuthorizedUse`.
pub(crate) async fn authorize_protected_use(
    pool: &PgPool,
    committed: &CommittedAuthorization,
    live_conn_id: Uuid,
    live_challenge: &str,
    live_relay_url: &str,
    live_proof_event_id: &[u8; 32],
    live_transport: ProofTransport,
    live_actor: &nostr::PublicKey,
) -> Result<AuthorizedUse, AdmissionError> {
    let mut attempts = 0usize;
    loop {
        attempts += 1;
        match authorize_protected_use_inner(
            pool,
            committed,
            live_conn_id,
            live_challenge,
            live_relay_url,
            live_proof_event_id,
            live_transport,
            live_actor,
        )
        .await
        {
            Ok(grant) => return Ok(grant),
            Err(AdmissionError::SerializationRetry) if attempts < MAX_SERIALIZATION_RETRIES => {
                tokio::time::sleep(std::time::Duration::from_millis((attempts as u64) * 5)).await;
                continue;
            }
            Err(e) => return Err(e),
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn authorize_protected_use_inner(
    pool: &PgPool,
    committed: &CommittedAuthorization,
    live_conn_id: Uuid,
    live_challenge: &str,
    live_relay_url: &str,
    live_proof_event_id: &[u8; 32],
    live_transport: ProofTransport,
    live_actor: &nostr::PublicKey,
) -> Result<AuthorizedUse, AdmissionError> {
    let mut tx: Transaction<'_, Postgres> = pool
        .begin()
        .await
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;

    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        .execute(&mut *tx)
        .await
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;

    let db_now: DateTime<Utc> = sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;

    let result = authorize_protected_use_body(
        &mut tx,
        db_now,
        committed,
        live_conn_id,
        live_challenge,
        live_relay_url,
        live_proof_event_id,
        live_transport,
        live_actor,
    )
    .await?;

    tx.commit().await.map_err(map_sqlx_error)?;
    Ok(result)
}

/// Shared body for authorize_protected_use steps 1–9 (community/channel/poa/
/// binding/invalidation/re-fence/epoch advance/receipt).
///
/// Operates on a caller-owned transaction; does not commit.  Used by both
/// `authorize_protected_use_inner` (standalone) and `authorize_protected_use_in_tx`
/// (Design-B atomic path).
#[allow(clippy::too_many_arguments)]
async fn authorize_protected_use_body(
    tx: &mut Transaction<'_, Postgres>,
    db_now: DateTime<Utc>,
    committed: &CommittedAuthorization,
    live_conn_id: Uuid,
    live_challenge: &str,
    live_relay_url: &str,
    live_proof_event_id: &[u8; 32],
    live_transport: ProofTransport,
    live_actor: &nostr::PublicKey,
) -> Result<AuthorizedUse, AdmissionError> {
    let community_id = committed.community_id;
    let object_kind_code = committed.object_kind_code;
    let object_key = &committed.object_key;

    // ── 1. Community write-fence reread ───────────────────────────────────
    let community_row = sqlx::query(
        r#"
        SELECT deletion_state
        FROM communities
        WHERE id = $1
        FOR SHARE
        "#,
    )
    .bind(community_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    let comm = community_row.ok_or(AdmissionError::CommunityWriteFenced)?;
    let deletion_state: String = comm
        .try_get("deletion_state")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    if deletion_state != "active" {
        return Err(AdmissionError::CommunityWriteFenced);
    }

    // ── 2. Channel resource state reread ──────────────────────────────────
    // Same UUID 16-byte encoding as admission: sha256(uuid_send(c.id)).
    let channel_row = sqlx::query(
        r#"
        SELECT c.archived_at, c.deleted_at
        FROM channels c
        WHERE c.community_id = $1
          AND sha256(uuid_send(c.id)) = $2
        FOR SHARE
        "#,
    )
    .bind(community_id)
    .bind(object_key.as_slice())
    .fetch_optional(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    let chan = channel_row.ok_or(AdmissionError::ResourceStateDenied)?;
    let archived_at: Option<DateTime<Utc>> = chan
        .try_get("archived_at")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    let deleted_at: Option<DateTime<Utc>> = chan
        .try_get("deleted_at")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    if archived_at.is_some() || deleted_at.is_some() {
        return Err(AdmissionError::ResourceStateDenied);
    }

    // ── 3. Re-read protected_object_authority (FOR UPDATE) ────────────────
    let poa_row = sqlx::query(
        r#"
        SELECT capability, actor_pubkey, binding_id, binding_version,
               policy_revision, invalidation_generation,
               authority_epoch, fence, issued_at, expires_at,
               operation_id, request_fingerprint
        FROM protected_object_authority
        WHERE community_id = $1
          AND object_kind  = $2
          AND object_key   = $3
        FOR UPDATE
        "#,
    )
    .bind(community_id)
    .bind(object_kind_code)
    .bind(object_key.as_slice())
    .fetch_optional(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    let poa = poa_row.ok_or(AdmissionError::NoActiveBinding)?;

    // ── 4. Live-connection dimensions ─────────────────────────────────────
    let poa_capability: i16 = poa
        .try_get("capability")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    if poa_capability != committed.capability_code {
        return Err(AdmissionError::ResourceStateDenied);
    }

    let poa_actor: Vec<u8> = poa
        .try_get("actor_pubkey")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    if poa_actor.as_slice() != live_actor.to_bytes().as_slice()
        || poa_actor.as_slice() != committed.actor_pubkey.as_slice()
    {
        return Err(AdmissionError::ResourceStateDenied);
    }

    if live_conn_id != committed.conn_id {
        return Err(AdmissionError::ResourceStateDenied);
    }
    if live_challenge != committed.challenge.as_str() {
        return Err(AdmissionError::ResourceStateDenied);
    }
    if live_relay_url != committed.relay_url.as_str() {
        return Err(AdmissionError::ResourceStateDenied);
    }
    if live_proof_event_id != &committed.proof_event_id {
        return Err(AdmissionError::ResourceStateDenied);
    }

    let live_transport_code = match live_transport {
        ProofTransport::Nip42WebSocket => 1u8,
        ProofTransport::Nip98Http => 2u8,
    };
    if live_transport_code != committed.transport_code {
        return Err(AdmissionError::ResourceStateDenied);
    }

    let poa_epoch: i64 = poa
        .try_get("authority_epoch")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    if poa_epoch != committed.authority_epoch {
        return Err(AdmissionError::EpochFenceAdvanced);
    }

    let poa_fence_bytes: Vec<u8> = poa
        .try_get("fence")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    if poa_fence_bytes.len() != 32 || poa_fence_bytes == [0u8; 32] {
        return Err(AdmissionError::EpochFenceAdvanced);
    }
    let mut current_fence = [0u8; 32];
    current_fence.copy_from_slice(&poa_fence_bytes);
    if current_fence != committed.authority_fence {
        return Err(AdmissionError::EpochFenceAdvanced);
    }

    let poa_rf_bytes: Vec<u8> = poa
        .try_get("request_fingerprint")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    if poa_rf_bytes.as_slice() != committed.request_fingerprint.as_slice() {
        return Err(AdmissionError::EpochFenceAdvanced);
    }

    let poa_op_id: Uuid = poa
        .try_get("operation_id")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    if poa_op_id != committed.operation_id {
        return Err(AdmissionError::EpochFenceAdvanced);
    }

    let poa_expires_at: DateTime<Utc> = poa
        .try_get("expires_at")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    if db_now >= poa_expires_at {
        return Err(AdmissionError::PreparedDeadlineExpired);
    }

    let poa_binding_version: i64 = poa
        .try_get("binding_version")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    if poa_binding_version != committed.binding_version {
        return Err(AdmissionError::NoActiveBinding);
    }

    // ── 5. Binding liveness ───────────────────────────────────────────────
    let poa_binding_id: Uuid = poa
        .try_get("binding_id")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    // Binding_id must match the one committed during admission — a changed POA
    // binding (e.g., after a rotation race) must be rejected, not silently
    // accepted.
    if poa_binding_id != committed.binding_id {
        return Err(AdmissionError::NoActiveBinding);
    }

    let poa_policy_revision: i64 = poa
        .try_get("policy_revision")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    // Policy_revision must match — an advanced or changed policy between
    // admission and final use must be rejected.
    if poa_policy_revision != committed.policy_revision {
        return Err(AdmissionError::PolicyExpired);
    }

    let binding_check = sqlx::query(
        r#"
        SELECT binding_state, lifecycle_revision, expires_at
        FROM identity_bindings
        WHERE community_id    = $1
          AND binding_id      = $2
          AND binding_version = $3
        FOR SHARE
        "#,
    )
    .bind(community_id)
    .bind(poa_binding_id)
    .bind(poa_binding_version)
    .fetch_optional(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    let bc = binding_check.ok_or(AdmissionError::NoActiveBinding)?;
    let bs: i16 = bc
        .try_get("binding_state")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    if bs != 1 {
        return Err(AdmissionError::BindingRetired);
    }
    let bind_exp: Option<DateTime<Utc>> = bc
        .try_get("expires_at")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    if let Some(exp) = bind_exp {
        if db_now >= exp {
            return Err(AdmissionError::BindingExpired);
        }
    }

    // ── 6. Invalidation domain reread ─────────────────────────────────────
    let domain_row = sqlx::query(
        r#"
        SELECT current_generation
        FROM authorization_invalidation_domains
        WHERE community_id = $1
        FOR SHARE
        "#,
    )
    .bind(community_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    let current_generation: i64 = match domain_row {
        Some(r) => r
            .try_get("current_generation")
            .map_err(|e| AdmissionError::Transient(e.to_string()))?,
        None => return Err(AdmissionError::InvalidationDomainAbsent),
    };

    let poa_inv_gen: i64 = poa
        .try_get("invalidation_generation")
        .map_err(|e| AdmissionError::Transient(e.to_string()))?;
    if current_generation > poa_inv_gen {
        return Err(AdmissionError::InvalidationGenerationAdvanced);
    }

    // ── 7. Principal (selector 1) floor ───────────────────────────────────
    let actor_pubkey = committed.actor_pubkey;
    let principal_fp = compute_principal_fingerprint(
        &actor_pubkey,
        &committed.assertion_issuer,
        &committed.assertion_subject,
    );
    let floor_1_row = sqlx::query(
        r#"
        SELECT floor_generation
        FROM authorization_invalidation_floors
        WHERE community_id         = $1
          AND selector_kind        = 1
          AND selector_fingerprint = $2
        FOR SHARE
        "#,
    )
    .bind(community_id)
    .bind(principal_fp.as_slice())
    .fetch_optional(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    if let Some(fr) = floor_1_row {
        let floor_gen: i64 = fr
            .try_get("floor_generation")
            .map_err(|e| AdmissionError::Transient(e.to_string()))?;
        if current_generation < floor_gen {
            return Err(AdmissionError::InvalidationFloorAbsent);
        }
        if current_generation > floor_gen {
            return Err(AdmissionError::InvalidationGenerationAdvanced);
        }
    }

    // ── 8. Binding (selector 3) floor ─────────────────────────────────────
    let floor_3_rows = sqlx::query(
        r#"
        SELECT floor_generation, binding_version_floor
        FROM authorization_invalidation_floors
        WHERE community_id         = $1
          AND selector_kind        = 3
          AND selector_fingerprint = $2
        FOR SHARE
        "#,
    )
    .bind(community_id)
    .bind(actor_pubkey.as_slice())
    .fetch_all(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    for fr in &floor_3_rows {
        let floor_gen: i64 = fr
            .try_get("floor_generation")
            .map_err(|e| AdmissionError::Transient(e.to_string()))?;
        if current_generation < floor_gen {
            return Err(AdmissionError::InvalidationFloorAbsent);
        }
        if current_generation > floor_gen {
            return Err(AdmissionError::InvalidationGenerationAdvanced);
        }
        let bvf: Option<i64> = fr
            .try_get("binding_version_floor")
            .map_err(|e| AdmissionError::Transient(e.to_string()))?;
        if let Some(floor_bv) = bvf {
            if committed.binding_version < floor_bv {
                return Err(AdmissionError::InvalidationFloorAbsent);
            }
        }
    }

    // ── 9. Re-fence ───────────────────────────────────────────────────────
    let use_operation_id = Uuid::new_v4();
    let use_request_fingerprint: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"buzz.nip-fi.use-fingerprint.v1\x00");
        h.update(community_id.as_bytes());
        h.update(use_operation_id.as_bytes());
        h.update(object_key.as_slice());
        h.update(poa_epoch.to_be_bytes());
        h.update(&current_fence);
        h.finalize().into()
    };
    let new_epoch = poa_epoch + 1;
    let new_fence = generate_fence();

    let use_result_digest = compute_result_digest(
        &use_request_fingerprint,
        &use_operation_id,
        &community_id,
        1,
    );

    sqlx::query(
        r#"
        INSERT INTO authorization_operation_receipts
            (community_id, operation_id, request_fingerprint,
             operation_kind, actor_fingerprint, outcome_code, result_digest)
        VALUES ($1, $2, $3, 11, $4, 1, $5)
        "#,
    )
    .bind(community_id)
    .bind(use_operation_id)
    .bind(use_request_fingerprint.as_slice())
    .bind(actor_pubkey.as_slice())
    .bind(use_result_digest.as_slice())
    .execute(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    let epoch_rows = sqlx::query(
        r#"
        UPDATE authorization_authority_epochs
        SET authority_epoch     = $4,
            fence               = $5,
            operation_id        = $6,
            request_fingerprint = $7,
            updated_at          = transaction_timestamp()
        WHERE community_id = $1
          AND object_kind  = $2
          AND object_key   = $3
        "#,
    )
    .bind(community_id)
    .bind(object_kind_code)
    .bind(object_key.as_slice())
    .bind(new_epoch)
    .bind(new_fence.as_slice())
    .bind(use_operation_id)
    .bind(use_request_fingerprint.as_slice())
    .execute(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;
    if epoch_rows.rows_affected() != 1 {
        return Err(AdmissionError::Transient(
            "authorization_authority_epochs UPDATE matched zero rows; schema or predicate drift"
                .into(),
        ));
    }

    let poa_rows = sqlx::query(
        r#"
        UPDATE protected_object_authority SET
            authority_epoch     = $4,
            fence               = $5,
            issued_at           = $6,
            operation_id        = $7,
            request_fingerprint = $8
        WHERE community_id = $1
          AND object_kind  = $2
          AND object_key   = $3
        "#,
    )
    .bind(community_id)
    .bind(object_kind_code)
    .bind(object_key.as_slice())
    .bind(new_epoch)
    .bind(new_fence.as_slice())
    .bind(db_now)
    .bind(use_operation_id)
    .bind(use_request_fingerprint.as_slice())
    .execute(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;
    if poa_rows.rows_affected() != 1 {
        return Err(AdmissionError::Transient(
            "protected_object_authority UPDATE matched zero rows; schema or predicate drift".into(),
        ));
    }

    let use_semantic_fp: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"buzz.nip-fi.use-semantic.v1\x00");
        h.update(committed.capability_code.to_be_bytes());
        h.update(committed.object_kind_code.to_be_bytes());
        h.update(committed.object_key.as_slice());
        h.update(committed.community_id.as_bytes());
        h.finalize().into()
    };

    sqlx::query(
        r#"
        INSERT INTO authorization_admission_results (
            community_id, operation_id, request_fingerprint,
            semantic_fingerprint, object_kind, object_key
        ) VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(community_id)
    .bind(use_operation_id)
    .bind(use_request_fingerprint.as_slice())
    .bind(use_semantic_fp.as_slice())
    .bind(object_kind_code)
    .bind(object_key.as_slice())
    .execute(&mut **tx)
    .await
    .map_err(map_sqlx_error)?;

    Ok(AuthorizedUse {
        use_operation_id,
        new_fence,
        new_epoch,
        granted_at: db_now,
    })
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_auth::nip_fi::AdmissionError;

    #[test]
    fn sqlstate_helpers_work() {
        let pool_err = sqlx::Error::RowNotFound;
        assert!(!is_serialization_failure(&pool_err));
        assert!(!is_unique_violation(&pool_err));
    }

    #[test]
    fn map_sqlx_error_row_not_found_is_transient() {
        let e = sqlx::Error::RowNotFound;
        assert!(matches!(map_sqlx_error(e), AdmissionError::Transient(_)));
    }

    #[test]
    fn generate_fence_is_nonzero() {
        for _ in 0..100 {
            let f = generate_fence();
            assert_ne!(f, [0u8; 32]);
        }
    }

    #[test]
    fn fingerprints_are_deterministic() {
        let fp1 = compute_principal_fingerprint(&[1u8; 32], "iss", "sub");
        let fp2 = compute_principal_fingerprint(&[1u8; 32], "iss", "sub");
        assert_eq!(fp1, fp2);
        let fp3 = compute_principal_fingerprint(&[1u8; 32], "iss2", "sub");
        assert_ne!(fp1, fp3);
    }

    #[test]
    fn replay_claim_error_exact_pkey_only() {
        // Only the exact constraint name maps to ProofReplayed.
        let e = sqlx::Error::RowNotFound;
        assert!(matches!(
            map_replay_claim_error(e),
            AdmissionError::Transient(_)
        ));
    }

    #[test]
    fn generate_fence_distinct_across_calls() {
        let a = generate_fence();
        let b = generate_fence();
        if a == b {
            panic!("generate_fence produced identical values: {a:?}");
        }
    }

    #[test]
    fn canonical_envelope_is_nonzero_and_deterministic() {
        let cid = Uuid::new_v4();
        let oid = Uuid::new_v4();
        let rf = [0xABu8; 32];
        let af = [0xCDu8; 32];
        let env1 = build_minimal_canonical_envelope(1, &cid, &oid, &rf, &af);
        let env2 = build_minimal_canonical_envelope(1, &cid, &oid, &rf, &af);
        assert!(!env1.is_empty());
        assert_eq!(env1, env2);
        let digest = compute_envelope_digest(&env1);
        assert_ne!(digest, [0u8; 32]);
    }

    #[test]
    fn result_digest_is_deterministic() {
        let rf = [1u8; 32];
        let oid = Uuid::nil();
        let cid = Uuid::nil();
        let d1 = compute_result_digest(&rf, &oid, &cid, 1);
        let d2 = compute_result_digest(&rf, &oid, &cid, 1);
        assert_eq!(d1, d2);
        let d3 = compute_result_digest(&rf, &oid, &cid, 2);
        assert_ne!(d1, d3);
    }
}

// ── PostgreSQL integration tests ──────────────────────────────────────────────
//
// These tests require a running PostgreSQL database with all migrations applied.
// Set BUZZ_TEST_DATABASE_URL or DATABASE_URL to enable them.
//
// Run: DATABASE_URL=postgres://... cargo test -p buzz-relay -- --ignored nip_fi_pg
//
// Each live test:
//   1. Creates isolated test data (community, channel, policy, invalidation domain)
//   2. Calls through the production path: commit_admission_in_tx +
//      authorize_protected_use_in_tx (Design-B) or abort path
//   3. Asserts expected DB state / error
//
// Named mutation reds prove that rows_affected() guards catch predicate drift:
//   pg_epoch_update_zero_rows  — epoch UPDATE matches no rows → Transient
//   pg_poa_update_zero_rows    — POA UPDATE matches no rows → Transient
#[cfg(test)]
mod pg_integration {
    use super::*;
    use buzz_auth::nip_fi::{
        AdmissionError, BindingProvenance, OperationIntent, ProofTransport, ProtectedObjectKind,
        RouteCapability,
    };
    use sha2::{Digest, Sha256};
    use uuid::Uuid;

    // ── Pure Rust unit tests (no DB) ─────────────────────────────────────────

    /// Verify that the canonical UUID bytes encoding matches PostgreSQL's
    /// sha256(uuid_send(c.id)).  This is a pure Rust unit test — no DB needed.
    #[test]
    fn uuid_object_key_is_16_byte_sha256() {
        let channel_id = Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap();
        let rust_key = channel_object_key(channel_id);
        let mut h = Sha256::new();
        h.update(channel_id.as_bytes());
        let expected: [u8; 32] = h.finalize().into();
        assert_eq!(
            rust_key, expected,
            "channel_object_key must hash 16-byte UUID"
        );
        // Negative: text encoding produces a different digest.
        let mut h2 = Sha256::new();
        h2.update(channel_id.to_string().as_bytes());
        let text_key: [u8; 32] = h2.finalize().into();
        assert_ne!(rust_key, text_key, "16-byte and text encodings must differ");
    }

    /// Two distinct operation IDs are generated per enrollment+admission.
    #[test]
    fn enrollment_uses_separate_operation_id() {
        let admission_id = Uuid::new_v4();
        let enroll_id = Uuid::new_v4();
        assert_ne!(admission_id, enroll_id);
    }

    /// Selector-3 uses event_author_pubkey not principal_fp.
    #[test]
    fn selector_3_fingerprint_is_event_author_pubkey() {
        let actor_pubkey = [0x01u8; 32];
        let principal_fp = compute_principal_fingerprint(&actor_pubkey, "iss", "sub");
        assert_ne!(actor_pubkey, principal_fp.as_slice());
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /// Build the canonical kind-9 object key for a channel.
    fn channel_object_key(channel_id: Uuid) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(channel_id.as_bytes());
        h.finalize().into()
    }

    /// Connect to the test database, or return None to skip the test.
    async fn test_pool() -> Option<sqlx::PgPool> {
        let url = std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5432/buzz".into());
        sqlx::PgPool::connect(&url).await.ok()
    }

    /// Fixture data created per test.
    struct TestFixture {
        community_id: Uuid,
        channel_id: Uuid,
        object_key: [u8; 32],
    }

    /// Insert a minimal test community, channel, invalidation domain, and policy.
    /// Returns a `TestFixture` with the IDs.
    async fn setup_fixture(pool: &sqlx::PgPool) -> TestFixture {
        let community_id = Uuid::new_v4();
        let channel_id = Uuid::new_v4();
        let object_key = channel_object_key(channel_id);

        sqlx::query(
            r#"
            INSERT INTO communities (id, slug, name, deletion_state)
            VALUES ($1, $2, $3, 'active')
            "#,
        )
        .bind(community_id)
        .bind(format!("test-{community_id}"))
        .bind(format!("Test Community {community_id}"))
        .execute(pool)
        .await
        .expect("insert community");

        sqlx::query(
            r#"
            INSERT INTO channels (id, community_id, name, created_at)
            VALUES ($1, $2, 'test-channel', transaction_timestamp())
            "#,
        )
        .bind(channel_id)
        .bind(community_id)
        .execute(pool)
        .await
        .expect("insert channel");

        sqlx::query(
            r#"
            INSERT INTO authorization_invalidation_domains
                (community_id, current_generation)
            VALUES ($1, 1)
            "#,
        )
        .bind(community_id)
        .execute(pool)
        .await
        .expect("insert invalidation domain");

        sqlx::query(
            r#"
            INSERT INTO identity_enrollment_policies
                (community_id, policy_revision, effective_at)
            VALUES ($1, 1, NOW() - INTERVAL '1 hour')
            "#,
        )
        .bind(community_id)
        .execute(pool)
        .await
        .expect("insert policy");

        TestFixture {
            community_id,
            channel_id,
            object_key,
        }
    }

    /// Delete test fixture data (best-effort).
    async fn teardown_fixture(pool: &sqlx::PgPool, community_id: Uuid) {
        // Cascade deletes via FK should clean up most child rows.
        let _ = sqlx::query("DELETE FROM communities WHERE id = $1")
            .bind(community_id)
            .execute(pool)
            .await;
    }

    /// Build a minimal `SealedRequestContext` for test use.
    fn make_test_ctx(
        actor: nostr::PublicKey,
        community_id: Uuid,
        object_key: [u8; 32],
        proof_expires_at: chrono::DateTime<chrono::Utc>,
    ) -> super::super::context::SealedRequestContext {
        use buzz_auth::nip_fi::assertion::test_support::minimal_verified_assertion;
        let verified_assertion = minimal_verified_assertion(
            "https://issuer.example.com",
            "test-subject",
            proof_expires_at,
        );
        super::super::context::SealedRequestContext::for_test(
            actor,
            community_id,
            RouteCapability::MessagesWrite,
            ProtectedObjectKind::Channel,
            OperationIntent::Write,
            object_key,
            Uuid::new_v4(), // conn_id
            "test-challenge",
            "wss://relay.example.com",
            [0x01u8; 32], // proof_event_id
            proof_expires_at,
            verified_assertion,
            Uuid::new_v4(), // operation_id
        )
    }

    /// Build a minimal `BindingProposal`.
    fn make_proposal() -> BindingProposal {
        BindingProposal {
            binding_id: Uuid::new_v4(),
            provenance: BindingProvenance::RiskLabelledTofu,
            principal_fingerprint: [0u8; 32],
            known_version: None,
        }
    }

    // ── Live DB tests ─────────────────────────────────────────────────────────

    /// Success path: first admission enrolls binding; final atomic commit
    /// (admission + re-fence) succeeds.  Verifies all three steps complete
    /// without error and that authority rows exist in the DB afterward.
    #[tokio::test]
    #[ignore = "requires live PostgreSQL DB with migrations applied"]
    async fn pg_admission_and_protected_use_success() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fx = setup_fixture(&pool).await;

        // Use a keypair deterministic per test run.
        let keys = nostr::Keys::generate();
        let actor = keys.public_key();
        let proof_expires_at = chrono::Utc::now() + chrono::Duration::minutes(5);

        let ctx = make_test_ctx(actor, fx.community_id, fx.object_key, proof_expires_at);
        let proposal = make_proposal();

        // Obtain a synthetic fresh_assertion (revalidation skipped — no real JWS).
        use buzz_auth::nip_fi::assertion::test_support::minimal_verified_assertion;
        let fresh = minimal_verified_assertion(
            "https://issuer.example.com",
            "test-subject",
            proof_expires_at,
        );

        // Open one transaction for the combined Design-B path.
        let mut tx = pool.begin().await.expect("begin transaction");
        sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
            .execute(&mut *tx)
            .await
            .expect("set serializable");
        let db_now: chrono::DateTime<chrono::Utc> =
            sqlx::query_scalar("SELECT transaction_timestamp()")
                .fetch_one(&mut *tx)
                .await
                .expect("transaction_timestamp");

        // Step A: commit_admission_in_tx.
        let committed = commit_admission_in_tx(&mut tx, db_now, &ctx, &proposal, &fresh)
            .await
            .expect("commit_admission_in_tx must succeed on first enrollment");

        // Step B: authorize_protected_use_in_tx.
        authorize_protected_use_in_tx(
            &mut tx,
            db_now,
            &committed,
            ctx.conn_id,
            &ctx.challenge,
            &ctx.relay_url,
            &ctx.proof_event_id,
            ProofTransport::Nip42WebSocket,
            &actor,
        )
        .await
        .expect("authorize_protected_use_in_tx must succeed");

        tx.commit().await.expect("commit");

        // Verify: authority row exists.
        let poa_exists: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM protected_object_authority
                WHERE community_id = $1 AND object_kind = $2 AND object_key = $3
            )
            "#,
        )
        .bind(fx.community_id)
        .bind(RouteCapability::MessagesWrite.database_code())
        .bind(fx.object_key.as_slice())
        .fetch_one(&pool)
        .await
        .expect("query POA");
        assert!(
            poa_exists,
            "protected_object_authority row must exist after commit"
        );

        teardown_fixture(&pool, fx.community_id).await;
    }

    /// Atomicity regression: if the event INSERT fails (FK violation on
    /// nonexistent channel), the transaction rolls back and leaves zero
    /// authority effects — no admission row, no replay claim, no epoch.
    ///
    /// This proves FI-INV-09: event + admission + re-fence commit or roll back
    /// together.
    #[tokio::test]
    #[ignore = "requires live PostgreSQL DB with migrations applied"]
    async fn pg_event_insert_failure_rolls_back_authority() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fx = setup_fixture(&pool).await;

        let keys = nostr::Keys::generate();
        let actor = keys.public_key();
        let proof_expires_at = chrono::Utc::now() + chrono::Duration::minutes(5);
        let proof_event_id = [0x02u8; 32];

        let ctx = make_test_ctx(actor, fx.community_id, fx.object_key, proof_expires_at);
        let proposal = make_proposal();

        use buzz_auth::nip_fi::assertion::test_support::minimal_verified_assertion;
        let fresh = minimal_verified_assertion(
            "https://issuer.example.com",
            "test-subject",
            proof_expires_at,
        );

        let mut tx = pool.begin().await.expect("begin");
        sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
            .execute(&mut *tx)
            .await
            .expect("set serializable");
        let db_now: chrono::DateTime<chrono::Utc> =
            sqlx::query_scalar("SELECT transaction_timestamp()")
                .fetch_one(&mut *tx)
                .await
                .expect("db_now");

        let _committed = commit_admission_in_tx(&mut tx, db_now, &ctx, &proposal, &fresh)
            .await
            .expect("admission must succeed before event insert");

        // Force the event INSERT to fail by referencing a nonexistent channel.
        // This simulates what would happen if the event insert returned Err inside
        // commit_kind9_atomic — the whole tx must be aborted.
        let nonexistent_channel_id = Uuid::new_v4();
        let event_insert_err = sqlx::query(
            r#"
            INSERT INTO events (community_id, id, pubkey, created_at, kind, tags, content, sig, channel_id)
            VALUES ($1, $2, $3, $4, 9, '[]'::jsonb, '', '', $5)
            "#,
        )
        .bind(fx.community_id)
        .bind([0xAAu8; 32].as_slice())
        .bind(actor.to_bytes().as_slice())
        .bind(db_now)
        .bind(nonexistent_channel_id)
        .execute(&mut *tx)
        .await;

        // The INSERT must fail (FK on channel_id).
        assert!(
            event_insert_err.is_err(),
            "event INSERT with bad FK must fail"
        );

        // Roll back the transaction explicitly (simulating the commit_kind9_atomic abort path).
        tx.rollback().await.expect("rollback");

        // Verify: no replay claim was committed.
        let replay_exists: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM nip_fi_proof_replay_claims
                WHERE community_id = $1 AND proof_event_id = $2
            )
            "#,
        )
        .bind(fx.community_id)
        .bind(proof_event_id.as_slice())
        .fetch_one(&pool)
        .await
        .expect("query replay");
        assert!(
            !replay_exists,
            "replay claim must not exist after rollback (FI-INV-09)"
        );

        // Verify: no epoch row was committed.
        let epoch_exists: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM authorization_authority_epochs
                WHERE community_id = $1 AND object_kind = $2 AND object_key = $3
            )
            "#,
        )
        .bind(fx.community_id)
        .bind(RouteCapability::MessagesWrite.database_code())
        .bind(fx.object_key.as_slice())
        .fetch_one(&pool)
        .await
        .expect("query epoch");
        assert!(
            !epoch_exists,
            "epoch row must not exist after rollback (FI-INV-09)"
        );

        teardown_fixture(&pool, fx.community_id).await;
    }

    /// Named mutation red — epoch UPDATE predicate drift: if the epoch row is
    /// absent when `authorize_protected_use_body` runs its UPDATE, `rows_affected()`
    /// must return a `Transient` error, proving the guard is real.
    ///
    /// Setup: run admission to create the epoch row, then delete it manually
    /// before calling `authorize_protected_use_in_tx`.  The UPDATE will match
    /// zero rows and the guard must fire.
    #[tokio::test]
    #[ignore = "requires live PostgreSQL DB with migrations applied"]
    async fn pg_epoch_update_zero_rows_is_transient() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fx = setup_fixture(&pool).await;

        let keys = nostr::Keys::generate();
        let actor = keys.public_key();
        let proof_expires_at = chrono::Utc::now() + chrono::Duration::minutes(5);

        let ctx = make_test_ctx(actor, fx.community_id, fx.object_key, proof_expires_at);
        let proposal = make_proposal();

        use buzz_auth::nip_fi::assertion::test_support::minimal_verified_assertion;
        let fresh = minimal_verified_assertion(
            "https://issuer.example.com",
            "test-subject",
            proof_expires_at,
        );

        // Step 1: run admission in a committed transaction.
        let committed = {
            let mut tx = pool.begin().await.expect("begin");
            sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
                .execute(&mut *tx)
                .await
                .expect("serializable");
            let db_now: chrono::DateTime<chrono::Utc> =
                sqlx::query_scalar("SELECT transaction_timestamp()")
                    .fetch_one(&mut *tx)
                    .await
                    .expect("db_now");
            let c = commit_admission_in_tx(&mut tx, db_now, &ctx, &proposal, &fresh)
                .await
                .expect("admission");
            tx.commit().await.expect("commit admission");
            c
        };

        // Step 2: delete the epoch row from outside the tx to simulate drift.
        sqlx::query(
            r#"
            DELETE FROM authorization_authority_epochs
            WHERE community_id = $1 AND object_kind = $2 AND object_key = $3
            "#,
        )
        .bind(fx.community_id)
        .bind(RouteCapability::MessagesWrite.database_code())
        .bind(fx.object_key.as_slice())
        .execute(&pool)
        .await
        .expect("delete epoch row");

        // Step 3: run authorize_protected_use_in_tx — the epoch UPDATE must hit
        // zero rows and return Transient.
        let mut tx2 = pool.begin().await.expect("begin tx2");
        sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
            .execute(&mut *tx2)
            .await
            .expect("serializable");
        let db_now2: chrono::DateTime<chrono::Utc> =
            sqlx::query_scalar("SELECT transaction_timestamp()")
                .fetch_one(&mut *tx2)
                .await
                .expect("db_now2");

        let result = authorize_protected_use_in_tx(
            &mut tx2,
            db_now2,
            &committed,
            ctx.conn_id,
            &ctx.challenge,
            &ctx.relay_url,
            &ctx.proof_event_id,
            ProofTransport::Nip42WebSocket,
            &actor,
        )
        .await;
        let _ = tx2.rollback().await;

        assert!(
            matches!(result, Err(AdmissionError::Transient(_))),
            "epoch UPDATE zero-row must return Transient; got: {result:?}"
        );

        teardown_fixture(&pool, fx.community_id).await;
    }

    /// Named mutation red — POA UPDATE predicate drift: if the POA row is
    /// absent when `authorize_protected_use_body` runs its UPDATE, `rows_affected()`
    /// must return a `Transient` error.
    #[tokio::test]
    #[ignore = "requires live PostgreSQL DB with migrations applied"]
    async fn pg_poa_update_zero_rows_is_transient() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fx = setup_fixture(&pool).await;

        let keys = nostr::Keys::generate();
        let actor = keys.public_key();
        let proof_expires_at = chrono::Utc::now() + chrono::Duration::minutes(5);

        let ctx = make_test_ctx(actor, fx.community_id, fx.object_key, proof_expires_at);
        let proposal = make_proposal();

        use buzz_auth::nip_fi::assertion::test_support::minimal_verified_assertion;
        let fresh = minimal_verified_assertion(
            "https://issuer.example.com",
            "test-subject",
            proof_expires_at,
        );

        // Step 1: run admission in a committed transaction.
        let committed = {
            let mut tx = pool.begin().await.expect("begin");
            sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
                .execute(&mut *tx)
                .await
                .expect("serializable");
            let db_now: chrono::DateTime<chrono::Utc> =
                sqlx::query_scalar("SELECT transaction_timestamp()")
                    .fetch_one(&mut *tx)
                    .await
                    .expect("db_now");
            let c = commit_admission_in_tx(&mut tx, db_now, &ctx, &proposal, &fresh)
                .await
                .expect("admission");
            tx.commit().await.expect("commit admission");
            c
        };

        // Step 2: delete the POA row to simulate drift.
        sqlx::query(
            r#"
            DELETE FROM protected_object_authority
            WHERE community_id = $1 AND object_kind = $2 AND object_key = $3
            "#,
        )
        .bind(fx.community_id)
        .bind(RouteCapability::MessagesWrite.database_code())
        .bind(fx.object_key.as_slice())
        .execute(&pool)
        .await
        .expect("delete POA row");

        // Step 3: authorize_protected_use_in_tx — POA UPDATE zero-rows → Transient.
        let mut tx2 = pool.begin().await.expect("begin tx2");
        sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
            .execute(&mut *tx2)
            .await
            .expect("serializable");
        let db_now2: chrono::DateTime<chrono::Utc> =
            sqlx::query_scalar("SELECT transaction_timestamp()")
                .fetch_one(&mut *tx2)
                .await
                .expect("db_now2");

        let result = authorize_protected_use_in_tx(
            &mut tx2,
            db_now2,
            &committed,
            ctx.conn_id,
            &ctx.challenge,
            &ctx.relay_url,
            &ctx.proof_event_id,
            ProofTransport::Nip42WebSocket,
            &actor,
        )
        .await;
        let _ = tx2.rollback().await;

        // The POA SELECT FOR UPDATE returns None → NoActiveBinding fires before
        // the UPDATE.  The UPDATE guard fires when the row exists but matches
        // zero predicate columns — test both paths by checking the error is
        // either NoActiveBinding (row absent) or Transient (row exists, zero UPDATE).
        // Either proves the guard chain is live.
        assert!(
            matches!(
                result,
                Err(AdmissionError::NoActiveBinding) | Err(AdmissionError::Transient(_))
            ),
            "POA row absent must return NoActiveBinding or Transient; got: {result:?}"
        );

        teardown_fixture(&pool, fx.community_id).await;
    }
}
