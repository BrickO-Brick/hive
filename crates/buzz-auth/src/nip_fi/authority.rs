//! Closed types for NIP-FI prepared and committed authorization.
//!
//! ## Types defined here (buzz-auth)
//!
//! - [`RouteCapability`] — server-owned closed capability vocabulary; code `2`
//!   (`MessagesWrite`) is the canonical mapping for WebSocket event ingress.
//! - [`ProtectedObjectKind`] — closed protected-object namespace; code `2`
//!   (`Channel`) is the kind for kind-9 channel message admission.
//! - [`ProofTransport`] — closed transport discriminant for the Nostr proof.
//! - [`VerifiedServerDirectContext`] — origin-sealed server-resolved request
//!   context. Fields are private; the only constructor lives in
//!   `buzz-db::store::nip_fi_authority` so that only the trusted
//!   target/proof-validation path can produce one (`FI-INV-04`).
//! - [`ExactProtectedUse`] — the exact capability/object/intent tuple presented
//!   by the caller when redeeming a [`CommittedAuthorization`].
//! - [`BindingProposal`] / [`BindingProvenance`] / [`PreparedDependencyVersions`]
//!   — data types shared between preparation and admission.
//! - [`AdmissionError`] — closed, stable admission failure enum; 16 variants,
//!   each maps to exactly one [`DenialClass`] (`FI-INV-13`).
//!
//! ## Types owned in buzz-db (non-forgeable authority)
//!
//! `PreparedAuthorization`, `CommittedAuthorization`, and `AuthorizedUse` are
//! defined in `buzz-db::store::nip_fi_authority` with `pub(crate)` constructors
//! so that only the PostgreSQL admission path can produce them. They are
//! re-exported from `buzz-db`'s public surface for relay-ingress consumption.
//! No sibling crate can mint authority-bearing types.

use super::assertion::FederatedIdentity;
use super::denial::DenialClass;
use chrono::{DateTime, Utc};
use nostr::PublicKey;
use uuid::Uuid;

// ── Route capability vocabulary ───────────────────────────────────────────────

/// Server-owned closed route capability.
///
/// The database code is the authoritative stable identifier written to
/// `protected_object_authority.capability`; no other value is valid.
/// WebSocket event ingress (kind-9 channel messages) maps to
/// [`RouteCapability::MessagesWrite`] / code `2`.
///
/// The database code table matches the historical `capability_code` mapping at
/// commit `341a08a42 crates/buzz-db/src/authorization_admission.rs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum RouteCapability {
    /// Read messages. DB code: 1.
    MessagesRead,
    /// Write messages (WebSocket event ingress, kind-9). DB code: 2.
    MessagesWrite,
    /// Read channel metadata. DB code: 3.
    ChannelsRead,
    /// Mutate channels. DB code: 4.
    ChannelsWrite,
    /// Channel administration. DB code: 5.
    AdminChannels,
    /// Read user metadata. DB code: 6.
    UsersRead,
    /// Mutate user metadata. DB code: 7.
    UsersWrite,
    /// User administration. DB code: 8.
    AdminUsers,
    /// Read jobs. DB code: 9.
    JobsRead,
    /// Mutate jobs. DB code: 10.
    JobsWrite,
    /// Read subscriptions. DB code: 11.
    SubscriptionsRead,
    /// Mutate subscriptions. DB code: 12.
    SubscriptionsWrite,
    /// Read files. DB code: 13.
    FilesRead,
    /// Write files. DB code: 14.
    FilesWrite,
    /// Read repositories. DB code: 15.
    ReposRead,
    /// Write repositories. DB code: 16.
    ReposWrite,
    /// Read Git objects and refs. DB code: 17.
    GitRead,
    /// Mutate Git objects and refs. DB code: 18.
    GitWrite,
    /// Bounded Git streaming. DB code: 19.
    GitStream,
    /// Read media. DB code: 20.
    MediaRead,
    /// Upload or mutate media. DB code: 21.
    MediaWrite,
    /// Perform moderation operations. DB code: 22.
    Moderation,
    /// Join an audio session. DB code: 23.
    AudioJoin,
    /// Send or receive bounded audio media. DB code: 24.
    AudioMedia,
    /// Read protected discovery data. DB code: 25.
    Discovery,
    /// Read current local binding status. DB code: 26.
    BindingStatus,
    /// Enroll a local binding. DB code: 27.
    Enrollment,
    /// Mint an invitation. DB code: 28.
    InviteMint,
    /// Claim an invitation. DB code: 29.
    InviteClaim,
}

