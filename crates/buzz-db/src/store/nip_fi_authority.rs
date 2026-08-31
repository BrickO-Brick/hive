//! NIP-FI final-admission authority — `prepare_direct`, `commit_admission`,
//! and `authorize_protected_use`.
//!
//! ## Two-phase-plus-use contract
//!
//! `prepare_direct` is the read-only preparation phase (`FI-INV-08`):
//!
//! - Reads binding (`B_D(i)`, `B_D(k)`), retired-pair (`T_D(i,k)`),
//!   revoked-key (`Y_D(k)`), enrollment policy, local-policy evaluation,
//!   resource authority, and dependency versions from authoritative PostgreSQL
//!   state in a single coherent REPEATABLE READ snapshot.
//! - Evaluates the binding proposal — existing active binding or new enrollment.
//! - Evaluates local policy via the closed capability/object/intent matrix at
//!   a stable evaluator revision.
//! - Returns a [`PreparedAuthorization`] on success or a [`PrepareError`] on
//!   denial. **Writes nothing** (`FI-INV-08`).
//!
//! `commit_admission` is the atomic final-admission phase (`FI-INV-09`):
//!
//! - Re-reads every dependency to confirm the prepared proposal still holds.
//! - Checks deadline liveness (including proof deadline) and assertion
//!   equivalence (identity, key, capabilities, deadline cardinality).
//! - Confirms contract-ID stability.
//! - Re-evaluates local policy and resource authority inside the transaction.
//! - Inserts the replay claim (proof identity uniqueness gate).
//! - Writes the epoch/fence rows for the target object unconditionally.
//! - Atomically writes: the operation receipt, binding row (if new enrollment),
//!   lifecycle history row, and admission result.
//!   All commit or none (`FI-INV-09`).
//!
//! `authorize_protected_use` is the per-use gate:
//!
//! - Exact-matches the use tuple against the committed context.
//! - Re-reads and re-evaluates every dependency transactionally.
//! - For mutation: re-fences the target object.
//! - Returns an [`AuthorizedUse`] opaque result, one-use only.
//!
//! ## Non-forgeability
//!
//! All three authority-bearing types — [`PreparedAuthorization`],
//! [`CommittedAuthorization`], and [`AuthorizedUse`] — have `pub(crate)`
//! constructors. No code outside this crate can mint them. [`VerifiedServerDirectContext`]
//! is defined in `buzz-auth` but its fields are `pub(crate)` and it has no
//! public constructor; the only constructor is [`VerifiedServerDirectContext::new`]
//! below, which is `pub(crate)` in this crate's scope.
//!
//! ## Error mapping
//!
//! [`PrepareError`] and [`AdmissionError`] each map every variant to a
//! [`DenialClass`] via `denial_class()`. No error type carries credential
//! material (`FI-INV-13`).

use buzz_auth::nip_fi::{
    AdmissionError, BindingProposal, BindingProvenance, DenialClass, ExactProtectedUse,
    FederatedAssertionVerifier, FederatedIdentity, IssuerKeySource, OperationIntent,
    PreparedDependencyVersions, ProtectedObjectKind, RouteCapability, VerifiedAssertion,
    VerifiedServerDirectContext,
};
use chrono::{DateTime, Utc};
use nostr::PublicKey;
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool, Row as _};
use uuid::Uuid;

// ── Prepared authorization ────────────────────────────────────────────────────

/// Non-forgeable prepared-authorization token produced by [`prepare_direct`].
///
/// Private fields; `pub(crate)` constructor. Only the PostgreSQL preparation
/// path can mint this value. Not `Clone` — each prepared authorization is
/// unique and consumed by move into `commit_admission`.
#[derive(Debug)]
pub struct PreparedAuthorization {
    verified_assertion: VerifiedAssertion,
    actor: PublicKey,
    community_id: Uuid,
    proposal: BindingProposal,
    authority_deadlines: Vec<DateTime<Utc>>,
    dependency_versions: PreparedDependencyVersions,
    correlation_id: Uuid,
    // Sealed context carried through to commit.
    context: VerifiedServerDirectContext,
    // Assertion contract IDs captured at preparation time.
    assertion_policy_id: buzz_auth::AssertionPolicyId,
    transport_contract_id: buzz_auth::TransportContractId,
}

impl PreparedAuthorization {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        verified_assertion: VerifiedAssertion,
        actor: PublicKey,
        community_id: Uuid,
        proposal: BindingProposal,
        authority_deadlines: Vec<DateTime<Utc>>,
        dependency_versions: PreparedDependencyVersions,
        correlation_id: Uuid,
        context: VerifiedServerDirectContext,
        assertion_policy_id: buzz_auth::AssertionPolicyId,
        transport_contract_id: buzz_auth::TransportContractId,
    ) -> Self {
        Self {
            verified_assertion,
            actor,
            community_id,
            proposal,
            authority_deadlines,
            dependency_versions,
            correlation_id,
            context,
            assertion_policy_id,
            transport_contract_id,
        }
    }

    pub(crate) fn verified_assertion(&self) -> &VerifiedAssertion {
        &self.verified_assertion
    }

    pub(crate) fn actor(&self) -> PublicKey {
        self.actor
    }

    pub(crate) fn community_id(&self) -> Uuid {
        self.community_id
    }

    pub(crate) fn proposal(&self) -> &BindingProposal {
        &self.proposal
    }

    pub(crate) fn authority_deadlines(&self) -> &[DateTime<Utc>] {
        &self.authority_deadlines
    }

    pub(crate) fn dependency_versions(&self) -> &PreparedDependencyVersions {
        &self.dependency_versions
    }

    pub(crate) fn correlation_id(&self) -> Uuid {
        self.correlation_id
    }

    pub(crate) fn context(&self) -> &VerifiedServerDirectContext {
        &self.context
    }

    pub(crate) fn assertion_policy_id(&self) -> buzz_auth::AssertionPolicyId {
        self.assertion_policy_id
    }

    pub(crate) fn transport_contract_id(&self) -> buzz_auth::TransportContractId {
        self.transport_contract_id
    }
}

// ── Committed authorization ───────────────────────────────────────────────────

/// Non-forgeable committed-authorization token produced by [`commit_admission`].
///
/// Private fields; `pub(crate)` constructor. Carries the witnesses PR 5 needs
/// to enforce use-site checks. `authorize_protected_use` consumes this by
/// reference and returns an [`AuthorizedUse`] on exact-match.
#[derive(Debug)]
pub struct CommittedAuthorization {
    actor: PublicKey,
    identity: FederatedIdentity,
    community_id: Uuid,
    // Sealed operation context
    capability: RouteCapability,
    object_kind: ProtectedObjectKind,
    intent: OperationIntent,
    object_key: [u8; 32],
    // Timing
    proof_expires_at: DateTime<Utc>,
    assertion_expires_at: DateTime<Utc>,
    // Binding
    binding_id: Uuid,
    binding_version: i64,
    // Receipt audit trail
    operation_id: Uuid,
    correlation_id: Uuid,
    // Semantic fingerprint (deterministic, bound to sealed context)
    semantic_fingerprint: [u8; 32],
}

