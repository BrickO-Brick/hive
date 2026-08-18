//! Owner-identity egress registry — revocation of pre-latch capability (P29-C1).
//!
//! # Why this exists
//!
//! Making `AppState.keys` private (P28-C1) closes capability ACQUISITION but
//! cannot revoke owner `Keys` already CLONED before an identity transition. At
//! base, long-lived tasks (huddle STT) capture the owner keys once and then
//! sign, build NIP-98 authorization, and transmit indefinitely without
//! consulting `AppState` again, and the explicit-key egress funnels
//! (`submit_signed_event_at_with_keys`, `submit_event_at_with_keys`,
//! `submit_signed_event_with_keys`, `submit_event_with_keys`,
//! `query_relay_at_with_keys`, `build_nip98_auth_header{,_for_keys}`) accept an
//! already-issued `&Keys` with no latch or generation check. A task that
//! captured keys under identity A and resumes after the coordinator has latched
//! an ambiguous transition would sign and transmit as the unresolved identity.
//!
//! This module makes owner-identity egress itself latch-aware, reusing the
//! admission + RAII lease + drain-barrier shape rather than inventing a
//! parallel mechanism:
//!
//! - A **process-global registry** carries an *identity-persistence
//!   generation* and an admission [`IdentityPersistenceState`].
//! - Every owner-identity sign / NIP-98-build / network-submit funnel acquires
//!   an [`OwnerIdentityEgressLease`] at the last irreversible boundary via
//!   [`try_admit_owner_identity_egress`]; admission validates — immediately
//!   before the operation — that the state is [`Live`](IdentityPersistenceState::Live).
//!   The lease is held only across sign → auth → transmit, never across
//!   rate-limit waits, which bounds the drain below.
//! - The identity-transition coordinator, after the runtime drain and BEFORE
//!   the journal write + durable B dispatch, calls [`begin_egress_drain`] to
//!   bump the generation and refuse new admission, then [`await_egress_drain`]
//!   to await every in-flight lease — so no send begun under identity A can
//!   cross the durable-dispatch boundary. The TOCTOU window is closed by
//!   linearization (admission and state transitions share one lock), not by
//!   prose. New admission resumes only at a proven exit via
//!   [`resume_egress_live`] (`Committed` / `DefinitelyUnchanged` /
//!   verified-rollback) or is latched fail-closed via
//!   [`latch_identity_indeterminate`] on the ambiguous branch (P28-C1).
//!
//! # Scope of this landing (C1a)
//!
//! This is the P29 substrate only: the registry, the per-send RAII lease, and
//! the coordinator drain/latch API. No production path drives a transition yet
//! — the generation never bumps and the state stays
//! [`Live`](IdentityPersistenceState::Live) until the identity-transition
//! coordinator wires the drain — so this landing is behavior-preserving. The
//! generic `OwnerIdentityCapability<T>` with its `Session`/`Bearer`/`Artifact`
//! policies is a later extension of this same registry; the per-send lease is
//! its `BoundedLease` instantiation, and its public name is fixed here so the
//! funnel witness signatures stay stable across that extension.
//!
//! # Closed-world egress construction sites (C1c condition 3)
//!
//! The `EgressLease` witness is minted only at the enumerated sites below. A
//! new send that skips admission fails to compile (no witness) and fails the
//! C8 closed-world sink-test enumeration. The `relay_admission` module doc and
//! that sink test enumerate exactly this set. Two disjoint construction sets
//! exist: the owner-identity sites (`try_admit_owner_identity_egress`) and the
//! **eight** managed-agent keyed sites (`admit_managed_agent_egress`) — the
//! ruled `ManagedAgentKeyed` construction set.
//!
//! Owner-identity (`try_admit_owner_identity_egress`):
//! - `submit_event` / `query_relay_at` / `build_nip98_auth_header` — the
//!   owner-default wrappers self-admit, so their transitive callers need no
//!   witness.
//! - `mesh_llm::coordinator` status-report publication.
//! - `commands::profile::update_profile_at_relay` — query → submit → re-query,
//!   three admissions (the exactly-once-per-op live case).
//! - `managed_agents::persona_events`, `commands::personas::sharing`,
//!   `commands::channels` (×3), and the huddle STT task (per-send inline
//!   owner lease).
//! - `commands::identity::create_auth_event` — the relay-WS reconnection
//!   NIP-42 handshake (per-send lease). The signed auth event is an
//!   owner-signed relay-event ARTIFACT: stamped and threaded to the frontend
//!   as `{value, artifact}`, validated in C6/C7. Frontend session REGISTRATION
//!   (native-WS teardown handle) defers to C6/C7 with the frontend identity
//!   store.
//! - **Owner-identity artifacts** — the seven `commands::identity` producers
//!   `sign_event`, `create_auth_event`, `build_observer_control_event`,
//!   `sign_nostr_identity_binding`, `nip44_encrypt_to_self`,
//!   `nip44_decrypt_from_self`, and `decrypt_observer_event` admit a bounded
//!   lease BEFORE the owner-key sign/encrypt/decrypt, register an
//!   [`OwnerIdentityCapability<ArtifactPolicy>`], and return the owner-key
//!   value wrapped as [`StampedArtifact`] (`{value, artifact:{id,generation}}`).
//!   Artifacts carry NO side-effecting teardown: their only revocation is the
//!   application-site generation compare, triggered by the transition bump
//!   (shape (ii)). The frontend threads the pair opaque; C6/C7 adds the
//!   compare at each application boundary. Rust-consumed / collapsed-transaction
//!   artifacts (`project_git_workflow` sign+submit, archive-ingest decrypts,
//!   snapshot-import, engram-listing decrypt) exercise synchronously inside
//!   their lease and keep the collapsed shape — inventoried for C5/C6.
//! - **Durable bearers** — `commands::media::mint_media_get_auth` (Blossom
//!   `t=get`) and the `do_upload` `t=upload` mint sign under a bounded lease
//!   and register an [`OwnerIdentityCapability<BearerPolicy>`]; the four
//!   get-auth attach sites (`media_download`, `personas::card`, `media_proxy`
//!   ×2) and the upload dispatch validate it before the HTTP send.
//!
//! Managed-agent keyed (`admit_managed_agent_egress`) — the four sink sites
//! plus the git-workflow branch, variant selected at runtime by
//! `ProjectOwnerIdentity::is_managed_agent` (never derived from `auth_tag`):
//! 1. `submit_engram_event` (snapshot import).
//! 2. `sync_managed_agent_profile`.
//! 3. the agent query probe (`runtime_commands`).
//! 4. `commands::messages::send_managed_agent_channel_message` — the
//!    managed-agent channel message send (`add_reaction`/`remove_reaction`
//!    publish through the self-admitting owner wrappers and are NOT
//!    `ManagedAgentKeyed` sites).
//! 5. the four `project_git_workflow` PR-status/merge sends (items 5–8).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