impl RouteCapability {
    /// Stable code written to `protected_object_authority.capability`.
    /// Values are fixed and must not change once rows exist in the database.
    pub const fn database_code(self) -> i16 {
        match self {
            Self::MessagesRead => 1,
            Self::MessagesWrite => 2,
            Self::ChannelsRead => 3,
            Self::ChannelsWrite => 4,
            Self::AdminChannels => 5,
            Self::UsersRead => 6,
            Self::UsersWrite => 7,
            Self::AdminUsers => 8,
            Self::JobsRead => 9,
            Self::JobsWrite => 10,
            Self::SubscriptionsRead => 11,
            Self::SubscriptionsWrite => 12,
            Self::FilesRead => 13,
            Self::FilesWrite => 14,
            Self::ReposRead => 15,
            Self::ReposWrite => 16,
            Self::GitRead => 17,
            Self::GitWrite => 18,
            Self::GitStream => 19,
            Self::MediaRead => 20,
            Self::MediaWrite => 21,
            Self::Moderation => 22,
            Self::AudioJoin => 23,
            Self::AudioMedia => 24,
            Self::Discovery => 25,
            Self::BindingStatus => 26,
            Self::Enrollment => 27,
            Self::InviteMint => 28,
            Self::InviteClaim => 29,
        }
    }
}

// ── Protected object kinds ────────────────────────────────────────────────────

/// Closed protected-object namespace.
///
/// Matches `authorization_authority_epochs.object_kind` and
/// `protected_object_authority.object_kind` in migration 0042.
/// Kind-9 channel message admission uses [`ProtectedObjectKind::Channel`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtectedObjectKind {
    /// Domain-wide authority. DB code: 1.
    Domain,
    /// One channel. DB code: 2. Used for kind-9 channel message admission.
    Channel,
    /// One repository. DB code: 3.
    Repository,
    /// One media object. DB code: 4.
    Media,
    /// One moderation target. DB code: 5.
    ModerationTarget,
    /// One audio session. DB code: 6.
    AudioSession,
}

impl ProtectedObjectKind {
    /// Stable code written to `object_kind` columns in migration 0042.
    pub const fn database_code(self) -> i16 {
        match self {
            Self::Domain => 1,
            Self::Channel => 2,
            Self::Repository => 3,
            Self::Media => 4,
            Self::ModerationTarget => 5,
            Self::AudioSession => 6,
        }
    }
}

// ── Operation intent ──────────────────────────────────────────────────────────

/// Closed operation intent discriminant for the local policy matrix.
///
/// The kind-9 core path maps to [`OperationIntent::Mutation`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperationIntent {
    /// A read or query operation. DB code: 1.
    Query,
    /// A write or mutation operation. DB code: 2.
    Mutation,
}

impl OperationIntent {
    /// Stable code for the local policy matrix.
    pub const fn database_code(self) -> i16 {
        match self {
            Self::Query => 1,
            Self::Mutation => 2,
        }
    }
}

// ── Proof transport ───────────────────────────────────────────────────────────

/// The Nostr-proof transport that bound the actor to the request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProofTransport {
    /// WebSocket NIP-42 AUTH event. DB code: 1.
    Nip42,
    /// HTTP NIP-98 signed event. DB code: 2.
    Nip98,
}

impl ProofTransport {
    /// Stable code for fingerprint domain separation.
    pub const fn database_code(self) -> i16 {
        match self {
            Self::Nip42 => 1,
            Self::Nip98 => 2,
        }
    }
}

