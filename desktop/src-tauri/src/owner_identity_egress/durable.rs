//! Durable owner-identity capabilities (C2 / P30-C1).
//!
//! Split from the parent module (which owns the bounded per-send lease, the
//! registry, and the coordinator drain/latch) so each file stays within the
//! desktop file-size discipline. This half is the DURABLE capability substrate:
//! authority that outlives the bounded lease that derived it (long-lived
//! sessions, pre-minted bearers). It reads the parent's registry generation
//! and admission state through `super::` — the two halves share ONE registry.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{LazyLock, Mutex};

use tokio_util::sync::CancellationToken;

use super::{lock_inner, IdentityPersistenceState, OwnerIdentityEgressLease, REGISTRY};

/// A generation-stamped, registry-tracked owner-identity capability whose
/// authority OUTLIVES the bounded lease that derived it.
///
/// The bounded [`OwnerIdentityEgressLease`] above covers authority derived and
/// consumed inside one sign → auth → transmit window. But two owner-key
/// operations mint authority that a LATER, separate operation exercises:
///
/// - **Sessions** ([`SessionPolicy`]) — the huddle audio socket authenticates
///   ONCE with a NIP-42 event, then a long-lived task emits unsigned frames
///   over the established peer indefinitely; the frontend relay WS is the same
///   shape (`create_auth_event` signs the handshake, later frames ride the
///   connection). Cloning the owner keys before the transition cannot express
///   that a later unsigned frame inherits pre-transition authority.
/// - **Bearers** ([`BearerPolicy`]) — `mint_media_get_auth` /
///   `sign_blossom_upload_auth` sign a server-scoped Blossom header that
///   callers attach at LATER HTTP transmissions, up to ten minutes after
///   issuance. The bearer TTL is wider than a transition, so TTL is not a
///   substitute for invalidation.
///
/// Every durable capability is REGISTERED in this same egress registry and
/// STAMPED with the identity-persistence generation current at issuance
/// (issuance itself runs under a bounded lease — the signing that derives the
/// capability is an ordinary leased operation). Every transmission over it
/// validates, immediately before the irreversible boundary (frame send /
/// header attach), BOTH current egress admission AND
/// `capability_generation == current identity-persistence generation`
/// ([`OwnerIdentityCapability::admit_exercise`]) — a stale capability is
/// refused with zero bytes sent. The type is the only carrier of that stamped
/// generation, so no exercise site can skip the check (there is no raw handle
/// to exercise).
///
/// The registry additionally holds each capability's REVOCATION HANDLE (the
/// session cancellation token; the bearer's registry id for invalidation), so
/// the C5 coordinator barrier only *invokes* what C2 already registered — it
/// never retrofits the registry schema. Registering the teardown authority is
/// substrate (C2); invoking it at the transition barrier is C5.
#[derive(Debug)]
#[must_use = "a durable owner-identity capability must be validated \
              (admit_exercise) immediately before every transmission over it"]
pub struct OwnerIdentityCapability<P: CapabilityPolicy> {
    /// Registry id — the key under which this capability's revocation handle
    /// lives, so the C5 barrier can invalidate it by generation.
    id: u64,
    /// The identity-persistence generation current when this capability was
    /// issued. Exercise is refused once the registry generation advances past
    /// it.
    generation: u64,
    _policy: std::marker::PhantomData<P>,
}

/// A policy distinguishing the durable capability kinds. Zero-sized markers —
/// the shared behavior (registration, generation-stamp, exercise validation,
/// revocation-handle storage) lives on [`OwnerIdentityCapability`]; the policy
/// only names the kind so the constructor inventory and the registry's
/// per-kind revocation are type-directed.
pub trait CapabilityPolicy: std::fmt::Debug + private::Sealed {
    /// A human label for diagnostics and the closed-world inventory.
    const KIND: &'static str;
}