use tokio::sync::Notify;

/// Admission state of owner-identity egress — the third recovery state
/// (`Indeterminate`) extends the existing `AppState::identity_lost` /
/// `keyring_locked` model (P28-C1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityPersistenceState {
    /// Persistence is settled: egress admission succeeds and the checked key
    /// accessors serve keys normally.
    Live,
    /// A transition is draining in-flight egress before its durable dispatch.
    /// New lease admission is refused; the checked key accessors still serve
    /// keys, because already-admitted in-flight leases hold their own captures
    /// and complete under the outgoing identity before the durable dispatch.
    /// Transient and in-memory only — cleared at a proven exit.
    // Consumed by C5 (P25/P28 coordinator); remove allow when C5 lands.
    #[allow(dead_code)]
    Draining,
    /// A completed transition could not prove EITHER durable identity
    /// canonical. Latched durable fail-closed: owner-identity egress admission
    /// AND the checked key accessors refuse until reconciliation proves one
    /// durable identity canonical. This is the P28-C1 third recovery state,
    /// gating all checked identity access.
    Indeterminate,
}

/// Mutable registry state, guarded by a single mutex so admission and every
/// state transition linearize (closing the check-then-send TOCTOU window).
struct RegistryInner {
    state: IdentityPersistenceState,
    /// Number of admitted leases not yet dropped. The drain awaits this
    /// reaching zero.
    in_flight: u64,
}

