//! Identity-transition coordinator (P25-C1): the shared sink both runtime
//! identity-swap callers (normal import and phone recovery) route through, split
//! from `identity.rs` (file-size guard). Owns lock-ordering, the journaled
//! managed-agent runtime drain, the fenced pre-commit gate, and scope clear.

use crate::app_state::AppState;
use crate::models::IdentityInfo;
use tauri::Manager;

/// Drain live managed-agent runtimes for identity import (Layer 2 protocol).
/// Caller must hold `managed_agent_runtime_transition`. Returns stopped entries
/// or `Err((stopped, msg))` on failure.
fn drain_managed_agent_runtimes_for_import<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AppState,
) -> Result<
    Vec<crate::managed_agents::DrainJournalEntry>,
    (Vec<crate::managed_agents::DrainJournalEntry>, String),
> {
    let (stopped, _remaining, drain_error) =
        crate::managed_agents::drain_scope_runtimes(app, state);
    match drain_error {
        None => Ok(stopped),
        Some(e) => Err((stopped, e)),
    }
}

/// Compensate a drained runtime set with NO durable identity write — the shared
/// unwind for every barrier abort (drain failure, fenced-gate/journal failure,
/// `DefinitelyUnchanged`). The store guard is dropped FIRST because
/// [`compensate_drain`](crate::managed_agents::compensate_drain) re-acquires it,
/// and the runtime-transition guard is passed BY VALUE so compensation runs
/// without any interleave window. `scope`/`rt_guard` are `None` on the no-scope
/// path (nothing drained); either being `None` skips compensation. Returns a
/// combined diagnostic string when compensation itself fails.
fn compensate_import_drain<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    stopped: &[crate::managed_agents::DrainJournalEntry],
    scope: Option<&crate::managed_agents::scope::WorkspaceAgentScope>,
    rt_guard: Option<std::sync::MutexGuard<'_, ()>>,
    store_guard: Option<std::sync::MutexGuard<'_, ()>>,
    reason: &str,
) -> String {
    // Drop the store lock before compensating (compensate_drain re-acquires it).
    drop(store_guard);
    let comp_err = match (scope, rt_guard) {
        (Some(scope), Some(rt_guard)) => {
            crate::managed_agents::compensate_drain(app_handle, stopped, scope, rt_guard)
        }
        (_, leftover_guard) => {
            drop(leftover_guard);
            None
        }
    };
    match comp_err {
        Some(comp) => format!("{reason}; compensation failed: {comp}"),
        None => reason.to_string(),
    }
}