// ── Origin-sealed server-resolved request context ─────────────────────────────

/// Origin-sealed server-resolved request context for NIP-FI direct admission.
///
/// Every field is resolved and validated by the trusted relay routing and
/// proof-validation path before `prepare_direct` is called. No client-supplied
/// value, unsigned header, or assertion claim may set any field here
/// (`FI-INV-04`).
///
/// **Constructor is `pub(crate)` in `buzz-db`** — this type is defined in
/// `buzz-auth` for its type identity but only the PostgreSQL admission path in
/// `buzz-db::store::nip_fi_authority` can construct it. Sibling crates cannot
/// mint a `VerifiedServerDirectContext`.
///
/// ## Kind-9 canonical tuple
///
/// ```text
/// capability   = RouteCapability::MessagesWrite  (code 2)
/// object_kind  = ProtectedObjectKind::Channel    (code 2)
/// intent       = OperationIntent::Mutation       (code 2)
/// object_key   = SHA-256(channel_uuid.as_bytes()) — canonical 16-byte big-endian UUID
/// transport    = ProofTransport::Nip42
/// ```
///
/// Receipt `operation_kind = 11` (protected-mutation) is the fixed DB constant,
/// never derived from `capability` or `intent` here.
///
/// ## `object_key` encoding
///
/// `object_key` is `SHA-256(canonical_object_bytes)`:
/// - `Channel`: `SHA-256(channel_uuid.as_bytes())` — 16-byte big-endian.
/// - `Domain`: `SHA-256(community_uuid.as_bytes())`.
/// - Other kinds: analogously. Always server-resolved; no client value accepted.
///
/// ## `channel_uuid` for DB lookup
///
/// `channel_uuid_raw` carries the raw private UUID for the `(community_id,
/// channel_id)` resource-authority DB lookup inside `prepare_direct`. It is
/// never exposed on any public surface; `object_key` is the only derived form
/// that leaves the admission path.
#[derive(Debug)]
pub struct VerifiedServerDirectContext {
    /// Nostr-proof transport that bound the actor (NIP-42 or NIP-98).
    pub transport: ProofTransport,
    /// Full 32-byte event ID of the NIP-42 AUTH or NIP-98 proof event.
    /// This is the durable replay-claim coordinate.
    pub proof_event_id: [u8; 32],
    /// Freshness deadline of the proof. No admission may proceed at or after
    /// this instant.
    pub proof_expires_at: DateTime<Utc>,
    /// Server-resolved 32-byte Nostr public key of the proven actor.
    pub actor: PublicKey,
    /// Community (tenant) UUID for this admission.
    pub community_id: Uuid,
    /// Server-resolved protected-operation capability.
    pub capability: RouteCapability,
    /// Server-resolved protected-object kind.
    pub object_kind: ProtectedObjectKind,
    /// Server-resolved operation intent (query or mutation).
    pub intent: OperationIntent,
    /// SHA-256 of the canonical server-resolved object identifier.
    /// For Channel: `SHA-256(channel_uuid.as_bytes())`.
    pub object_key: [u8; 32],
    /// Raw private channel UUID for the resource-authority DB lookup.
    /// Only set for `ProtectedObjectKind::Channel`. Never exposed externally;
    /// `object_key` is the only derived form that leaves the admission path.
    pub channel_uuid_raw: Option<[u8; 16]>,
}

impl VerifiedServerDirectContext {
    /// Construct a `VerifiedServerDirectContext` from trusted routing inputs.
    ///
    /// **Intended only for the trusted relay proof-validation path.** The
    /// caller must have already validated the Nostr proof and resolved all
    /// fields from authenticated server state. No client-supplied value may
    /// flow here (`FI-INV-04`).
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        transport: ProofTransport,
        proof_event_id: [u8; 32],
        proof_expires_at: DateTime<Utc>,
        actor: PublicKey,
        community_id: Uuid,
        capability: RouteCapability,
        object_kind: ProtectedObjectKind,
        intent: OperationIntent,
        object_key: [u8; 32],
        channel_uuid_raw: Option<[u8; 16]>,
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
            channel_uuid_raw,
        }
    }
}