/// Process-global owner-identity egress registry. One per process, mirroring
/// the scope-generation authority in [`crate::managed_agents::scope`].
struct Registry {
    inner: Mutex<RegistryInner>,
    /// Monotonic identity-persistence generation. Read lock-free on the hot
    /// admission path; only ever advanced by [`begin_egress_drain`] under
    /// `inner`.
    generation: AtomicU64,
    /// Notified when `in_flight` reaches zero so the drain can wake.
    drained: Notify,
}

static REGISTRY: LazyLock<Registry> = LazyLock::new(|| Registry {
    inner: Mutex::new(RegistryInner {
        state: IdentityPersistenceState::Live,
        in_flight: 0,
    }),
    generation: AtomicU64::new(0),
    drained: Notify::new(),
});

fn lock_inner() -> std::sync::MutexGuard<'static, RegistryInner> {
    // A poisoned egress lock means a lease-holding thread panicked mid-send.
    // The counters remain consistent (the panicking thread's lease Drop still
    // runs), so recover the guard rather than propagating the poison and
    // wedging every subsequent admission and drain.
    REGISTRY
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The current identity-persistence generation. A lease is valid only while
/// this equals the generation captured at its admission.
// Consumed by C5 (P25/P28 coordinator); remove allow when C5 lands.
#[allow(dead_code)]
pub fn current_identity_persistence_generation() -> u64 {
    REGISTRY.generation.load(Ordering::Acquire)
}

/// The current admission state.
// Consumed by C5 (P25/P28 coordinator); remove allow when C5 lands.
#[allow(dead_code)]
pub fn identity_persistence_state() -> IdentityPersistenceState {
    lock_inner().state
}

/// Whether owner-identity persistence is latched `Indeterminate`. The checked
/// key accessors (P28-C1) refuse when this is `true`.
pub fn is_identity_indeterminate() -> bool {
    lock_inner().state == IdentityPersistenceState::Indeterminate
}

/// A per-send owner-identity egress lease — the `BoundedLease` capability.
///
/// Acquired at the last irreversible egress boundary and held only across
/// sign → auth → transmit. Dropping it decrements the in-flight count so the
/// coordinator's drain can complete. Not `Clone` and carries no keys: the
/// caller pairs it with a per-send key acquisition through the checked
/// accessor, so a lease can never outlive the send it authorizes.
#[derive(Debug)]
#[must_use = "an egress lease authorizes exactly one sign/auth/transmit window; \
              hold it across that window and drop it immediately after"]
pub struct OwnerIdentityEgressLease {
    /// The identity-persistence generation current at admission.
    // Consumed by C5 (P25/P28 coordinator); remove allow when C5 lands.
    #[allow(dead_code)]
    generation: u64,
}

impl OwnerIdentityEgressLease {
    /// The identity-persistence generation this lease was admitted under.
    /// Stamped onto durable capabilities issued under this lease so they fail
    /// closed if a transition bumped the generation after admission.
    pub fn generation(&self) -> u64 {
        self.generation
    }
}

impl Drop for OwnerIdentityEgressLease {
    fn drop(&mut self) {
        let mut inner = lock_inner();
        inner.in_flight = inner.in_flight.saturating_sub(1);
        let drained = inner.in_flight == 0;
        drop(inner);
        if drained {
            // Wake a drain awaiting the last in-flight lease. Harmless when no
            // drain is in progress (no waiter registered).
            REGISTRY.drained.notify_waiters();
        }
    }
}

/// Admit an owner-identity egress send, returning a lease bound to the current
/// identity-persistence generation.
///
/// Admission performs the relay rate-limit wait FIRST, then admits: the lease
/// is born *after* the wait completes, so it never spans the wait by
/// construction (spec L4505–4508) and the coordinator drain it participates in
/// stays bounded. Because the explicit-key funnels require an
/// [`EgressLease`] witness and the only constructors of one are these `admit_*`
/// entry points, a send can never reach the funnel without having waited — no
/// call site can forget the rate-limit wait (the funnels no longer wait
/// themselves).
///
/// Succeeds only in [`IdentityPersistenceState::Live`]. Returns `Err` when a
/// transition is [`Draining`](IdentityPersistenceState::Draining) (new
/// admission refused while in-flight sends complete) or the state is latched
/// [`Indeterminate`](IdentityPersistenceState::Indeterminate) (fail-closed
/// after an unprovable transition). The admission check and the generation read
/// happen under one lock AFTER the wait, so the lease reflects the persistence
/// state immediately before the operation — a wait that overlaps a drain
/// refuses on wake rather than admitting a stale generation.
pub async fn try_admit_owner_identity_egress() -> Result<OwnerIdentityEgressLease, String> {
    crate::relay_admission::wait_for_rate_limit().await;
    admit_owner_identity_after_wait()
}