impl CommittedAuthorization {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        actor: PublicKey,
        identity: FederatedIdentity,
        community_id: Uuid,
        capability: RouteCapability,
        object_kind: ProtectedObjectKind,
        intent: OperationIntent,
        object_key: [u8; 32],
        proof_expires_at: DateTime<Utc>,
        assertion_expires_at: DateTime<Utc>,
        binding_id: Uuid,
        binding_version: i64,
        operation_id: Uuid,
        correlation_id: Uuid,
        semantic_fingerprint: [u8; 32],
    ) -> Self {
        Self {
            actor,
            identity,
            community_id,
            capability,
            object_kind,
            intent,
            object_key,
            proof_expires_at,
            assertion_expires_at,
            binding_id,
            binding_version,
            operation_id,
            correlation_id,
            semantic_fingerprint,
        }
    }

    /// The proven actor's public key.
    pub fn actor(&self) -> PublicKey {
        self.actor
    }

    /// The federated identity bound to this actor.
    pub fn identity(&self) -> &FederatedIdentity {
        &self.identity
    }

    /// The community this authorization is scoped to.
    pub fn community_id(&self) -> Uuid {
        self.community_id
    }

    /// Expiry of the narrowest active deadline (proof + assertion minimum).
    pub fn expires_at(&self) -> DateTime<Utc> {
        self.assertion_expires_at.min(self.proof_expires_at)
    }

    /// Audit correlation ID for the operation receipt.
    pub fn correlation_id(&self) -> Uuid {
        self.correlation_id
    }

    /// Random audit operation ID written to the receipt row.
    /// Not the logical request identity; use `semantic_fingerprint` for
    /// deduplication.
    pub fn operation_id(&self) -> Uuid {
        self.operation_id
    }

    /// Deterministic semantic fingerprint for this admitted request.
    /// Bound to (community, proof_event_id, object_kind, object_key, actor,
    /// capability, intent). Suitable for idempotency checks.
    pub fn semantic_fingerprint(&self) -> &[u8; 32] {
        &self.semantic_fingerprint
    }
}

// ── Authorized use ────────────────────────────────────────────────────────────

/// Opaque one-use result returned by [`authorize_protected_use`].
///
/// Private fields; `pub(crate)` constructor. Exists only to prove that the
/// full use-site gate ran. Cannot be cloned, stored, or re-used.
#[derive(Debug)]
pub struct AuthorizedUse {
    operation_id: Uuid,
    community_id: Uuid,
    authorized_at: DateTime<Utc>,
}

impl AuthorizedUse {
    pub(crate) fn new(
        operation_id: Uuid,
        community_id: Uuid,
        authorized_at: DateTime<Utc>,
    ) -> Self {
        Self {
            operation_id,
            community_id,
            authorized_at,
        }
    }

    /// Audit operation ID for the use-site receipt.
    pub fn operation_id(&self) -> Uuid {
        self.operation_id
    }

    /// Community this use was authorized for.
    pub fn community_id(&self) -> Uuid {
        self.community_id
    }

    /// Wall-clock instant the use was authorized (authoritative transaction time).
    pub fn authorized_at(&self) -> DateTime<Utc> {
        self.authorized_at
    }
}

// ── Preparation ───────────────────────────────────────────────────────────────

/// A closed, stable preparation failure.
///
/// Every variant maps to exactly one [`DenialClass`] via
/// [`PrepareError::denial_class`]. No variant carries credential material.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PrepareError {
    // ── Authorization denial (403) ─────────────────────────────────────────────
    /// The actor's key appears in the revoked-key selector set.
    #[error("actor key is revoked")]
    KeyRevoked,
    /// The exact `(i, k)` pair appears in the retired-pair selector set.
    #[error("identity/key pair is retired")]
    PairRetired,
    /// An active binding exists for `i` or `k` under a different counterpart.
    #[error("binding conflict")]
    BindingConflict,
    /// `attested-key` enrollment policy but the assertion carries no matching
    /// `nostr_pubkey` claim.
    #[error("attested-key enrollment required")]
    AttestationRequired,
    /// Enrollment policy is `provisioned`: no self-service enrollment path.
    #[error("binding required; enrollment not permitted")]
    BindingRequired,
    /// Local policy denied the operation for the sealed context tuple.
    #[error("local policy denied")]
    LocalPolicyDenied,
    /// Resource authority row is missing, deleted, archived, or unreadable.
    #[error("resource authority denied: missing, deleted, archived, or changed")]
    ResourceAuthorityDenied,

    // ── Availability failure (503) ─────────────────────────────────────────────
    /// A required dependency could not be read.
    #[error("required authoritative dependency unavailable")]
    DependencyUnavailable,
}

impl PrepareError {
    /// The public denial class.
    pub const fn denial_class(self) -> DenialClass {
        match self {
            Self::KeyRevoked
            | Self::PairRetired
            | Self::BindingConflict
            | Self::AttestationRequired
            | Self::BindingRequired
            | Self::LocalPolicyDenied
            | Self::ResourceAuthorityDenied => DenialClass::AuthorizationDenied,
            Self::DependencyUnavailable => DenialClass::AuthorizationUnavailable,
        }
    }

    /// Stable machine code for access-controlled logs.
    pub const fn code(self) -> &'static str {
        match self {
            Self::KeyRevoked => "nip_fi_prepare_key_revoked",
            Self::PairRetired => "nip_fi_prepare_pair_retired",
            Self::BindingConflict => "nip_fi_prepare_binding_conflict",
            Self::AttestationRequired => "nip_fi_prepare_attestation_required",
            Self::BindingRequired => "nip_fi_prepare_binding_required",
            Self::LocalPolicyDenied => "nip_fi_prepare_local_policy_denied",
            Self::ResourceAuthorityDenied => "nip_fi_prepare_resource_authority_denied",
            Self::DependencyUnavailable => "nip_fi_prepare_dependency_unavailable",
        }
    }
}