// ── Exact protected use ───────────────────────────────────────────────────────

/// The exact capability/object/intent tuple presented by the caller when
/// redeeming a [`CommittedAuthorization`] via `authorize_protected_use`.
///
/// `authorize_protected_use` exact-matches this tuple against the committed
/// context; any mismatch denies the use without a receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExactProtectedUse {
    /// The requested capability.
    pub capability: RouteCapability,
    /// The requested protected-object kind.
    pub object_kind: ProtectedObjectKind,
    /// The requested operation intent.
    pub intent: OperationIntent,
    /// SHA-256 of the canonical server-resolved object identifier.
    pub object_key: [u8; 32],
}

// ── Binding types ─────────────────────────────────────────────────────────────

/// The immutable enrollment provenance recorded in a binding row.
///
/// Corresponds to the `binding_provenance` column: `1 attested-key`,
/// `2 provisioned`, `3 risk-labelled TOFU`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingProvenance {
    /// Assertion carried a `nostr_pubkey` claim matching the proven actor.
    AttestedKey,
    /// Binding created by a separately authorized provisioning operation.
    Provisioned,
    /// TOFU enrollment: first-use binding under deployment TOFU risk posture.
    Tofu,
}

impl BindingProvenance {
    /// Closed integer code for `binding_provenance` column.
    pub const fn as_db_code(self) -> i16 {
        match self {
            Self::AttestedKey => 1,
            Self::Provisioned => 2,
            Self::Tofu => 3,
        }
    }
}

/// The prepared binding proposal.
///
/// Read-only evidence; preparation never writes a binding row (`FI-INV-08`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindingProposal {
    /// An active binding for `(domain, i, k)` already exists.
    Existing {
        /// The binding ID of the existing active binding.
        binding_id: Uuid,
        /// Monotonic binding version for stale-check on final admission.
        binding_version: i64,
        /// Enrollment provenance of the existing binding.
        provenance: BindingProvenance,
        /// Binding expiry deadline, if set, captured at preparation time.
        expires_at: Option<DateTime<Utc>>,
    },
    /// No active binding exists; final admission must create one atomically.
    Enroll {
        /// The federated identity to bind.
        identity: FederatedIdentity,
        /// The proven actor's public key.
        actor: PublicKey,
        /// Enrollment provenance for the new binding.
        provenance: BindingProvenance,
        /// Policy revision at enrollment time.
        policy_revision: i64,
    },
}

/// Snapshot of every dependency version read atomically during preparation.
///
/// Final admission compares each field against a current authoritative read
/// inside the SERIALIZABLE transaction:
///
/// - `invalidation_generation`: if advanced → `InvalidationGenerationAdvanced`
/// - `policy_revision`: if changed → re-evaluate local policy; if denied →
///   `PolicyRevisionChanged`
/// - `authority_epoch`: if changed for this object → `AuthorityEpochChanged`
/// - `lifecycle_revision`: binding lifecycle state version at preparation time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedDependencyVersions {
    /// Policy revision at preparation time.
    pub policy_revision: i64,
    /// Invalidation generation at preparation time.
    pub invalidation_generation: i64,
    /// Authority epoch for the target object at preparation time. `None`
    /// means the object had no epoch row (first-grant path).
    pub authority_epoch: Option<i64>,
    /// Authority fence for the target object at preparation time. `None`
    /// means no fence row exists yet.
    pub authority_fence: Option<i64>,
    /// Binding lifecycle revision at preparation time. `None` for fresh
    /// enrollment proposals.
    pub lifecycle_revision: Option<i64>,
}

// ── Admission error ───────────────────────────────────────────────────────────