/// The post-wait owner-identity admission check + in-flight bump, under one
/// lock. Split from the wait so the state-machine invariants are unit-testable
/// without driving the async rate-limit gate.
fn admit_owner_identity_after_wait() -> Result<OwnerIdentityEgressLease, String> {
    let mut inner = lock_inner();
    match inner.state {
        IdentityPersistenceState::Live => {
            inner.in_flight += 1;
            Ok(OwnerIdentityEgressLease {
                generation: REGISTRY.generation.load(Ordering::Acquire),
            })
        }
        IdentityPersistenceState::Draining => Err(
            "owner-identity egress is draining for an identity transition; \
             signing and publishing are paused until it resolves"
                .to_string(),
        ),
        IdentityPersistenceState::Indeterminate => Err(
            "owner identity is in an indeterminate recovery state; event \
             signing is disabled until the identity is reconciled and Buzz is \
             relaunched"
                .to_string(),
        ),
    }
}

/// Begin the coordinator's egress drain: bump the identity-persistence
/// generation and close new admission (state → `Draining`). Returns the new
/// generation. Call this after the runtime drain and BEFORE the journal write
/// + durable B dispatch, then [`await_egress_drain`] to await in-flight leases.
///
/// Idempotent-guard: only transitions from `Live`. Returns `Err` if a
/// transition is already in flight or latched — the coordinator serializes
/// transitions under its own guards, so this is a defensive invariant check.
// Consumed by C5 (P25/P28 coordinator); remove allow when C5 lands.
#[allow(dead_code)]
pub fn begin_egress_drain() -> Result<u64, String> {
    let mut inner = lock_inner();
    if inner.state != IdentityPersistenceState::Live {
        return Err(format!(
            "cannot begin egress drain from state {:?}; a transition is already \
             in flight or latched",
            inner.state
        ));
    }
    inner.state = IdentityPersistenceState::Draining;
    // Bump under the lock so no `Live` admission can capture the pre-bump
    // generation after the state has flipped to `Draining`.
    Ok(REGISTRY.generation.fetch_add(1, Ordering::AcqRel) + 1)
}

/// Await every in-flight lease admitted before the drain began. Returns once
/// no lease is outstanding. Holds no lock across its await, and an in-flight
/// lease never re-acquires a state guard mid-lease, so the drain cannot
/// deadlock against a send it is waiting on.
// Consumed by C5 (P25/P28 coordinator); remove allow when C5 lands.
#[allow(dead_code)]
pub async fn await_egress_drain() {
    loop {
        let notified = REGISTRY.drained.notified();
        tokio::pin!(notified);
        // Register the waiter BEFORE reading the count so a lease Drop that
        // reaches zero between the read and the await cannot be lost.
        notified.as_mut().enable();
        if lock_inner().in_flight == 0 {
            return;
        }
        notified.await;
    }
}

/// Resume admission at a proven transition exit (`Committed` finished, or
/// `DefinitelyUnchanged` / verified-rollback): state → `Live`. The generation
/// is already current for the winning identity, so leases admitted from here
/// carry it.
// Consumed by C5 (P25/P28 coordinator); remove allow when C5 lands.
#[allow(dead_code)]
pub fn resume_egress_live() {
    lock_inner().state = IdentityPersistenceState::Live;
}

/// Latch the durable fail-closed state on the ambiguous branch (P28-C1): state
/// → `Indeterminate`. Owner-identity egress admission and the checked key
/// accessors refuse until [`resume_egress_live`] is called after reconciliation
/// proves one durable identity canonical.
// Consumed by C5 (P25/P28 coordinator); remove allow when C5 lands.
#[allow(dead_code)]
pub fn latch_identity_indeterminate() {
    lock_inner().state = IdentityPersistenceState::Indeterminate;
}