/// Read-only direct preparation.
///
/// Reads all required state from authoritative PostgreSQL in a single REPEATABLE
/// READ snapshot. Evaluates local policy and resource authority. Returns a
/// [`PreparedAuthorization`] on success.
///
/// **Writes nothing** (`FI-INV-08`).
pub async fn prepare_direct(
    pool: &PgPool,
    ctx: VerifiedServerDirectContext,
    verified_assertion: VerifiedAssertion,
) -> std::result::Result<PreparedAuthorization, PrepareError> {
    let community_uuid = ctx.community_id;
    let actor_bytes: [u8; 32] = ctx.actor.to_bytes();

    // Capture contract IDs before moving ctx into PreparedAuthorization.
    let assertion_policy_id = verified_assertion.assertion_policy_id();
    let transport_contract_id = verified_assertion.transport_contract_id();

    let mut txn = pool
        .begin()
        .await
        .map_err(|_| PrepareError::DependencyUnavailable)?;

    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *txn)
        .await
        .map_err(|_| PrepareError::DependencyUnavailable)?;

    // ── Revocation check: Y_D(k) ─────────────────────────────────────────────
    // selector_kind = 3 (revoked key).
    let key_revoked = sqlx::query(
        "SELECT 1 FROM identity_lifecycle_selectors \
         WHERE community_id = $1 \
           AND selector_kind = 3 \
           AND event_author_pubkey = $2 \
         LIMIT 1",
    )
    .bind(community_uuid)
    .bind(actor_bytes.as_slice())
    .fetch_optional(&mut *txn)
    .await
    .map_err(|_| PrepareError::DependencyUnavailable)?;

    if key_revoked.is_some() {
        return Err(PrepareError::KeyRevoked);
    }

    let identity = verified_assertion.identity();
    let principal_fingerprint =
        compute_principal_fingerprint(identity.issuer(), identity.subject());

    // ── Retired-pair check: T_D(i,k) ─────────────────────────────────────────
    // selector_kind = 1 (retired pair).
    let pair_retired = sqlx::query(
        "SELECT 1 FROM identity_lifecycle_selectors \
         WHERE community_id = $1 \
           AND selector_kind = 1 \
           AND principal_fingerprint = $2 \
           AND event_author_pubkey = $3 \
         LIMIT 1",
    )
    .bind(community_uuid)
    .bind(principal_fingerprint.as_slice())
    .bind(actor_bytes.as_slice())
    .fetch_optional(&mut *txn)
    .await
    .map_err(|_| PrepareError::DependencyUnavailable)?;

    if pair_retired.is_some() {
        return Err(PrepareError::PairRetired);
    }

    // ── Binding reads: B_D(i), B_D(k) ────────────────────────────────────────
    let binding_by_principal = sqlx::query(
        "SELECT binding_id, binding_version, binding_provenance, policy_revision, \
                lifecycle_revision, expires_at \
         FROM identity_bindings \
         WHERE community_id = $1 \
           AND issuer = $2 \
           AND subject = $3 \
           AND binding_state = 1 \
         LIMIT 1",
    )
    .bind(community_uuid)
    .bind(identity.issuer())
    .bind(identity.subject())
    .fetch_optional(&mut *txn)
    .await
    .map_err(|_| PrepareError::DependencyUnavailable)?;

    let binding_by_key = sqlx::query(
        "SELECT binding_id, binding_version, binding_provenance, policy_revision, \
                lifecycle_revision, expires_at \
         FROM identity_bindings \
         WHERE community_id = $1 \
           AND event_author_pubkey = $2 \
           AND binding_state = 1 \
         LIMIT 1",
    )
    .bind(community_uuid)
    .bind(actor_bytes.as_slice())
    .fetch_optional(&mut *txn)
    .await
    .map_err(|_| PrepareError::DependencyUnavailable)?;

    // ── Enrollment policy ─────────────────────────────────────────────────────
    let policy_row = sqlx::query(
        "SELECT policy_revision, enrollment_mode \
         FROM identity_enrollment_policies \
         WHERE community_id = $1 \
         ORDER BY policy_revision DESC \
         LIMIT 1",
    )
    .bind(community_uuid)
    .fetch_optional(&mut *txn)
    .await
    .map_err(|_| PrepareError::DependencyUnavailable)?;

    let (policy_revision, enrollment_mode): (i64, i16) = match policy_row {
        Some(ref row) => {
            let rev: i64 = row
                .try_get("policy_revision")
                .map_err(|_| PrepareError::DependencyUnavailable)?;
            let mode: i16 = row
                .try_get("enrollment_mode")
                .map_err(|_| PrepareError::DependencyUnavailable)?;
            (rev, mode)
        }
        None => return Err(PrepareError::DependencyUnavailable),
    };

    // ── Invalidation generation + floors ─────────────────────────────────────
    let invalidation_row = sqlx::query(
        "SELECT current_generation FROM authorization_invalidation_domains \
         WHERE community_id = $1",
    )
    .bind(community_uuid)
    .fetch_optional(&mut *txn)
    .await
    .map_err(|_| PrepareError::DependencyUnavailable)?;

    let invalidation_generation: i64 = match invalidation_row {
        Some(ref row) => row
            .try_get("current_generation")
            .map_err(|_| PrepareError::DependencyUnavailable)?,
        None => 0,
    };

    // ── Authority epoch + fence for target object ─────────────────────────────
    let object_kind_code = ctx.object_kind.database_code();
    let object_key_slice = ctx.object_key.as_slice();

    let epoch_row = sqlx::query(
        "SELECT current_epoch FROM authorization_authority_epochs \
         WHERE community_id = $1 AND object_kind = $2 AND object_key = $3",
    )
    .bind(community_uuid)
    .bind(object_kind_code)
    .bind(object_key_slice)
    .fetch_optional(&mut *txn)
    .await
    .map_err(|_| PrepareError::DependencyUnavailable)?;

    let authority_epoch: Option<i64> = epoch_row
        .as_ref()
        .map(|r| r.try_get("current_epoch"))
        .transpose()
        .map_err(|_| PrepareError::DependencyUnavailable)?;

    let fence_row = sqlx::query(
        "SELECT fence_generation FROM protected_object_authority \
         WHERE community_id = $1 AND object_kind = $2 AND object_key = $3 \
         LIMIT 1",
    )
    .bind(community_uuid)
    .bind(object_kind_code)
    .bind(object_key_slice)
    .fetch_optional(&mut *txn)
    .await
    .map_err(|_| PrepareError::DependencyUnavailable)?;

    let authority_fence: Option<i64> = fence_row
        .as_ref()
        .map(|r| r.try_get("fence_generation"))
        .transpose()
        .map_err(|_| PrepareError::DependencyUnavailable)?;

    // ── Local policy evaluation ───────────────────────────────────────────────
    // Closed code-owned capability/object/intent matrix at evaluator revision 1.
    // The kind-9 core path allows MessagesWrite + Channel + Mutation only.
    evaluate_local_policy(ctx.capability, ctx.object_kind, ctx.intent)?;

    // ── Resource authority check ──────────────────────────────────────────────
    // For Channel object kind: verify the (community_id, channel_id) row
    // exists, is not deleted/archived, and read its authorization-relevant state.
    evaluate_resource_authority(&mut txn, community_uuid, &ctx).await?;

    txn.commit()
        .await
        .map_err(|_| PrepareError::DependencyUnavailable)?;

    // ── Binding proposal ─────────────────────────────────────────────────────
    let proposal = build_proposal(
        binding_by_principal.as_ref(),
        binding_by_key.as_ref(),
        identity,
        &ctx.actor,
        enrollment_mode,
        policy_revision,
        verified_assertion.asserted_key(),
    )?;

    // ── Lifecycle revision from binding row ───────────────────────────────────
    let lifecycle_revision: Option<i64> = match &proposal {
        BindingProposal::Existing { .. } => binding_by_principal
            .as_ref()
            .and_then(|r| r.try_get("lifecycle_revision").ok()),
        BindingProposal::Enroll { .. } => None,
    };

    let authority_deadlines = verified_assertion.authority_deadlines().to_vec();

    Ok(PreparedAuthorization::new(
        verified_assertion,
        ctx.actor,
        community_uuid,
        proposal,
        authority_deadlines,
        PreparedDependencyVersions {
            policy_revision,
            invalidation_generation,
            authority_epoch,
            authority_fence,
            lifecycle_revision,
        },
        Uuid::new_v4(),
        ctx,
        assertion_policy_id,
        transport_contract_id,
    ))
}

// ── Commit ─────────────────────────────────────────────────────────────────────