/// Closed, stable admission failure.
///
/// Every variant maps to exactly one [`DenialClass`]; granular codes are for
/// access-controlled logs only. No variant carries credential material
/// (`FI-INV-13`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AdmissionError {
    // ── Evidence rejection (403 EvidenceRejected) ────────────────────────────
    /// A prepared deadline did not survive preparation → commit.
    #[error("prepared assertion deadline expired between preparation and admission")]
    PreparedDeadlineExpired,

    /// The re-verified assertion differs from the prepared one on an
    /// identity-class field, or a bounds-class deadline regressed.
    #[error("prepared assertion is not equivalent to current revalidation")]
    AssertionEquivalenceViolation,

    /// An assertion-policy or transport-contract ID changed between
    /// preparation and admission.
    #[error("contract ID changed between preparation and admission")]
    ContractIdChanged,

    // ── Authorization denial (403 AuthorizationDenied) ───────────────────────
    /// Actor key appears in the revoked-key selector set `Y_D(k)`.
    #[error("actor key is revoked")]
    KeyRevoked,

    /// Exact `(i, k)` pair appears in the retired-pair selector set `T_D(i,k)`.
    #[error("identity/key pair is retired")]
    PairRetired,

    /// A different active binding exists for `i` or `k` in this domain.
    #[error("binding conflict: another active binding exists for this identity or key")]
    BindingConflict,

    /// Enrollment policy is `attested-key` but no matching `nostr_pubkey` claim.
    #[error("attested-key enrollment required but no key attestation in assertion")]
    AttestationRequired,

    /// Enrollment policy requires an existing binding; no enrollment permitted.
    #[error("existing binding required; enrollment not permitted")]
    BindingRequired,

    /// Local policy denied the operation for this context tuple.
    #[error("local policy denied the operation")]
    LocalPolicyDenied,

    /// Invalidation generation advanced between preparation and admission.
    #[error("invalidation generation advanced: prepared evidence is stale")]
    InvalidationGenerationAdvanced,

    /// Policy revision changed; re-evaluated local policy denied.
    #[error("policy revision changed: re-evaluated local policy denied")]
    PolicyRevisionChanged,

    /// The prepared binding version no longer matches current state.
    #[error("prepared binding version is stale")]
    PreparedBindingVersionStale,

    /// The authority epoch for the target object changed between preparation
    /// and admission; the prepared proposal may not apply.
    #[error("protected object authority epoch changed: prepared evidence is stale")]
    AuthorityEpochChanged,

    /// The proof event identity was already committed for this community.
    /// Classified `AuthorizationDenied` so replay is indistinguishable from
    /// any other private-state denial (`FI-TRACE-DENIAL-ORACLE`).
    #[error("proof identity already committed: replay denied")]
    ProofReplayed,

    /// Protected use tuple did not exactly match the committed context.
    /// Classified `AuthorizationDenied` to prevent operation/resource
    /// cross-use oracle attacks.
    #[error("exact protected-use tuple does not match committed context")]
    ProtectedUseMismatch,

    // ── Availability failure (503 AuthorizationUnavailable) ──────────────────
    /// Authorization audit capacity exhausted or unhealthy.
    #[error("authorization audit capacity exhausted or unavailable")]
    AuditCapacityUnavailable,

    /// A required authoritative dependency could not be read.
    #[error("required authoritative dependency unavailable")]
    AuthoritativeDependencyUnavailable,
}

impl AdmissionError {
    /// The public denial class for this error.
    pub const fn denial_class(self) -> DenialClass {
        match self {
            Self::PreparedDeadlineExpired
            | Self::AssertionEquivalenceViolation
            | Self::ContractIdChanged => DenialClass::EvidenceRejected,

            Self::KeyRevoked
            | Self::PairRetired
            | Self::BindingConflict
            | Self::AttestationRequired
            | Self::BindingRequired
            | Self::LocalPolicyDenied
            | Self::InvalidationGenerationAdvanced
            | Self::PolicyRevisionChanged
            | Self::PreparedBindingVersionStale
            | Self::AuthorityEpochChanged
            | Self::ProofReplayed
            | Self::ProtectedUseMismatch => DenialClass::AuthorizationDenied,

            Self::AuditCapacityUnavailable | Self::AuthoritativeDependencyUnavailable => {
                DenialClass::AuthorizationUnavailable
            }
        }
    }