/// A witness that an owner-identity egress funnel caller holds a valid egress
/// capability for the send it is about to perform.
///
/// The explicit-key funnels (`submit_signed_event_at_with_keys`,
/// `submit_event_at_with_keys`, `submit_signed_event_with_keys`,
/// `submit_event_with_keys`, `query_relay_at_with_keys`,
/// `build_nip98_auth_header{,_for_keys}`) take an
/// `&EgressLease` so NO unleased caller shape exists — a bypass is a compile
/// error, not a convention (P29-C1). Two caller classes share those funnels,
/// so the witness accommodates both:
///
/// - [`OwnerIdentity`](EgressLease::OwnerIdentity) — the fully-real owner
///   capability: a generation-qualified [`OwnerIdentityEgressLease`] admitted
///   by [`try_admit_owner_identity_egress`], which refuses under the P28-C1
///   latch and while a transition drains.
/// - [`ManagedAgentKeyed`](EgressLease::ManagedAgentKeyed) — an interim token
///   for managed-agent-key callers (the genuine agent callers of
///   `build_nip98_auth_header_for_keys`: `sync_managed_agent_profile`,
///   `submit_engram_event`, and the agent query-probe). See
///   [`ManagedAgentEgressLease`] for the Phase-4 contract this interim shape
///   defers.
#[derive(Debug)]
pub enum EgressLease {
    /// The fully-real owner-identity capability (P29-C1).
    // Consumed by C5 (P25/P28 coordinator); remove allow when C5 lands.
    #[allow(dead_code)]
    OwnerIdentity(OwnerIdentityEgressLease),
    /// The interim managed-agent-key capability (Phase 4 completes it).
    // Consumed by C5 (P25/P28 coordinator); remove allow when C5 lands.
    #[allow(dead_code)]
    ManagedAgentKeyed(ManagedAgentEgressLease),
}

/// Interim managed-agent keyed-egress capability — the seam Phase 4 completes.
///
/// # Phase-4 contract (the deferred half)
///
/// The §3.3a P29 contract requires the shared explicit-key funnels to admit a
/// "§3.3 keyed-egress lease for managed-agent callers … which already refuse
/// under the latch." The full §3.3 keyed-egress substrate — split
/// admission/drain keys, per-scope generation gating, and the
/// `admit_keyed_egress()` constructor — is Phase 4 work (§8 item 4), sequenced
/// AFTER Phase 3b. This interim newtype exists so the funnels take a uniform
/// [`EgressLease`] witness from Phase 3b onward and their signatures never
/// churn across the phase boundary.
///
/// **`admit_managed_agent_egress` is the ONLY constructor and will be replaced
/// by Phase 4's `admit_keyed_egress`, which adds the deferred scope-generation
/// gate.** This interim form implements only the latch/drain half: it refuses
/// admission whenever owner-identity persistence is not [`Live`] (the P28-C1
/// latch, or a transition drain). Phase 4 ADDS scope-generation gating to an
/// already-fail-closed token — it never loosens this behavior. Managed-agent
/// scope is keyed by `(relay, owner)`; when owner identity persistence is
/// `Indeterminate`, which scope is legitimately active is itself indeterminate,
/// so agent egress must fail closed there — the exact cross-scope leak this arc
/// exists to prevent.
#[derive(Debug)]
#[must_use = "a managed-agent egress capability authorizes exactly one \
              agent-key sign/auth/transmit window"]
pub struct ManagedAgentEgressLease {
    /// The owner identity-persistence generation current at admission. Held so
    /// the coordinator's drain awaits agent sends in flight at the barrier,
    /// exactly as it awaits owner leases.
    // Consumed by C5 (P25/P28 coordinator); remove allow when C5 lands.
    #[allow(dead_code)]
    generation: u64,
}

impl ManagedAgentEgressLease {
    /// The owner identity-persistence generation this capability was admitted
    /// under.
    // Consumed by C5 (P25/P28 coordinator); remove allow when C5 lands.
    #[allow(dead_code)]
    pub fn generation(&self) -> u64 {
        self.generation
    }
}

impl Drop for ManagedAgentEgressLease {
    fn drop(&mut self) {
        let mut inner = lock_inner();
        inner.in_flight = inner.in_flight.saturating_sub(1);
        let drained = inner.in_flight == 0;
        drop(inner);
        if drained {
            REGISTRY.drained.notify_waiters();
        }
    }
}