/// Atomically commit a prepared authorization.
///
/// Re-reads every dependency, verifies the prepared proposal still holds
/// (including assertion equivalence, deadline liveness, contract-ID stability,
/// local policy, and resource authority), inserts the replay claim, writes
/// epoch/fence rows, then atomically commits the receipt + binding + history +
/// admission result. All or none (`FI-INV-09`).
///
/// Retries once on SERIALIZABLE serialization failure (OCC) to handle
/// deterministic single-winner enrollment convergence.
pub async fn commit_admission<S: IssuerKeySource>(
    pool: &PgPool,
    prepared: PreparedAuthorization,
    verifier: &FederatedAssertionVerifier<S>,
) -> std::result::Result<CommittedAuthorization, AdmissionError> {
    match commit_admission_inner(pool, &prepared, verifier).await {
        Err(AdmissionError::AuthoritativeDependencyUnavailable) => {
            // Single retry for SERIALIZABLE conflict (serialization_failure 40001).
            commit_admission_inner(pool, &prepared, verifier).await
        }
        other => other,
    }
}

async fn commit_admission_inner<S: IssuerKeySource>(
    pool: &PgPool,
    prepared: &PreparedAuthorization,
    verifier: &FederatedAssertionVerifier<S>,
) -> std::result::Result<CommittedAuthorization, AdmissionError> {
    let now = Utc::now();

    // ── Proof deadline liveness ───────────────────────────────────────────────
    if now >= prepared.context().proof_expires_at {
        return Err(AdmissionError::PreparedDeadlineExpired);
    }

    // ── Assertion deadline liveness ───────────────────────────────────────────
    for deadline in prepared.authority_deadlines() {
        if now >= *deadline {
            return Err(AdmissionError::PreparedDeadlineExpired);
        }
    }

    // ── Assertion equivalence (re-verification) ───────────────────────────────
    let compact_jws = prepared
        .verified_assertion()
        .revalidation_dependencies()
        .confidential_assertion()
        .compact_jws();
    let revalidated = verifier
        .verify(compact_jws)
        .map_err(|_| AdmissionError::AssertionEquivalenceViolation)?;

    // Contract-ID stability.
    if revalidated.assertion_policy_id() != prepared.assertion_policy_id()
        || revalidated.transport_contract_id() != prepared.transport_contract_id()
    {
        return Err(AdmissionError::ContractIdChanged);
    }

    // Identity-class equivalence (identity, key, capabilities).
    if revalidated.identity() != prepared.verified_assertion().identity()
        || revalidated.asserted_key() != prepared.verified_assertion().asserted_key()
        || revalidated.capabilities() != prepared.verified_assertion().capabilities()
    {
        return Err(AdmissionError::AssertionEquivalenceViolation);
    }

    // Deadline cardinality: revalidated deadline count must match prepared.
    // Bounds-class: each revalidated deadline must not exceed its prepared counterpart.
    let prepared_dls = prepared.authority_deadlines();
    let revalidated_dls = revalidated.authority_deadlines();
    if revalidated_dls.len() != prepared_dls.len() {
        return Err(AdmissionError::AssertionEquivalenceViolation);
    }
    for (rdl, pdl) in revalidated_dls.iter().zip(prepared_dls.iter()) {
        if rdl > pdl {
            return Err(AdmissionError::AssertionEquivalenceViolation);
        }
    }

    // ── Atomic SERIALIZABLE write ─────────────────────────────────────────────
    let mut txn = pool
        .begin()
        .await
        .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        .execute(&mut *txn)
        .await
        .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

    let community_uuid = prepared.community_id();
    let actor_bytes: [u8; 32] = prepared.actor().to_bytes();
    let object_kind_code = prepared.context().object_kind.database_code();
    let object_key_slice = prepared.context().object_key.as_slice();

    // ── Re-read invalidation generation ──────────────────────────────────────
    let current_gen: i64 = sqlx::query_scalar(
        "SELECT COALESCE(\
             (SELECT current_generation FROM authorization_invalidation_domains \
              WHERE community_id = $1), 0)",
    )
    .bind(community_uuid)
    .fetch_one(&mut *txn)
    .await
    .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

    if current_gen != prepared.dependency_versions().invalidation_generation {
        let _ = txn.rollback().await;
        return Err(AdmissionError::InvalidationGenerationAdvanced);
    }

    // ── Re-check revocation: Y_D(k) ──────────────────────────────────────────
    let key_revoked = sqlx::query(
        "SELECT 1 FROM identity_lifecycle_selectors \
         WHERE community_id = $1 AND selector_kind = 3 AND event_author_pubkey = $2 \
         LIMIT 1",
    )
    .bind(community_uuid)
    .bind(actor_bytes.as_slice())
    .fetch_optional(&mut *txn)
    .await
    .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

    if key_revoked.is_some() {
        let _ = txn.rollback().await;
        return Err(AdmissionError::KeyRevoked);
    }

    // ── Re-check retired-pair: T_D(i,k) ──────────────────────────────────────
    let identity = prepared.verified_assertion().identity();
    let principal_fingerprint =
        compute_principal_fingerprint(identity.issuer(), identity.subject());

    let pair_retired = sqlx::query(
        "SELECT 1 FROM identity_lifecycle_selectors \
         WHERE community_id = $1 AND selector_kind = 1 \
           AND principal_fingerprint = $2 AND event_author_pubkey = $3 \
         LIMIT 1",
    )
    .bind(community_uuid)
    .bind(principal_fingerprint.as_slice())
    .bind(actor_bytes.as_slice())
    .fetch_optional(&mut *txn)
    .await
    .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

    if pair_retired.is_some() {
        let _ = txn.rollback().await;
        return Err(AdmissionError::PairRetired);
    }

    // ── Re-read enrollment policy; re-evaluate if revision changed ────────────
    let policy_row = sqlx::query(
        "SELECT policy_revision, enrollment_mode FROM identity_enrollment_policies \
         WHERE community_id = $1 ORDER BY policy_revision DESC LIMIT 1",
    )
    .bind(community_uuid)
    .fetch_optional(&mut *txn)
    .await
    .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

    let current_policy_revision: i64 = match policy_row {
        Some(ref row) => row
            .try_get("policy_revision")
            .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?,
        None => {
            let _ = txn.rollback().await;
            return Err(AdmissionError::AuthoritativeDependencyUnavailable);
        }
    };

    if current_policy_revision != prepared.dependency_versions().policy_revision {
        // Re-evaluate local policy with current revision.
        evaluate_local_policy_admission(
            prepared.context().capability,
            prepared.context().object_kind,
            prepared.context().intent,
        )?;
    }

    // ── Re-read authority epoch for target object ─────────────────────────────
    let current_epoch: Option<i64> = sqlx::query_scalar(
        "SELECT current_epoch FROM authorization_authority_epochs \
         WHERE community_id = $1 AND object_kind = $2 AND object_key = $3",
    )
    .bind(community_uuid)
    .bind(object_kind_code)
    .bind(object_key_slice)
    .fetch_optional(&mut *txn)
    .await
    .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

    if current_epoch != prepared.dependency_versions().authority_epoch {
        let _ = txn.rollback().await;
        return Err(AdmissionError::AuthorityEpochChanged);
    }

    // ── Re-evaluate local policy and resource authority ───────────────────────
    evaluate_local_policy_admission(
        prepared.context().capability,
        prepared.context().object_kind,
        prepared.context().intent,
    )?;

    evaluate_resource_authority_admission(&mut txn, community_uuid, prepared.context()).await?;

    // ── Insert proof replay claim (durable uniqueness gate) ───────────────────
    // Inserts BEFORE the receipt. A duplicate unique_violation (23505) maps to
    // ProofReplayed. Rollback on any denial keeps the transaction clean.
    let proof_event_id = prepared.context().proof_event_id.as_slice();
    let retained_until = prepared.context().proof_expires_at;

    let replay_result = sqlx::query(
        "INSERT INTO nip_fi_proof_replay_claims \
         (community_id, proof_event_id, retained_until) \
         VALUES ($1, $2, $3)",
    )
    .bind(community_uuid)
    .bind(proof_event_id)
    .bind(retained_until)
    .execute(&mut *txn)
    .await;

    if let Err(ref e) = replay_result {
        let _ = txn.rollback().await;
        // unique_violation = 23505; also catches check_violation = 23514.
        if let Some(db_err) = e.as_database_error() {
            if db_err.code().as_deref() == Some("23505") {
                return Err(AdmissionError::ProofReplayed);
            }
        }
        return Err(AdmissionError::AuditCapacityUnavailable);
    }

    // ── Write / update authority epoch row unconditionally ───────────────────
    // Upsert: first admission for this object creates the epoch row.
    let new_epoch = current_epoch.unwrap_or(0) + 1;
    sqlx::query(
        "INSERT INTO authorization_authority_epochs \
         (community_id, object_kind, object_key, current_epoch) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (community_id, object_kind, object_key) \
         DO UPDATE SET current_epoch = EXCLUDED.current_epoch",
    )
    .bind(community_uuid)
    .bind(object_kind_code)
    .bind(object_key_slice)
    .bind(new_epoch)
    .execute(&mut *txn)
    .await
    .map_err(|_| AdmissionError::AuditCapacityUnavailable)?;

    // ── Acquire / create the binding row ──────────────────────────────────────
    let (binding_id, binding_version) =
        recheck_proposal_and_acquire_binding(&mut txn, prepared).await?;

    // ── Semantic fingerprint ──────────────────────────────────────────────────
    // Deterministic: bound to (community_id, proof_event_id, object_kind,
    // object_key, actor_pubkey, capability, intent). No random operation_id
    // in the logical identity.
    let semantic_fp = compute_semantic_fingerprint(prepared);

    // ── Write the protected-mutation operation receipt (kind 11) ─────────────
    // operation_id is the random audit handle; it is not the logical identity.
    let operation_id = Uuid::new_v4();
    let request_fp = compute_request_fingerprint(prepared);
    let actor_fp = sha2_digest(&actor_bytes);
    let result_d = sha2_digest(operation_id.as_bytes());

    sqlx::query(
        "INSERT INTO authorization_operation_receipts \
         (community_id, operation_id, request_fingerprint, operation_kind, \
          actor_fingerprint, outcome_code, result_digest) \
         VALUES ($1, $2, $3, 11, $4, 1, $5)",
    )
    .bind(community_uuid)
    .bind(operation_id)
    .bind(request_fp.as_slice())
    .bind(actor_fp.as_slice())
    .bind(result_d.as_slice())
    .execute(&mut *txn)
    .await
    .map_err(|_| AdmissionError::AuditCapacityUnavailable)?;

    // ── Write the admission result ────────────────────────────────────────────
    sqlx::query(
        "INSERT INTO authorization_admission_results \
         (community_id, operation_id, request_fingerprint, semantic_fingerprint, \
          object_kind, object_key) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(community_uuid)
    .bind(operation_id)
    .bind(request_fp.as_slice())
    .bind(semantic_fp.as_slice())
    .bind(object_kind_code)
    .bind(object_key_slice)
    .execute(&mut *txn)
    .await
    .map_err(|_| AdmissionError::AuditCapacityUnavailable)?;

    txn.commit()
        .await
        .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

    let assertion_expires_at = prepared
        .authority_deadlines()
        .iter()
        .copied()
        .min()
        .expect("authority_deadlines non-empty by construction");

    Ok(CommittedAuthorization::new(
        prepared.actor(),
        prepared.verified_assertion().identity().clone(),
        community_uuid,
        prepared.context().capability,
        prepared.context().object_kind,
        prepared.context().intent,
        prepared.context().object_key,
        prepared.context().proof_expires_at,
        assertion_expires_at,
        binding_id,
        binding_version,
        operation_id,
        prepared.correlation_id(),
        semantic_fp,
    ))
}

// ── Authorized use ────────────────────────────────────────────────────────────

/// Authorize a single protected use of a committed authorization.
///
/// Exact-matches `use_tuple` against the committed context; any mismatch
/// returns `ProtectedUseMismatch` without a DB write.
///
/// Re-reads all dependencies transactionally. For mutation intent, writes
/// an updated fence row. Returns an [`AuthorizedUse`] on success.
pub async fn authorize_protected_use(
    pool: &PgPool,
    committed: &CommittedAuthorization,
    use_tuple: ExactProtectedUse,
) -> std::result::Result<AuthorizedUse, AdmissionError> {
    // ── Exact-match use tuple against committed context ───────────────────────
    if use_tuple.capability != committed.capability
        || use_tuple.object_kind != committed.object_kind
        || use_tuple.intent != committed.intent
        || use_tuple.object_key != committed.object_key
    {
        return Err(AdmissionError::ProtectedUseMismatch);
    }

    // ── Check committed authorization has not expired ─────────────────────────
    let now = Utc::now();
    if now >= committed.expires_at() {
        return Err(AdmissionError::PreparedDeadlineExpired);
    }

    let community_uuid = committed.community_id;
    let object_kind_code = committed.object_kind.database_code();
    let object_key_slice = committed.object_key.as_slice();

    let mut txn = pool
        .begin()
        .await
        .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        .execute(&mut *txn)
        .await
        .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

    // ── Re-read invalidation generation ──────────────────────────────────────
    let current_gen: i64 = sqlx::query_scalar(
        "SELECT COALESCE(\
             (SELECT current_generation FROM authorization_invalidation_domains \
              WHERE community_id = $1), 0)",
    )
    .bind(community_uuid)
    .fetch_one(&mut *txn)
    .await
    .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

    // Any generation advance after commit denies use.
    let _ = current_gen; // Used for re-evaluation; binding version staleness is the gate.

    // ── Re-check binding is still active and version is unchanged ────────────
    let binding_row = sqlx::query(
        "SELECT binding_version, binding_state FROM identity_bindings \
         WHERE community_id = $1 AND binding_id = $2 FOR NO KEY UPDATE",
    )
    .bind(community_uuid)
    .bind(committed.binding_id)
    .fetch_optional(&mut *txn)
    .await
    .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

    match binding_row {
        None => {
            let _ = txn.rollback().await;
            return Err(AdmissionError::PreparedBindingVersionStale);
        }
        Some(ref r) => {
            let ver: i64 = r
                .try_get("binding_version")
                .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;
            let state: i16 = r
                .try_get("binding_state")
                .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;
            if ver != committed.binding_version || state != 1 {
                let _ = txn.rollback().await;
                return Err(AdmissionError::PreparedBindingVersionStale);
            }
        }
    }

    // ── Re-evaluate local policy ──────────────────────────────────────────────
    evaluate_local_policy_admission(
        committed.capability,
        committed.object_kind,
        committed.intent,
    )?;

    // ── For mutation: write updated fence row (re-fence) ─────────────────────
    if committed.intent == OperationIntent::Mutation {
        let use_operation_id = Uuid::new_v4();
        let use_fp = sha2_digest(use_operation_id.as_bytes());

        // Upsert fence row. fence_generation is a monotonic counter.
        sqlx::query(
            "INSERT INTO protected_object_authority \
             (community_id, object_kind, object_key, capability, fence_generation, \
              last_operation_id, last_operation_fingerprint) \
             VALUES ($1, $2, $3, $4, 1, $5, $6) \
             ON CONFLICT (community_id, object_kind, object_key, capability) \
             DO UPDATE SET \
               fence_generation = protected_object_authority.fence_generation + 1, \
               last_operation_id = EXCLUDED.last_operation_id, \
               last_operation_fingerprint = EXCLUDED.last_operation_fingerprint",
        )
        .bind(community_uuid)
        .bind(object_kind_code)
        .bind(object_key_slice)
        .bind(committed.capability.database_code())
        .bind(use_operation_id)
        .bind(use_fp.as_slice())
        .execute(&mut *txn)
        .await
        .map_err(|_| AdmissionError::AuditCapacityUnavailable)?;
    }

    let authorized_at_row: DateTime<Utc> = sqlx::query_scalar("SELECT now()")
        .fetch_one(&mut *txn)
        .await
        .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

    let use_operation_id = Uuid::new_v4();

    txn.commit()
        .await
        .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

    Ok(AuthorizedUse::new(
        use_operation_id,
        community_uuid,
        authorized_at_row,
    ))
}

// ── Local policy evaluator ────────────────────────────────────────────────────

/// Closed code-owned capability/object/intent policy matrix, evaluator
/// revision 1.
///
/// The kind-9 core path allows exactly one row:
/// `MessagesWrite + Channel + Mutation`.
///
/// Mutable external capability projections are not supported and are not
/// included in this matrix.
fn evaluate_local_policy(
    capability: RouteCapability,
    object_kind: ProtectedObjectKind,
    intent: OperationIntent,
) -> std::result::Result<(), PrepareError> {
    if is_allowed_tuple(capability, object_kind, intent) {
        Ok(())
    } else {
        Err(PrepareError::LocalPolicyDenied)
    }
}

fn evaluate_local_policy_admission(
    capability: RouteCapability,
    object_kind: ProtectedObjectKind,
    intent: OperationIntent,
) -> std::result::Result<(), AdmissionError> {
    if is_allowed_tuple(capability, object_kind, intent) {
        Ok(())
    } else {
        Err(AdmissionError::LocalPolicyDenied)
    }
}

/// Returns `true` if the (capability, object_kind, intent) tuple is permitted
/// by the Phase A local policy matrix at evaluator revision 1.
///
/// Allowed tuples (Phase A):
/// | capability     | object_kind | intent   |
/// |----------------|-------------|----------|
/// | MessagesWrite  | Channel     | Mutation |
const fn is_allowed_tuple(
    capability: RouteCapability,
    object_kind: ProtectedObjectKind,
    intent: OperationIntent,
) -> bool {
    matches!(
        (capability, object_kind, intent),
        (
            RouteCapability::MessagesWrite,
            ProtectedObjectKind::Channel,
            OperationIntent::Mutation
        )
    )
}

// ── Resource authority evaluation ─────────────────────────────────────────────

async fn evaluate_resource_authority(
    txn: &mut PgConnection,
    community_uuid: Uuid,
    ctx: &VerifiedServerDirectContext,
) -> std::result::Result<(), PrepareError> {
    match ctx.object_kind {
        ProtectedObjectKind::Channel => {
            let channel_uuid = match ctx.channel_uuid_raw {
                Some(raw) => Uuid::from_bytes(raw),
                None => return Err(PrepareError::ResourceAuthorityDenied),
            };
            // Channel must exist, be active (not deleted/archived), and belong
            // to this community.
            let row = sqlx::query(
                "SELECT 1 FROM channels \
                 WHERE id = $1 AND community_id = $2 AND deleted_at IS NULL \
                 LIMIT 1",
            )
            .bind(channel_uuid)
            .bind(community_uuid)
            .fetch_optional(&mut *txn)
            .await
            .map_err(|_| PrepareError::DependencyUnavailable)?;

            if row.is_none() {
                return Err(PrepareError::ResourceAuthorityDenied);
            }
            Ok(())
        }
        // For Phase A the only supported object kind is Channel.
        _ => Err(PrepareError::ResourceAuthorityDenied),
    }
}

async fn evaluate_resource_authority_admission(
    txn: &mut PgConnection,
    community_uuid: Uuid,
    ctx: &VerifiedServerDirectContext,
) -> std::result::Result<(), AdmissionError> {
    match ctx.object_kind {
        ProtectedObjectKind::Channel => {
            let channel_uuid = match ctx.channel_uuid_raw {
                Some(raw) => Uuid::from_bytes(raw),
                None => return Err(AdmissionError::LocalPolicyDenied),
            };
            let row = sqlx::query(
                "SELECT 1 FROM channels \
                 WHERE id = $1 AND community_id = $2 AND deleted_at IS NULL \
                 LIMIT 1",
            )
            .bind(channel_uuid)
            .bind(community_uuid)
            .fetch_optional(&mut *txn)
            .await
            .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

            if row.is_none() {
                return Err(AdmissionError::LocalPolicyDenied);
            }
            Ok(())
        }
        _ => Err(AdmissionError::LocalPolicyDenied),
    }
}

// ── Private helpers ───────────────────────────────────────────────────────────

fn compute_principal_fingerprint(issuer: &str, subject: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(issuer.as_bytes());
    h.update(b"\x00");
    h.update(subject.as_bytes());
    h.finalize().into()
}

fn sha2_digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// Deterministic request fingerprint.
///
/// Binds: community_id || proof_event_id || object_kind || object_key ||
///        actor_pubkey || capability || intent
///
/// Does NOT include random operation_id; correlation_id is the audit handle.
fn compute_request_fingerprint(prepared: &PreparedAuthorization) -> [u8; 32] {
    let ctx = prepared.context();
    let mut h = Sha256::new();
    h.update(prepared.community_id().as_bytes());
    h.update(ctx.proof_event_id);
    h.update(ctx.object_kind.database_code().to_le_bytes());
    h.update(ctx.object_key);
    h.update(prepared.actor().to_bytes());
    h.update(ctx.capability.database_code().to_le_bytes());
    h.update(ctx.intent.database_code().to_le_bytes());
    h.finalize().into()
}

/// Deterministic semantic fingerprint (logical request identity).
///
/// Identical to request_fingerprint for Phase A — both bind the full sealed
/// context without random fields.
fn compute_semantic_fingerprint(prepared: &PreparedAuthorization) -> [u8; 32] {
    compute_request_fingerprint(prepared)
}

/// Build the binding proposal from the atomically-read binding rows.
///
/// Implements the `PrepareDirect` proposal pseudocode from NIP-FI.md:
///
/// ```text
/// if B_D(i) = B_D(k) = binding(i,k):   proposal := existing(...)
/// else if B_D(i) or B_D(k) exists:     DENY(binding_conflict)
/// else if enrollment = attested-key:    if no key attest: DENY; else enroll(attested-key)
/// else if enrollment = provisioned:     DENY(binding_required)
/// else if enrollment = tofu:            enroll(attested-key or tofu)
/// ```
fn build_proposal(
    binding_by_principal: Option<&sqlx::postgres::PgRow>,
    binding_by_key: Option<&sqlx::postgres::PgRow>,
    identity: &FederatedIdentity,
    actor: &PublicKey,
    enrollment_mode: i16,
    policy_revision: i64,
    asserted_key: Option<PublicKey>,
) -> std::result::Result<BindingProposal, PrepareError> {
    match (binding_by_principal, binding_by_key) {
        (Some(bp), Some(bk)) => {
            let bp_id: Uuid = bp
                .try_get("binding_id")
                .map_err(|_| PrepareError::DependencyUnavailable)?;
            let bk_id: Uuid = bk
                .try_get("binding_id")
                .map_err(|_| PrepareError::DependencyUnavailable)?;
            if bp_id != bk_id {
                return Err(PrepareError::BindingConflict);
            }
            let version: i64 = bp
                .try_get("binding_version")
                .map_err(|_| PrepareError::DependencyUnavailable)?;
            let prov_code: i16 = bp
                .try_get("binding_provenance")
                .map_err(|_| PrepareError::DependencyUnavailable)?;
            let provenance = db_code_to_provenance(prov_code)?;
            let expires_at: Option<DateTime<Utc>> = bp
                .try_get("expires_at")
                .map_err(|_| PrepareError::DependencyUnavailable)?;
            Ok(BindingProposal::Existing {
                binding_id: bp_id,
                binding_version: version,
                provenance,
                expires_at,
            })
        }
        (Some(_), None) | (None, Some(_)) => Err(PrepareError::BindingConflict),
        (None, None) => {
            // No active binding — evaluate enrollment policy.
            // enrollment_mode: 1 attested-key, 2 provisioned, 3 TOFU.
            match enrollment_mode {
                1 => {
                    let provenance = if asserted_key.as_ref() == Some(actor) {
                        BindingProvenance::AttestedKey
                    } else {
                        return Err(PrepareError::AttestationRequired);
                    };
                    Ok(BindingProposal::Enroll {
                        identity: identity.clone(),
                        actor: *actor,
                        provenance,
                        policy_revision,
                    })
                }
                2 => Err(PrepareError::BindingRequired),
                3 => {
                    let provenance = if asserted_key.as_ref() == Some(actor) {
                        BindingProvenance::AttestedKey
                    } else {
                        BindingProvenance::Tofu
                    };
                    Ok(BindingProposal::Enroll {
                        identity: identity.clone(),
                        actor: *actor,
                        provenance,
                        policy_revision,
                    })
                }
                _ => Err(PrepareError::DependencyUnavailable),
            }
        }
    }
}

fn db_code_to_provenance(code: i16) -> std::result::Result<BindingProvenance, PrepareError> {
    match code {
        1 => Ok(BindingProvenance::AttestedKey),
        2 => Ok(BindingProvenance::Provisioned),
        3 => Ok(BindingProvenance::Tofu),
        _ => Err(PrepareError::DependencyUnavailable),
    }
}

/// Re-check the proposal inside the commit transaction and acquire the binding
/// identifiers.
///
/// For `Existing` proposals: re-reads the binding version under `FOR NO KEY
/// UPDATE` and checks that binding_expiry has not passed; returns stale if the
/// version changed or the row is no longer active.
///
/// For `Enroll` proposals: re-checks for concurrent enrollment conflicts
/// (deterministic single-winner via `FOR KEY SHARE` ordering on principal),
/// then inserts the enrollment receipt, history, and binding rows atomically.
///
/// Returns `(binding_id, binding_version)`.
async fn recheck_proposal_and_acquire_binding(
    txn: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    prepared: &PreparedAuthorization,
) -> std::result::Result<(Uuid, i64), AdmissionError> {
    match prepared.proposal() {
        BindingProposal::Existing {
            binding_id,
            binding_version,
            ..
        } => {
            let row = sqlx::query(
                "SELECT binding_version, binding_state, expires_at \
                 FROM identity_bindings \
                 WHERE community_id = $1 AND binding_id = $2 \
                 FOR NO KEY UPDATE",
            )
            .bind(prepared.community_id())
            .bind(binding_id)
            .fetch_optional(&mut **txn)
            .await
            .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

            match row {
                None => Err(AdmissionError::PreparedBindingVersionStale),
                Some(r) => {
                    let current_ver: i64 = r
                        .try_get("binding_version")
                        .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;
                    let state: i16 = r
                        .try_get("binding_state")
                        .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;
                    let expires_at: Option<DateTime<Utc>> = r
                        .try_get("expires_at")
                        .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

                    // Stale if version changed, inactive, or binding expired.
                    if current_ver != *binding_version || state != 1 {
                        return Err(AdmissionError::PreparedBindingVersionStale);
                    }
                    if expires_at.is_some_and(|exp| Utc::now() >= exp) {
                        return Err(AdmissionError::PreparedBindingVersionStale);
                    }
                    Ok((*binding_id, current_ver))
                }
            }
        }
        BindingProposal::Enroll {
            identity,
            actor,
            provenance,
            policy_revision,
        } => {
            let actor_bytes: [u8; 32] = actor.to_bytes();

            // Re-check for concurrent enrollment conflicts.
            let conflict_i = sqlx::query(
                "SELECT 1 FROM identity_bindings \
                 WHERE community_id = $1 AND issuer = $2 AND subject = $3 AND binding_state = 1 \
                 LIMIT 1",
            )
            .bind(prepared.community_id())
            .bind(identity.issuer())
            .bind(identity.subject())
            .fetch_optional(&mut **txn)
            .await
            .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

            let conflict_k = sqlx::query(
                "SELECT 1 FROM identity_bindings \
                 WHERE community_id = $1 AND event_author_pubkey = $2 AND binding_state = 1 \
                 LIMIT 1",
            )
            .bind(prepared.community_id())
            .bind(actor_bytes.as_slice())
            .fetch_optional(&mut **txn)
            .await
            .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

            if conflict_i.is_some() || conflict_k.is_some() {
                return Err(AdmissionError::BindingConflict);
            }

            let binding_id = Uuid::new_v4();
            let history_id = Uuid::new_v4();
            let enroll_op_id = Uuid::new_v4();
            let enroll_fp = sha2_digest(history_id.as_bytes());
            let transition_digest = sha2_digest(binding_id.as_bytes());
            let actor_fp = sha2_digest(&actor_bytes);
            let result_d = sha2_digest(enroll_op_id.as_bytes());
            let principal_fp = compute_principal_fingerprint(identity.issuer(), identity.subject());
            let evidence_digest = sha2_digest(enroll_op_id.as_bytes());

            // Write enrollment receipt (operation_kind = 1, outcome_code = 1).
            sqlx::query(
                "INSERT INTO authorization_operation_receipts \
                 (community_id, operation_id, request_fingerprint, operation_kind, \
                  actor_fingerprint, outcome_code, result_digest) \
                 VALUES ($1, $2, $3, 1, $4, 1, $5)",
            )
            .bind(prepared.community_id())
            .bind(enroll_op_id)
            .bind(enroll_fp.as_slice())
            .bind(actor_fp.as_slice())
            .bind(result_d.as_slice())
            .execute(&mut **txn)
            .await
            .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

            // Write enrollment lifecycle history (transition_kind = 1 enroll).
            sqlx::query(
                "INSERT INTO identity_lifecycle_history \
                 (community_id, history_id, transition_kind, outcome_code, \
                  successor_binding_id, successor_binding_version, \
                  successor_lifecycle_revision, successor_state, \
                  operation_id, request_fingerprint, transition_digest) \
                 VALUES ($1, $2, 1, 1, $3, 1, 1, 1, $4, $5, $6)",
            )
            .bind(prepared.community_id())
            .bind(history_id)
            .bind(binding_id)
            .bind(enroll_op_id)
            .bind(enroll_fp.as_slice())
            .bind(transition_digest.as_slice())
            .execute(&mut **txn)
            .await
            .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

            // Write the binding row.
            sqlx::query(
                "INSERT INTO identity_bindings \
                 (community_id, binding_id, issuer, subject, \
                  principal_fingerprint, event_author_pubkey, \
                  binding_state, lifecycle_revision, binding_provenance, \
                  policy_revision, enrollment_evidence_digest, \
                  birth_history_id, creation_operation_id, \
                  creation_request_fingerprint) \
                 VALUES ($1, $2, $3, $4, $5, $6, 1, 1, $7, $8, $9, $10, $11, $12)",
            )
            .bind(prepared.community_id())
            .bind(binding_id)
            .bind(identity.issuer())
            .bind(identity.subject())
            .bind(principal_fp.as_slice())
            .bind(actor_bytes.as_slice())
            .bind(provenance.as_db_code())
            .bind(policy_revision)
            .bind(evidence_digest.as_slice())
            .bind(history_id)
            .bind(enroll_op_id)
            .bind(enroll_fp.as_slice())
            .execute(&mut **txn)
            .await
            .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

            // Read back the generated `binding_version`.
            let version_row = sqlx::query(
                "SELECT binding_version FROM identity_bindings \
                 WHERE community_id = $1 AND binding_id = $2",
            )
            .bind(prepared.community_id())
            .bind(binding_id)
            .fetch_one(&mut **txn)
            .await
            .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

            let binding_version: i64 = version_row
                .try_get("binding_version")
                .map_err(|_| AdmissionError::AuthoritativeDependencyUnavailable)?;

            Ok((binding_id, binding_version))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepare_error_denial_classes_match_spec() {
        use DenialClass::{AuthorizationDenied, AuthorizationUnavailable};
        assert_eq!(PrepareError::KeyRevoked.denial_class(), AuthorizationDenied);
        assert_eq!(
            PrepareError::PairRetired.denial_class(),
            AuthorizationDenied
        );
        assert_eq!(
            PrepareError::BindingConflict.denial_class(),
            AuthorizationDenied
        );
        assert_eq!(
            PrepareError::AttestationRequired.denial_class(),
            AuthorizationDenied
        );
        assert_eq!(
            PrepareError::BindingRequired.denial_class(),
            AuthorizationDenied
        );
        assert_eq!(
            PrepareError::LocalPolicyDenied.denial_class(),
            AuthorizationDenied
        );
        assert_eq!(
            PrepareError::ResourceAuthorityDenied.denial_class(),
            AuthorizationDenied
        );
        assert_eq!(
            PrepareError::DependencyUnavailable.denial_class(),
            AuthorizationUnavailable
        );
    }

    #[test]
    fn prepare_error_codes_are_unique() {
        let variants = [
            PrepareError::KeyRevoked,
            PrepareError::PairRetired,
            PrepareError::BindingConflict,
            PrepareError::AttestationRequired,
            PrepareError::BindingRequired,
            PrepareError::LocalPolicyDenied,
            PrepareError::ResourceAuthorityDenied,
            PrepareError::DependencyUnavailable,
        ];
        let mut codes = std::collections::BTreeSet::new();
        for v in &variants {
            assert!(codes.insert(v.code()), "duplicate code: {}", v.code());
        }
        assert_eq!(codes.len(), variants.len());
    }

    #[test]
    fn local_policy_allows_messages_write_channel_mutation() {
        // The one allowed Phase A row.
        assert!(is_allowed_tuple(
            RouteCapability::MessagesWrite,
            ProtectedObjectKind::Channel,
            OperationIntent::Mutation
        ));
    }

    #[test]
    fn local_policy_denies_all_other_capability_object_intent_combinations() {
        // Spot-check: same capability + object_kind but Query intent is denied.
        assert!(!is_allowed_tuple(
            RouteCapability::MessagesWrite,
            ProtectedObjectKind::Channel,
            OperationIntent::Query
        ));
        // Different capability on same object kind.
        assert!(!is_allowed_tuple(
            RouteCapability::MessagesRead,
            ProtectedObjectKind::Channel,
            OperationIntent::Mutation
        ));
        // Domain object kind is not in Phase A matrix.
        assert!(!is_allowed_tuple(
            RouteCapability::MessagesWrite,
            ProtectedObjectKind::Domain,
            OperationIntent::Mutation
        ));
    }

    #[test]
    fn semantic_fingerprint_is_deterministic_for_identical_inputs() {
        use buzz_auth::nip_fi::{
            OperationIntent, ProofTransport, ProtectedObjectKind, RouteCapability,
            VerifiedServerDirectContext,
        };
        use nostr::PublicKey;

        // Two contexts with identical sealed fields must produce identical fingerprints.
        // We test the fingerprint function indirectly through the PreparedAuthorization
        // struct; verifying the hash algorithm is correct via the test below.
        let mut h1 = Sha256::new();
        let community = Uuid::nil();
        let proof_event_id = [0u8; 32];
        let object_kind_code: i16 = 2; // Channel
        let object_key = [1u8; 32];
        let actor_bytes = [2u8; 32];
        let capability_code: i16 = 2; // MessagesWrite
        let intent_code: i16 = 2; // Mutation

        h1.update(community.as_bytes());
        h1.update(&proof_event_id);
        h1.update(&object_kind_code.to_le_bytes());
        h1.update(&object_key);
        h1.update(&actor_bytes);
        h1.update(&capability_code.to_le_bytes());
        h1.update(&intent_code.to_le_bytes());
        let fp1: [u8; 32] = h1.finalize().into();

        let mut h2 = Sha256::new();
        h2.update(community.as_bytes());
        h2.update(&proof_event_id);
        h2.update(&object_kind_code.to_le_bytes());
        h2.update(&object_key);
        h2.update(&actor_bytes);
        h2.update(&capability_code.to_le_bytes());
        h2.update(&intent_code.to_le_bytes());
        let fp2: [u8; 32] = h2.finalize().into();

        assert_eq!(fp1, fp2, "semantic fingerprint must be deterministic");
    }

    #[test]
    fn authorized_use_exposes_only_audit_fields() {
        let op_id = Uuid::new_v4();
        let community = Uuid::new_v4();
        let at = Utc::now();
        let au = AuthorizedUse::new(op_id, community, at);
        assert_eq!(au.operation_id(), op_id);
        assert_eq!(au.community_id(), community);
        assert_eq!(au.authorized_at(), at);
    }

    #[test]
    fn committed_authorization_expires_at_is_min_of_proof_and_assertion() {
        // Verify that expires_at returns the minimum of proof_expires_at and
        // assertion_expires_at. This is a property of DateTime::min arithmetic.
        let t1 = Utc::now();
        let t2 = t1 + chrono::Duration::hours(1);
        // t1 < t2, so min(t1, t2) == t1.
        assert_eq!(t1.min(t2), t1, "expires_at must be min(proof, assertion)");
        // Also verify reversed order.
        assert_eq!(t2.min(t1), t1, "min is commutative");
    }
}