    /// Stable machine code for access-controlled logs and metrics.
    pub const fn code(self) -> &'static str {
        match self {
            Self::PreparedDeadlineExpired => "nip_fi_prepared_deadline_expired",
            Self::AssertionEquivalenceViolation => "nip_fi_assertion_equivalence_violation",
            Self::ContractIdChanged => "nip_fi_contract_id_changed",
            Self::KeyRevoked => "nip_fi_key_revoked",
            Self::PairRetired => "nip_fi_pair_retired",
            Self::BindingConflict => "nip_fi_binding_conflict",
            Self::AttestationRequired => "nip_fi_attestation_required",
            Self::BindingRequired => "nip_fi_binding_required",
            Self::LocalPolicyDenied => "nip_fi_local_policy_denied",
            Self::InvalidationGenerationAdvanced => "nip_fi_invalidation_generation_advanced",
            Self::PolicyRevisionChanged => "nip_fi_policy_revision_changed",
            Self::PreparedBindingVersionStale => "nip_fi_prepared_binding_version_stale",
            Self::AuthorityEpochChanged => "nip_fi_authority_epoch_changed",
            Self::ProofReplayed => "nip_fi_proof_replayed",
            Self::ProtectedUseMismatch => "nip_fi_protected_use_mismatch",
            Self::AuditCapacityUnavailable => "nip_fi_audit_capacity_unavailable",
            Self::AuthoritativeDependencyUnavailable => {
                "nip_fi_authoritative_dependency_unavailable"
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_evidence_rejection_variant_maps_to_evidence_rejected() {
        for v in [
            AdmissionError::PreparedDeadlineExpired,
            AdmissionError::AssertionEquivalenceViolation,
            AdmissionError::ContractIdChanged,
        ] {
            assert_eq!(v.denial_class(), DenialClass::EvidenceRejected, "{v:?}");
        }
    }

    #[test]
    fn every_private_state_variant_maps_to_authorization_denied() {
        for v in [
            AdmissionError::KeyRevoked,
            AdmissionError::PairRetired,
            AdmissionError::BindingConflict,
            AdmissionError::AttestationRequired,
            AdmissionError::BindingRequired,
            AdmissionError::LocalPolicyDenied,
            AdmissionError::InvalidationGenerationAdvanced,
            AdmissionError::PolicyRevisionChanged,
            AdmissionError::PreparedBindingVersionStale,
            AdmissionError::AuthorityEpochChanged,
            AdmissionError::ProofReplayed,
            AdmissionError::ProtectedUseMismatch,
        ] {
            assert_eq!(v.denial_class(), DenialClass::AuthorizationDenied, "{v:?}");
        }
    }

    #[test]
    fn every_availability_variant_maps_to_authorization_unavailable() {
        for v in [
            AdmissionError::AuditCapacityUnavailable,
            AdmissionError::AuthoritativeDependencyUnavailable,
        ] {
            assert_eq!(
                v.denial_class(),
                DenialClass::AuthorizationUnavailable,
                "{v:?}"
            );
        }
    }

    #[test]
    fn every_variant_has_a_unique_stable_code() {
        let variants = [
            AdmissionError::PreparedDeadlineExpired,
            AdmissionError::AssertionEquivalenceViolation,
            AdmissionError::ContractIdChanged,
            AdmissionError::KeyRevoked,
            AdmissionError::PairRetired,
            AdmissionError::BindingConflict,
            AdmissionError::AttestationRequired,
            AdmissionError::BindingRequired,
            AdmissionError::LocalPolicyDenied,
            AdmissionError::InvalidationGenerationAdvanced,
            AdmissionError::PolicyRevisionChanged,
            AdmissionError::PreparedBindingVersionStale,
            AdmissionError::AuthorityEpochChanged,
            AdmissionError::ProofReplayed,
            AdmissionError::ProtectedUseMismatch,
            AdmissionError::AuditCapacityUnavailable,
            AdmissionError::AuthoritativeDependencyUnavailable,
        ];
        let mut codes = std::collections::BTreeSet::new();
        for v in &variants {
            assert!(codes.insert(v.code()), "duplicate code: {}", v.code());
        }
        assert_eq!(codes.len(), variants.len());
    }

    #[test]
    fn binding_provenance_db_codes_are_schema_aligned() {
        assert_eq!(BindingProvenance::AttestedKey.as_db_code(), 1);
        assert_eq!(BindingProvenance::Provisioned.as_db_code(), 2);
        assert_eq!(BindingProvenance::Tofu.as_db_code(), 3);
    }

    #[test]
    fn route_capability_db_codes_are_schema_aligned() {
        // Core assertions — the full table is the source of truth above.
        assert_eq!(RouteCapability::MessagesRead.database_code(), 1);
        assert_eq!(RouteCapability::MessagesWrite.database_code(), 2);
        assert_eq!(RouteCapability::InviteClaim.database_code(), 29);
    }

    #[test]
    fn route_capability_codes_are_unique() {
        let capabilities = [
            RouteCapability::MessagesRead,
            RouteCapability::MessagesWrite,
            RouteCapability::ChannelsRead,
            RouteCapability::ChannelsWrite,
            RouteCapability::AdminChannels,
            RouteCapability::UsersRead,
            RouteCapability::UsersWrite,
            RouteCapability::AdminUsers,
            RouteCapability::JobsRead,
            RouteCapability::JobsWrite,
            RouteCapability::SubscriptionsRead,
            RouteCapability::SubscriptionsWrite,
            RouteCapability::FilesRead,
            RouteCapability::FilesWrite,
            RouteCapability::ReposRead,
            RouteCapability::ReposWrite,
            RouteCapability::GitRead,
            RouteCapability::GitWrite,
            RouteCapability::GitStream,
            RouteCapability::MediaRead,
            RouteCapability::MediaWrite,
            RouteCapability::Moderation,
            RouteCapability::AudioJoin,
            RouteCapability::AudioMedia,
            RouteCapability::Discovery,
            RouteCapability::BindingStatus,
            RouteCapability::Enrollment,
            RouteCapability::InviteMint,
            RouteCapability::InviteClaim,
        ];
        let mut codes = std::collections::BTreeSet::new();
        for c in &capabilities {
            assert!(
                codes.insert(c.database_code()),
                "duplicate capability code: {}",
                c.database_code()
            );
        }
        assert_eq!(codes.len(), capabilities.len());
    }

    #[test]
    fn protected_object_kind_codes_are_schema_aligned() {
        assert_eq!(ProtectedObjectKind::Domain.database_code(), 1);
        assert_eq!(ProtectedObjectKind::Channel.database_code(), 2);
        assert_eq!(ProtectedObjectKind::AudioSession.database_code(), 6);
    }

    #[test]
    fn operation_intent_codes_are_unique_and_aligned() {
        assert_eq!(OperationIntent::Query.database_code(), 1);
        assert_eq!(OperationIntent::Mutation.database_code(), 2);
        assert_ne!(
            OperationIntent::Query.database_code(),
            OperationIntent::Mutation.database_code()
        );
    }

    #[test]
    fn proof_transport_codes_are_unique() {
        assert_eq!(ProofTransport::Nip42.database_code(), 1);
        assert_eq!(ProofTransport::Nip98.database_code(), 2);
    }

    #[test]
    fn prepared_dependency_versions_carries_lifecycle_revision() {
        // Confirms the lifecycle_revision field exists and is accessible.
        let v = PreparedDependencyVersions {
            policy_revision: 7,
            invalidation_generation: 3,
            authority_epoch: Some(2),
            authority_fence: None,
            lifecycle_revision: Some(1),
        };
        assert_eq!(v.policy_revision, 7);
        assert_eq!(v.lifecycle_revision, Some(1));
        assert!(v.authority_fence.is_none());
    }
}