/// Authenticated-connection authority (huddle audio socket, frontend relay
/// WS). The registered revocation handle is a [`CancellationToken`] whose
/// cancellation tears the connection down.
#[derive(Debug)]
pub struct SessionPolicy;
/// Pre-minted bearer authority (Blossom `t=get`/`t=upload` headers). The
/// registered revocation handle is the registry id; invalidation removes the
/// entry so a later attach fails admission.
#[derive(Debug)]
pub struct BearerPolicy;

impl CapabilityPolicy for SessionPolicy {
    const KIND: &'static str = "session";
}
impl CapabilityPolicy for BearerPolicy {
    const KIND: &'static str = "bearer";
}

mod private {
    pub trait Sealed {}
    impl Sealed for super::SessionPolicy {}
    impl Sealed for super::BearerPolicy {}
}

/// The revocation authority for one registered durable capability, invoked by
/// the C5 coordinator barrier to tear down old-generation authority before the
/// journal write + durable dispatch.
enum RevocationHandle {
    /// Cancel the connection (huddle socket / frontend WS teardown path).
    Session(CancellationToken),
    /// Bearer invalidation is by-entry: removing the registry entry is the
    /// invalidation, so no side-effecting handle is needed. The variant exists
    /// so the registry records the capability's kind for the per-kind barrier.
    Bearer,
}

/// Registry of live durable capabilities, keyed by capability id, under its
/// own [`Mutex`] (`DURABLE`) — separate from the bounded-lease state
/// (`REGISTRY.inner`). Registration is therefore NOT lock-linearized against
/// generation bumps: a bump can slip between a lease's admission and its
/// capability's registration. The safety guarantee is not lock ordering but
/// EXERCISE-TIME validation — each capability stamps its issuing lease's
/// generation and [`OwnerIdentityCapability::admit_exercise`] refuses once the
/// current generation advances past it, so a capability registered across a
/// bump fails closed on first use.
#[derive(Default)]
struct DurableRegistry {
    /// Next capability id. Monotonic; ids are never reused.
    next_id: u64,
    /// Live capabilities: id → (issued generation, revocation handle).
    entries: HashMap<u64, (u64, RevocationHandle)>,
}

static DURABLE: LazyLock<Mutex<DurableRegistry>> =
    LazyLock::new(|| Mutex::new(DurableRegistry::default()));

fn lock_durable() -> std::sync::MutexGuard<'static, DurableRegistry> {
    DURABLE.lock().unwrap_or_else(|p| p.into_inner())
}

/// Clear all registered durable capabilities. Called by the parent's
/// `reset_registry_for_test` so a test starts from an empty registry. `next_id`
/// is monotonic and never resets, mirroring the generation.
#[cfg(test)]
pub(super) fn reset_for_test() {
    lock_durable().entries.clear();
}

impl<P: CapabilityPolicy> OwnerIdentityCapability<P> {
    /// The identity-persistence generation this capability was issued under.
    // Consumed by C5 (barrier introspection) and the C2 tests; remove allow
    // when a production caller reads it.
    #[allow(dead_code)]
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Validate this capability immediately before an irreversible
    /// transmission over it (frame send / header attach). Succeeds only when
    /// egress admission is `Live` AND the stamped generation still equals the
    /// current identity-persistence generation. A stale or drained capability
    /// is refused so the caller sends zero bytes.
    ///
    /// This is a cheap compare, not a re-authentication: the durable
    /// capability already proved identity at issuance; exercise only confirms
    /// that proof has not been superseded by a transition.
    pub fn admit_exercise(&self) -> Result<(), String> {
        let inner = lock_inner();
        if inner.state != IdentityPersistenceState::Live {
            return Err(format!(
                "owner-identity {} capability cannot transmit: egress is {:?}",
                P::KIND,
                inner.state
            ));
        }
        let current = REGISTRY.generation.load(Ordering::Acquire);
        if self.generation != current {
            return Err(format!(
                "owner-identity {} capability is stale (issued under generation \
                 {}, current {}); the identity transitioned and this authority \
                 was revoked",
                P::KIND,
                self.generation,
                current
            ));
        }
        Ok(())
    }
}