/// The shared identity-transition coordinator (P25-C1): the ONE sink both
/// runtime identity-swap callers route through. Acquires the transition locks
/// in ONE unconditional order — `identity_mutation` → `workspace_transition`
/// (ALWAYS, incl. Mesh preflight when the feature is active) — then runs the
/// journaled drain + fenced commit in [`import_identity_blocking`], which
/// decides the active/no-scope branch ONLY from a scope snapshot taken UNDER
/// the held transition guard (P26-C1). Taking `workspace_transition` even on
/// the no-scope path closes the `None → Some` activation race: a concurrent
/// `apply_workspace` cannot commit a new active scope between this
/// coordinator's scope sample and its durable commit, because both serialize
/// on `workspace_transition`. No deadlock: `apply_workspace` takes only
/// `workspace_transition` (never `identity_mutation`), so the global order
/// `identity_mutation` → `workspace_transition` has no cycle.
///
/// `commit_fence` + `late_validity_check` are threaded to the pre-commit
/// boundary: normal import supplies `None` + always-`Ok`; the phone-recovery
/// continuation supplies the pairing `generation_fence` + its generation-current
/// check, so a superseded recovery compensates the drain and commits NO identity
/// while a recovery that wins the fence commits durably (P26-C1).
///
/// # Two validity boundaries (P26-C1)
///
/// The transition is gated at TWO points, each closing a distinct supersession
/// window; a single check cannot cover both because they straddle the drain:
///
/// - **`early_validity_check`** runs under the held `workspace_transition`
///   guard, immediately after the locks are acquired and BEFORE the Mesh
///   preflight and drain. Its job is to reject a task that was already
///   superseded/cancelled while it queued on the locks, doing ZERO disruptive
///   work — no drain, no Mesh state change, no egress-barrier bump, nothing to
///   compensate. Normal import supplies always-`Ok`; pairing supplies the
///   task-currency check.
/// - **`late_validity_check`** runs inside [`import_identity_blocking`] at the
///   fence-held pre-commit boundary — after a successful drain, immediately
///   before the durable dispatch — so a supersession that lands during the
///   drain window is caught before any identity is committed (the drained
///   runtimes are then compensated). This is the boundary the `commit_fence`
///   makes indivisible against a racing invalidation.
///
/// A cancellation that lands AFTER the early gate but DURING the drain reaches
/// the runtime revoke before `late_validity_check` rejects it; the drained
/// runtimes compensate, but revoked owner-identity durable capabilities stay
/// revoked. This is design-conformant fail-closed churn, not a split state —
/// see `CROSS_WORKSPACE_AGENT_LIBRARY.md` §3.3a (barrier sequence is fixed).
pub(crate) async fn run_identity_transition<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    nsec: String,
    password: Option<String>,
    commit_fence: Option<std::sync::Arc<std::sync::Mutex<()>>>,
    early_validity_check: impl FnOnce() -> Result<(), String>,
    late_validity_check: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<IdentityInfo, String> {
    // ── Layer 1: identity_mutation (async serialization lock) ────────────────
    // Held for the full import to prevent a concurrent stale persist from
    // overwriting the imported key. Lock order: identity_mutation →
    // workspace_transition (UNCONDITIONALLY — P26-C1).
    //
    // Use a cloned handle for lock acquisition so the original `app_handle` is
    // free for the spawned blocking body below (no borrow conflict).
    let lock_handle = app_handle.clone();
    let lock_state = lock_handle.state::<AppState>();
    let _mutation_guard = lock_state.identity_mutation.lock().await;

    // ── Layer 1b: workspace_transition (UNCONDITIONAL) ───────────────────────
    // Always route through the transition lock, whether or not a scope appears
    // active — the active/no-scope decision is made INSIDE the blocking body
    // from a snapshot taken under this guard, so a concurrent apply_workspace
    // can neither slip a `None → Some` activation past the scope sample nor
    // race the durable commit (P26-C1).
    let _transition_guard = lock_state.workspace_transition.lock().await;

    // ── Early validity gate (P26-C1) ─────────────────────────────────────────
    // Under the held transition guard, BEFORE the Mesh preflight and drain: a
    // task superseded while queued on the locks is rejected here having done
    // ZERO disruptive work (no drain, no Mesh, no egress-barrier change).
    early_validity_check()?;

    // ── Mesh preflight (UNCONDITIONAL, no-op without `mesh-llm`) ──────────────
    // Fail closed if a client-mode Mesh runtime is active. Runs under the held
    // `workspace_transition` guard — the same orchestration invariant
    // `apply_workspace` relies on.
    #[cfg(feature = "mesh-llm")]
    crate::commands::mesh_llm::scope_impl::run_mesh_transition_preflight(&app_handle).await?;

    let app_for_body = app_handle.clone();
    let result = tokio::task::spawn_blocking(move || {
        import_identity_blocking(
            app_for_body,
            nsec,
            password,
            commit_fence,
            late_validity_check,
        )
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?;

    // Both transition guards must outlive spawn_blocking — drop explicitly here
    // so the compiler can see their lifetimes cover the blocking body.
    drop(_transition_guard);
    drop(_mutation_guard);

    result
}

/// Run `commit` under the transition commit fence, gated on `validity_check`.
///
/// When `fence` is supplied it is locked FIRST and held for the whole call, so
/// the validity check and the durable commit are indivisible against a racing
/// supersession that must take the same fence to invalidate the transition
/// (P26-C1). The check runs under the held fence; on `Err` it short-circuits
/// and `commit` is NEVER run. This is the single fence-guarded commit primitive
/// shared by the identity-transition coordinator and its supersession tests.
pub(crate) fn commit_under_fence<T>(
    fence: Option<&std::sync::Mutex<()>>,
    validity_check: impl FnOnce() -> Result<(), String>,
    commit: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _fence = match fence.map(|m| m.lock()) {
        Some(Ok(guard)) => Some(guard),
        Some(Err(e)) => return Err(format!("identity transition fence poisoned: {e}")),
        None => None,
    };
    validity_check()?;
    commit()
}

/// Blocking body of [`import_identity`]: key recovery, journaled drain (when a
/// scope is active), identity commit, and scope clear.  The caller has ALWAYS
/// acquired `workspace_transition` before invoking this (P26-C1); the
/// active/no-scope branch is decided here from a scope snapshot taken under
/// that held guard.
///
/// `validity_check` runs at the pre-commit boundary — after a successful drain,
/// immediately before the durable identity commit — while `commit_fence` (when
/// supplied) is held. When it returns `Err`, the drained runtimes are
/// compensated and NO identity is committed. `commit_fence` is held ALIVE
/// across the durable commit (P26-C1): for the phone-recovery caller this is
/// the pairing `generation_fence`, so a supersession that races the commit
/// either compensates (cancelled during drain, before the fence is taken) or
/// loses to the committed recovery (cancelled after the fenced commit begins).
/// Normal import supplies `None` + an always-`Ok(())` check.
fn import_identity_blocking<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    nsec: String,
    password: Option<String>,
    commit_fence: Option<std::sync::Arc<std::sync::Mutex<()>>>,
    validity_check: impl FnOnce() -> Result<(), String>,
) -> Result<IdentityInfo, String> {
    // NIP-49 backups require a passphrase and decrypt entirely in Rust.
    // Raw nsec/hex input follows the existing parser path unchanged.
    let password = password.map(zeroize::Zeroizing::new);
    let keys = crate::key_backup::recover_keys_from_input(
        &nsec,
        password.as_ref().map(|value| value.as_str()),
    )?;

    let state = app_handle.state::<AppState>();

    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("create app data dir: {e}"))?;
    let key_path = data_dir.join("identity.key");

    // ── Live-active path: journaled drain before swapping identity ─────────
    // Drain all managed-agent runtimes under `managed_agent_runtime_transition`
    // (Layer 2) BEFORE persisting the new identity — same protocol as
    // `apply_workspace`.  The store lock is held through drain/save; on drain
    // failure the transition guard is passed into compensate_drain so
    // compensation runs without any interleave window.
    //
    // The active/no-scope branch is decided HERE, from a scope snapshot taken
    // UNDER the `workspace_transition` guard the caller holds unconditionally
    // (P26-C1). Sampling under the held guard is what closes the `None → Some`
    // activation race: a concurrent `apply_workspace` cannot commit a new
    // active scope between this sample and the durable identity commit, because
    // both serialize on `workspace_transition`.
    let pre_import_scope = state.capture_active_scope();
    let has_active_scope = pre_import_scope.is_some();

    // The identity active before this transition (A), captured for the P28-C1
    // journal BEFORE any swap. `to_pubkey` is the imported identity (B).
    let from_pubkey = state
        .identity_lifecycle_keys_guard()
        .map_err(|e| format!("read current identity for transition journal: {e}"))?
        .public_key()
        .to_hex();
    let to_pubkey = keys.public_key().to_hex();

    let _rt_transition_guard = if has_active_scope {
        Some(
            state
                .managed_agent_runtime_transition
                .lock()
                .map_err(|e| format!("managed_agent_runtime_transition poisoned: {e}"))?,
        )
    } else {
        None
    };

    let _store_guard = if has_active_scope {
        Some(
            state
                .managed_agents_store_lock
                .lock()
                .map_err(|e| format!("managed_agents_store_lock poisoned: {e}"))?,
        )
    } else {
        None
    };

    let stopped_entries = if has_active_scope {
        match drain_managed_agent_runtimes_for_import(&app_handle, &state) {
            Ok(stopped) => stopped,
            Err((stopped, drain_err)) => {
                let msg = compensate_import_drain(
                    &app_handle,
                    &stopped,
                    pre_import_scope.as_ref(),
                    _rt_transition_guard,
                    _store_guard,
                    &format!("identity import drain failed: {drain_err}"),
                );
                return Err(msg);
            }
        }
    } else {
        vec![]
    };

    // ── Owner-identity egress barrier (P29/P30-C1) ────────────────────────
    // Between the runtime drain and the durable dispatch, drain owner-identity
    // egress: bump the identity-persistence generation, refuse new lease
    // admission, await in-flight leases, and revoke old-generation durable
    // capabilities (sessions/bearers). Both Layer-2 guards remain held
    // continuously across this barrier — releasing either permits A-runtime
    // resurrection before B commits (Thufir UNSAFE verdict on the three-phase
    // split, Paul-ruled `092acdeb75`). The wait is synchronous
    // (`wait_egress_drain_blocking`) because this body holds two std mutex
    // guards that cannot cross `.await`; deadlock-freedom rests on leases
    // taking only the egress registry mutex (zero lease-vs-guard sites).
    //
    // The barrier runs UNCONDITIONALLY, even on the no-scope path: owner sends
    // are scope-independent, so an in-flight owner lease can exist with no
    // active agent scope.
    let winning_generation = crate::owner_identity_egress::begin_egress_drain()?;
    crate::owner_identity_egress::wait_egress_drain_blocking();
    crate::owner_identity_egress::revoke_durable_capabilities_before(winning_generation);

    // ── Fenced pre-commit gate → journal → classified durable persist ─────
    // The commit fence (when supplied) is acquired FIRST and held across the
    // journal write AND the durable persist (P26-C1 fence retention): a racing
    // supersession that must take the same fence can neither slip between the
    // check and the durable dispatch nor interleave with it. The P28-C1 journal
    // is written ONLY after the validity gate passes, so a superseded recovery
    // leaves no journal residue. The persist is CLASSIFIED against durable fact
    // (P27-C1) — never the kernel's `Ok`/`Err`.
    let store = crate::secret_store::SecretStore::shared(crate::app_state::keyring_service());
    let pending = crate::identity_transition_journal::IdentityTransitionPending {
        from_pubkey,
        to_pubkey,
    };
    let barrier_result = commit_under_fence(commit_fence.as_deref(), validity_check, || {
        crate::identity_transition_journal::write_pending(&data_dir, &pending)?;
        Ok(
            crate::identity_persistence::persist_imported_identity_classified(
                &keys,
                store,
                &key_path,
                || crate::app_state::persist_imported_identity(store, &keys, &key_path, &data_dir),
            ),
        )
    });

    use crate::identity_persistence::PersistenceOutcome;
    let (pubkey, storage) = match barrier_result {
        // Validity gate or journal write failed BEFORE any durable B persist:
        // reopen admission, compensate the drained runtimes, no durable write.
        Err(e) => {
            crate::owner_identity_egress::resume_egress_live();
            let msg = compensate_import_drain(
                &app_handle,
                &stopped_entries,
                pre_import_scope.as_ref(),
                _rt_transition_guard,
                _store_guard,
                &e,
            );
            return Err(msg);
        }
        // Durable B proven canonical: finish the in-memory swap through the
        // already-held guards (no fallible acquisition after durability,
        // P26-C2), clear the journal, and reopen admission at generation B.
        Ok(PersistenceOutcome::Committed(storage)) => {
            let committed = super::commit_imported_identity(&state, &data_dir, keys, storage);
            match committed {
                Ok(committed) => committed,
                // The in-memory swap itself failed after durable B landed —
                // a poisoned `state.keys` guard. B IS durable, so this is NOT
                // compensatable: latch fail-closed and leave the journal for
                // boot reconciliation rather than restoring live A beside B.
                Err(e) => {
                    crate::owner_identity_egress::latch_identity_indeterminate();
                    return Err(format!(
                        "identity B durably committed but the in-memory swap failed: {e}; \
                         latched indeterminate — relaunch to reconcile from durable fact"
                    ));
                }
            }
        }
        // B never landed, A intact: the only outcome permitted to compensate.
        Ok(PersistenceOutcome::DefinitelyUnchanged) => {
            let _ = crate::identity_transition_journal::clear_pending(&data_dir);
            crate::owner_identity_egress::resume_egress_live();
            let msg = compensate_import_drain(
                &app_handle,
                &stopped_entries,
                pre_import_scope.as_ref(),
                _rt_transition_guard,
                _store_guard,
                "identity import persist failed and durable A is still canonical",
            );
            return Err(msg);
        }
        // Neither identity provable: latch the durable fail-closed state, LEAVE
        // the journal, do NOT compensate or clear scope — runtimes stay down.
        // Boot/reconciliation resolves it later from durable fact (P28-C1).
        Ok(PersistenceOutcome::Indeterminate(reason)) => {
            crate::owner_identity_egress::latch_identity_indeterminate();
            return Err(format!(
                "identity import could not prove either identity canonical: {reason}; \
                 latched indeterminate — relaunch to reconcile"
            ));
        }
    };

    // ── Proven Committed: clear journal, scope, reopen admission ──────────
    // The journal is cleared only here, at the proven `Committed` exit after
    // the in-memory swap completed (best-effort — a proven-canonical identity
    // must never be blocked by a stale delete). `clear_active_scope()` bumps
    // the scope generation, making all agent commands fail closed until the
    // frontend re-applies a workspace. `resume_egress_live()` reopens egress at
    // generation B. The fallback relay can never claim legacy data — claims are
    // only written inside apply_workspace's prepare stage.
    if let Err(e) = crate::identity_transition_journal::clear_pending(&data_dir) {
        eprintln!("buzz-desktop: identity committed, but journal clear failed: {e}");
    }
    state.clear_active_scope();
    crate::owner_identity_egress::resume_egress_live();

    let pubkey_hex = pubkey.to_hex();
    let display_name = super::truncated_display_name(&pubkey)?;

    eprintln!("buzz-desktop: imported identity pubkey {}", pubkey_hex);

    Ok(IdentityInfo {
        pubkey: pubkey_hex,
        display_name,
        storage: storage.as_str().to_string(),
        lost: false,
        locked: false,
        reset_failed: false,
    })
}