/// Admit a managed-agent keyed-egress send — the interim P29 seam (see
/// [`ManagedAgentEgressLease`] for the Phase-4 contract).
///
/// Waits out the relay rate-limit gate FIRST, then admits, so the interim
/// capability shares the wait-in-admission shape of
/// [`try_admit_owner_identity_egress`]: the lease never spans the wait and no
/// agent call site can forget it.
///
/// Refuses whenever owner-identity persistence is not [`Live`] (latched
/// `Indeterminate`, or a transition draining), matching the "already refuse
/// under the latch" requirement. Phase 4's `admit_keyed_egress` replaces this
/// and adds the deferred scope-generation gate.
pub async fn admit_managed_agent_egress() -> Result<ManagedAgentEgressLease, String> {
    crate::relay_admission::wait_for_rate_limit().await;
    admit_managed_agent_after_wait()
}

/// The post-wait managed-agent admission check + in-flight bump, under one
/// lock. Split from the wait so the state-machine invariants are unit-testable
/// without driving the async rate-limit gate.
fn admit_managed_agent_after_wait() -> Result<ManagedAgentEgressLease, String> {
    let mut inner = lock_inner();
    match inner.state {
        IdentityPersistenceState::Live => {
            inner.in_flight += 1;
            Ok(ManagedAgentEgressLease {
                generation: REGISTRY.generation.load(Ordering::Acquire),
            })
        }
        IdentityPersistenceState::Draining => Err(
            "owner-identity egress is draining for an identity transition; \
             managed-agent publishing is paused until it resolves"
                .to_string(),
        ),
        IdentityPersistenceState::Indeterminate => Err(
            "owner identity is in an indeterminate recovery state; the active \
             agent scope is unresolved, so managed-agent egress is disabled \
             until the identity is reconciled and Buzz is relaunched"
                .to_string(),
        ),
    }
}

/// Durable owner-identity capabilities (sessions, bearers) — authority that
/// outlives the bounded lease that derived it. Split into a child module for
/// file-size discipline; it shares this module's one registry.
mod durable;
pub use durable::{
    register_owner_artifact, register_owner_bearer, register_owner_session, BearerPolicy,
    OwnerIdentityCapability, SessionPolicy, StampedArtifact,
};
// The C5 coordinator barrier and its registration-completeness reader; no
// production caller until C5, so the re-exports are unused today. Consumed by
// C5 (P25/P28); remove allow when C5 lands.
#[allow(unused_imports)]
pub use durable::revoke_durable_capabilities_before;
// The artifact policy marker and its wire stamp are named at the frontend
// application sites in C6/C7 (generation-compare) and by the §7 artifact
// schedules; no production Rust caller names them today. Remove allow when
// C6/C7 lands.
#[allow(unused_imports)]
pub use durable::{ArtifactPolicy, ArtifactStamp};

/// Process-global mutex serializing tests that mutate the registry's
/// process-global state. Any test that admits a lease, drives a drain, or
/// latches must hold this guard for its whole duration and reset via
/// [`reset_registry_for_test`] on entry, because all tests share one registry.
#[cfg(test)]
pub(crate) static EGRESS_REGISTRY_TEST_LOCK: Mutex<()> = Mutex::new(());

/// Reset the registry to its baseline (`Live`, zero in-flight) for a test.
/// The generation is monotonic and never resets, so tests assert relative
/// generation movement, never absolute values.
#[cfg(test)]
pub(crate) fn reset_registry_for_test() {
    let mut inner = lock_inner();
    inner.state = IdentityPersistenceState::Live;
    inner.in_flight = 0;
    drop(inner);
    durable::reset_for_test();
    // next_id is monotonic and never resets, mirroring the generation: tests
    // assert on presence/count and relative generation, never absolute ids.
}