impl<P: CapabilityPolicy> Drop for OwnerIdentityCapability<P> {
    fn drop(&mut self) {
        // Dropping the capability handle deregisters it — a session whose task
        // has ended or a bearer no longer attachable must not linger as a
        // revocation target. Barrier invalidation (C5) also removes entries;
        // the id is unique and never reused, so a double-remove is a no-op.
        lock_durable().entries.remove(&self.id);
    }
}

/// Issue a durable owner-identity session capability, registering its
/// cancellation token so the C5 barrier can tear the connection down.
///
/// Takes the issuing [`OwnerIdentityEgressLease`] as a witness and stamps the
/// generation THAT LEASE was admitted under — never a freshly re-read one. A
/// bump can slip between admission and registration (`begin_egress_drain`
/// advances the generation immediately, before in-flight leases drain), so
/// re-reading here would stamp the winning generation onto authority derived
/// from the losing identity — a barrier bypass. Stamping the lease generation
/// fails closed instead: if a bump slipped in, the stamp is already stale and
/// the first `admit_exercise` refuses.
///
/// Call this AFTER the authenticating sign/auth has completed under the lease
/// (issuance is an ordinary leased operation, spec L4569–4570) and the
/// connection is established. The lease may already be dropped — its generation
/// is copied here — but taking it by reference makes leased issuance
/// compile-enforced, not conventional.
pub fn register_owner_session(
    lease: &OwnerIdentityEgressLease,
    cancel: CancellationToken,
) -> OwnerIdentityCapability<SessionPolicy> {
    register_durable(lease.generation(), RevocationHandle::Session(cancel))
}

/// Issue a durable owner-identity bearer capability, registering it so the C5
/// barrier can invalidate it by generation.
///
/// Stamps the issuing [`OwnerIdentityEgressLease`]'s generation, not a re-read
/// one — see [`register_owner_session`] for why re-reading is a barrier bypass.
///
/// Call this immediately after minting the bearer header under the lease. Every
/// attach site validates the returned capability via
/// [`OwnerIdentityCapability::admit_exercise`] before the HTTP dispatch.
pub fn register_owner_bearer(
    lease: &OwnerIdentityEgressLease,
) -> OwnerIdentityCapability<BearerPolicy> {
    register_durable(lease.generation(), RevocationHandle::Bearer)
}

/// Register a durable capability stamped with `generation` and carrying
/// `handle` as its revocation authority. Shared by both constructors so the
/// id allocation and registry insert live in one place.
fn register_durable<P: CapabilityPolicy>(
    generation: u64,
    handle: RevocationHandle,
) -> OwnerIdentityCapability<P> {
    let mut durable = lock_durable();
    let id = durable.next_id;
    durable.next_id += 1;
    durable.entries.insert(id, (generation, handle));
    OwnerIdentityCapability {
        id,
        generation,
        _policy: std::marker::PhantomData,
    }
}

/// Revoke every durable capability issued under a generation older than
/// `winning_generation`: cancel old sessions (invoking each registered
/// [`CancellationToken`]) and drop old bearers (removing their entries so a
/// later attach fails [`OwnerIdentityCapability::admit_exercise`]). Returns the
/// number of capabilities revoked.
///
/// The C5 coordinator barrier calls this after
/// [`begin_egress_drain`]/[`await_egress_drain`] and BEFORE the journal write +
/// durable B dispatch, so no old-generation session or bearer can transmit
/// across the durable boundary. It only *invokes* the handles C2 registered.
// Consumed by C5 (P25/P28 coordinator barrier); remove allow when C5 lands.
#[allow(dead_code)]
pub fn revoke_durable_capabilities_before(winning_generation: u64) -> usize {
    let mut durable = lock_durable();
    let stale: Vec<u64> = durable
        .entries
        .iter()
        .filter(|(_, (gen, _))| *gen < winning_generation)
        .map(|(id, _)| *id)
        .collect();
    for id in &stale {
        if let Some((_, RevocationHandle::Session(cancel))) = durable.entries.remove(id) {
            cancel.cancel();
        }
    }
    stale.len()
}

/// The number of live durable capabilities registered. Used by the
/// registration-completeness assertion (C2) to prove every issued
/// session/bearer is present with a revocation handle the C5 barrier can
/// invoke.
// Consumed by C5 and the C2 registration-completeness tests; remove allow when
// a production caller lands.
#[allow(dead_code)]
pub fn live_durable_capability_count() -> usize {
    lock_durable().entries.len()
}

#[cfg(test)]
mod tests {
    use super::super::{
        begin_egress_drain, current_identity_persistence_generation, latch_identity_indeterminate,
        resume_egress_live,
    };
    use super::*;

    fn guard() -> std::sync::MutexGuard<'static, ()> {
        let g = super::super::EGRESS_REGISTRY_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        super::super::reset_registry_for_test();
        g
    }

    /// A bare owner-identity lease admitted under the current generation, for
    /// registering durable capabilities in tests.
    fn lease() -> OwnerIdentityEgressLease {
        super::super::admit_owner_identity_after_wait().expect("test lease admits when live")
    }

    #[test]
    fn durable_capabilities_stamp_the_current_generation() {
        let _g = guard();
        let session = register_owner_session(&lease(), CancellationToken::new());
        let bearer = register_owner_bearer(&lease());
        let current = current_identity_persistence_generation();
        assert_eq!(session.generation(), current);
        assert_eq!(bearer.generation(), current);
    }

    #[test]
    fn durable_capability_exercise_admits_when_live_and_current() {
        let _g = guard();
        let session = register_owner_session(&lease(), CancellationToken::new());
        let bearer = register_owner_bearer(&lease());
        assert!(session.admit_exercise().is_ok());
        assert!(bearer.admit_exercise().is_ok());
    }

    // §7 revocation schedule (session): a session issued under A cannot
    // transmit after the generation advances to B — the frame send is refused
    // with zero bytes. Drives the registry generation directly (C1 drain-test
    // pattern); no production transition driver exists until C5.
    #[test]
    fn stale_session_exercise_refuses_after_a_generation_bump() {
        let _g = guard();
        let session = register_owner_session(&lease(), CancellationToken::new());
        // A transition drains then resumes at the winning generation.
        begin_egress_drain().unwrap();
        resume_egress_live();
        assert!(
            session.admit_exercise().is_err(),
            "a session stamped under A must refuse to transmit after B wins"
        );
    }

    // §7 revocation schedule (bearer): same stale-generation control for the
    // pre-minted bearer attach path.
    #[test]
    fn stale_bearer_exercise_refuses_after_a_generation_bump() {
        let _g = guard();
        let bearer = register_owner_bearer(&lease());
        begin_egress_drain().unwrap();
        resume_egress_live();
        assert!(
            bearer.admit_exercise().is_err(),
            "a bearer minted under A must refuse to attach after B wins"
        );
    }

    // F1 regression: a capability REGISTERED after a bump but derived from a
    // lease admitted BEFORE it stamps the lease's (losing) generation, not the
    // winning one — so it fails closed. This is the barrier-bypass control:
    // before the stamp-from-lease fix, registration re-read the winning
    // generation and the capability survived the barrier and admitted under B.
    #[test]
    fn capability_registered_across_a_bump_stamps_the_losing_generation() {
        let _g = guard();
        // Lease admitted under the losing generation A.
        let lease = lease();
        // A transition begins and bumps the generation to B before the lease
        // drains (begin_egress_drain advances immediately).
        let winning = begin_egress_drain().unwrap();
        // Registration happens now, under the pre-bump lease.
        let bearer = register_owner_bearer(&lease);
        assert_eq!(
            bearer.generation(),
            winning - 1,
            "the capability stamps the lease's losing generation, not the winning one"
        );
        // The barrier revokes everything older than the winner — this bearer
        // is caught, not bypassed.
        assert_eq!(
            revoke_durable_capabilities_before(winning),
            1,
            "the across-a-bump capability is revoked by the barrier"
        );
        // And even had it survived, exercise refuses once the state is Live
        // again: its stamp is stale.
        resume_egress_live();
        drop(lease);
        assert!(
            bearer.admit_exercise().is_err(),
            "a capability derived from the losing identity must refuse to transmit"
        );
    }

    // Stale-capability ZERO-BYTES control (Paul's condition a): exercise
    // validation fails BEFORE any transmission, for both durable kinds, under
    // both a generation mismatch and the drain/latch state — so no site can
    // send a byte on stale authority.
    #[test]
    fn durable_exercise_refuses_while_draining_and_while_latched() {
        let _g = guard();
        let session = register_owner_session(&lease(), CancellationToken::new());
        let bearer = register_owner_bearer(&lease());
        begin_egress_drain().unwrap();
        assert!(
            session.admit_exercise().is_err(),
            "draining refuses session"
        );
        assert!(bearer.admit_exercise().is_err(), "draining refuses bearer");
        latch_identity_indeterminate();
        assert!(session.admit_exercise().is_err(), "latch refuses session");
        assert!(bearer.admit_exercise().is_err(), "latch refuses bearer");
    }

    // The C5 barrier cancels old-generation sessions and drops old bearers,
    // and does NOT touch capabilities issued at the winning generation.
    #[test]
    fn barrier_revokes_old_generation_capabilities_only() {
        let _g = guard();
        let old_session_cancel = CancellationToken::new();
        let old_session = register_owner_session(&lease(), old_session_cancel.clone());
        let _old_bearer = register_owner_bearer(&lease());
        assert_eq!(live_durable_capability_count(), 2);

        // Transition to B.
        let winning = begin_egress_drain().unwrap();
        resume_egress_live();
        // A capability issued at the winning generation survives the barrier.
        let new_session = register_owner_session(&lease(), CancellationToken::new());

        let revoked = revoke_durable_capabilities_before(winning);
        assert_eq!(revoked, 2, "both old-generation capabilities revoked");
        assert!(
            old_session_cancel.is_cancelled(),
            "the old session's registered token was invoked"
        );
        assert_eq!(
            live_durable_capability_count(),
            1,
            "only the winning-generation capability remains"
        );
        assert!(
            new_session.admit_exercise().is_ok(),
            "the winning-generation session still transmits"
        );
        // old_session is now deregistered by the barrier; dropping it is a
        // no-op remove.
        drop(old_session);
    }

    // Registration-completeness assertion (Paul's condition b): every issued
    // durable capability is present in the registry with a revocation handle
    // the C5 barrier can invoke, and dropping the handle deregisters it so a
    // dead session/bearer is never a stale revocation target.
    #[test]
    fn issued_capabilities_are_registered_and_deregister_on_drop() {
        let _g = guard();
        assert_eq!(live_durable_capability_count(), 0);
        let session = register_owner_session(&lease(), CancellationToken::new());
        assert_eq!(live_durable_capability_count(), 1);
        let bearer = register_owner_bearer(&lease());
        assert_eq!(live_durable_capability_count(), 2);
        drop(session);
        assert_eq!(live_durable_capability_count(), 1, "session deregistered");
        drop(bearer);
        assert_eq!(live_durable_capability_count(), 0, "bearer deregistered");
    }

    // A no-transition control: with no generation bump, a registered
    // capability keeps transmitting and the barrier revokes nothing.
    #[test]
    fn no_transition_leaves_durable_capabilities_intact() {
        let _g = guard();
        let session = register_owner_session(&lease(), CancellationToken::new());
        let current = current_identity_persistence_generation();
        assert_eq!(
            revoke_durable_capabilities_before(current),
            0,
            "nothing older than the current generation to revoke"
        );
        assert!(
            session.admit_exercise().is_ok(),
            "with no transition the session still transmits"
        );
    }
}