/// Mint an owner-identity [`EgressLease`] for tests that exercise a funnel's
/// non-admission behavior (e.g. the NIP-49 egress-guard boundary or NIP-98
/// freshness) and only need a witness value. Admits directly through the
/// post-wait core so no rate-limit gate is driven.
#[cfg(test)]
pub(crate) fn test_owner_egress_lease() -> EgressLease {
    EgressLease::OwnerIdentity(
        admit_owner_identity_after_wait().expect("test lease admits when live"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard() -> std::sync::MutexGuard<'static, ()> {
        let g = EGRESS_REGISTRY_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reset_registry_for_test();
        g
    }

    #[test]
    fn admits_when_live() {
        let _g = guard();
        let lease = admit_owner_identity_after_wait().expect("live admits");
        assert_eq!(
            lease.generation(),
            current_identity_persistence_generation()
        );
        assert_eq!(identity_persistence_state(), IdentityPersistenceState::Live);
    }

    #[test]
    fn lease_drop_decrements_in_flight() {
        let _g = guard();
        {
            let _lease = admit_owner_identity_after_wait().unwrap();
            assert_eq!(lock_inner().in_flight, 1);
        }
        assert_eq!(lock_inner().in_flight, 0, "drop must decrement");
    }

    #[test]
    fn begin_drain_bumps_generation_and_refuses_new_admission() {
        let _g = guard();
        let before = current_identity_persistence_generation();
        let new_gen = begin_egress_drain().expect("live drains");
        assert_eq!(new_gen, before + 1, "drain bumps the generation by one");
        assert_eq!(
            identity_persistence_state(),
            IdentityPersistenceState::Draining
        );
        assert!(
            admit_owner_identity_after_wait().is_err(),
            "no new admission while draining"
        );
    }

    #[test]
    fn begin_drain_refuses_when_not_live() {
        let _g = guard();
        begin_egress_drain().unwrap();
        assert!(
            begin_egress_drain().is_err(),
            "cannot begin a second drain while one is in flight"
        );
    }

    #[test]
    fn resume_live_reopens_admission() {
        let _g = guard();
        begin_egress_drain().unwrap();
        assert!(admit_owner_identity_after_wait().is_err());
        resume_egress_live();
        assert!(
            admit_owner_identity_after_wait().is_ok(),
            "a proven exit reopens admission"
        );
    }

    #[test]
    fn latch_indeterminate_refuses_egress_and_reports_state() {
        let _g = guard();
        begin_egress_drain().unwrap();
        latch_identity_indeterminate();
        assert!(is_identity_indeterminate());
        assert_eq!(
            identity_persistence_state(),
            IdentityPersistenceState::Indeterminate
        );
        assert!(
            admit_owner_identity_after_wait().is_err(),
            "the indeterminate latch refuses all owner-identity egress"
        );
    }

    #[test]
    fn draining_does_not_report_indeterminate() {
        // The checked key accessors refuse on `Indeterminate` only; a
        // transient `Draining` must NOT trip the accessor refusal, so
        // already-admitted in-flight leases can still obtain keys per send.
        let _g = guard();
        begin_egress_drain().unwrap();
        assert!(
            !is_identity_indeterminate(),
            "draining is not the indeterminate latch"
        );
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // EGRESS_REGISTRY_TEST_LOCK serialises parallel tests
    async fn drain_returns_immediately_with_no_in_flight_leases() {
        let _g = guard();
        begin_egress_drain().unwrap();
        // No leases outstanding — the drain completes without blocking.
        await_egress_drain().await;
        assert_eq!(lock_inner().in_flight, 0);
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // EGRESS_REGISTRY_TEST_LOCK serialises parallel tests
    async fn drain_awaits_an_in_flight_lease_then_completes() {
        let _g = guard();
        let lease = admit_owner_identity_after_wait().unwrap();
        begin_egress_drain().unwrap();
        assert_eq!(lock_inner().in_flight, 1);

        // The drain must not complete while the lease is held; drop it from a
        // spawned task after the drain has begun awaiting.
        let handle = tokio::spawn(async move {
            tokio::task::yield_now().await;
            drop(lease);
        });

        await_egress_drain().await;
        assert_eq!(lock_inner().in_flight, 0, "drain awaited the lease drop");
        handle.await.unwrap();
    }

    #[test]
    fn lease_admitted_before_drain_carries_pre_bump_generation() {
        let _g = guard();
        let lease = admit_owner_identity_after_wait().unwrap();
        let admitted_gen = lease.generation();
        let new_gen = begin_egress_drain().unwrap();
        assert!(
            admitted_gen < new_gen,
            "a lease admitted under A is stale once the drain bumps to B"
        );
    }

    #[test]
    fn managed_agent_admits_when_live() {
        let _g = guard();
        let lease = admit_managed_agent_after_wait().expect("live admits agent egress");
        assert_eq!(
            lease.generation(),
            current_identity_persistence_generation()
        );
    }

    #[test]
    fn managed_agent_refuses_under_the_latch() {
        // Condition (2): the interim managed-agent variant refuses under the
        // P28-C1 latch, matching the spec's "already refuse under the latch".
        let _g = guard();
        begin_egress_drain().unwrap();
        latch_identity_indeterminate();
        assert!(
            admit_managed_agent_after_wait().is_err(),
            "the indeterminate latch refuses managed-agent egress"
        );
    }

    #[test]
    fn managed_agent_refuses_while_draining() {
        let _g = guard();
        begin_egress_drain().unwrap();
        assert!(
            admit_managed_agent_after_wait().is_err(),
            "no new agent admission while a transition drains"
        );
    }

    #[test]
    fn managed_agent_lease_participates_in_the_drain() {
        // The coordinator's drain must await agent sends in flight at the
        // barrier exactly as it awaits owner leases.
        let _g = guard();
        {
            let _lease = admit_managed_agent_after_wait().unwrap();
            assert_eq!(lock_inner().in_flight, 1);
        }
        assert_eq!(lock_inner().in_flight, 0, "agent lease drop decrements");
    }

    #[test]
    fn egress_lease_enum_wraps_both_variants() {
        let _g = guard();
        let owner = EgressLease::OwnerIdentity(admit_owner_identity_after_wait().unwrap());
        let agent = EgressLease::ManagedAgentKeyed(admit_managed_agent_after_wait().unwrap());
        assert!(matches!(owner, EgressLease::OwnerIdentity(_)));
        assert!(matches!(agent, EgressLease::ManagedAgentKeyed(_)));
        assert_eq!(lock_inner().in_flight, 2, "both variants hold a lease");
    }

    /// Wait-in-admission: an armed rate-limit gate holds admission until the
    /// window clears, and the lease is only born afterward. This is the
    /// structural guarantee that a leased send can never span the wait and no
    /// call site can forget it — the wait lives inside the sole lease
    /// constructor.
    #[tokio::test(start_paused = true)]
    #[allow(clippy::await_holding_lock)] // EGRESS_REGISTRY_TEST_LOCK serialises parallel tests
    async fn admission_waits_out_the_rate_limit_gate_before_leasing() {
        // Hold BOTH the registry guard and the gate serial: this test drives
        // the shared process-wide rate-limit static.
        let _serial = crate::relay_admission::TEST_SERIAL.lock().await;
        let _g = guard();
        crate::relay_admission::reset_rate_limit_gate();

        crate::relay_admission::activate_rate_limit(Some(30));
        let start = tokio::time::Instant::now();
        let lease = try_admit_owner_identity_egress()
            .await
            .expect("admits once the window clears");
        assert_eq!(
            tokio::time::Instant::now() - start,
            std::time::Duration::from_secs(30),
            "admission must wait out the full armed window before leasing"
        );
        // The lease exists only post-wait, so it is in-flight now, not during.
        assert_eq!(lock_inner().in_flight, 1);
        drop(lease);
        crate::relay_admission::reset_rate_limit_gate();
    }

    /// A gate armed while the state is latched still refuses AFTER the wait —
    /// the wait does not admit a send the coordinator has fenced off. Proves
    /// the check happens post-wait, closing the drain-during-wait window.
    #[tokio::test(start_paused = true)]
    #[allow(clippy::await_holding_lock)] // EGRESS_REGISTRY_TEST_LOCK serialises parallel tests
    async fn admission_refuses_after_wait_when_draining() {
        let _serial = crate::relay_admission::TEST_SERIAL.lock().await;
        let _g = guard();
        crate::relay_admission::reset_rate_limit_gate();

        crate::relay_admission::activate_rate_limit(Some(5));
        begin_egress_drain().unwrap();
        assert!(
            try_admit_owner_identity_egress().await.is_err(),
            "a drain begun before/during the wait refuses admission on wake"
        );
        assert_eq!(
            lock_inner().in_flight,
            0,
            "a refused admission leases nothing"
        );
        crate::relay_admission::reset_rate_limit_gate();
    }
}
