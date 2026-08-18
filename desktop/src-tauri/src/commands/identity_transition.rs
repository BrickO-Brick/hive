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
fn drain_managed_agent_runtimes_for_import(
    app: &tauri::AppHandle,
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
/// `commit_fence` + `validity_check` are threaded to the pre-commit boundary:
/// normal import supplies `None` + always-`Ok`; the phone-recovery continuation
/// supplies the pairing `generation_fence` + its generation-current check, so a
/// superseded recovery compensates the drain and commits NO identity while a
/// recovery that wins the fence commits durably (P26-C1).
pub(crate) async fn run_identity_transition(
    app_handle: tauri::AppHandle,
    nsec: String,
    password: Option<String>,
    commit_fence: Option<std::sync::Arc<std::sync::Mutex<()>>>,
    validity_check: impl FnOnce() -> Result<(), String> + Send + 'static,
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

    // ── Layer 1b: workspace_transition + Mesh preflight (UNCONDITIONAL) ──────
    // Always route through the transition lock, whether or not a scope appears
    // active — the active/no-scope decision is made INSIDE the blocking body
    // from a snapshot taken under this guard, so a concurrent apply_workspace
    // can neither slip a `None → Some` activation past the scope sample nor
    // race the durable commit (P26-C1). When the `mesh-llm` feature is enabled,
    // `with_workspace_transition_preflight` acquires `workspace_transition`,
    // runs `fail_if_client_mesh_active`, then invokes the body while the lock
    // remains held — the same orchestration path `apply_workspace` uses.
    // Without `mesh-llm`, acquire `workspace_transition` manually (no mesh
    // check needed) and invoke the blocking body under it.
    let app_for_body = app_handle.clone();

    #[cfg(feature = "mesh-llm")]
    let result = crate::commands::mesh_llm::scope_impl::with_workspace_transition_preflight(
        &app_handle,
        move || {
            Box::pin(async move {
                tokio::task::spawn_blocking(move || {
                    import_identity_blocking(
                        app_for_body,
                        nsec,
                        password,
                        commit_fence,
                        validity_check,
                    )
                })
                .await
                .map_err(|e| format!("spawn_blocking failed: {e}"))?
            })
        },
    )
    .await;

    #[cfg(not(feature = "mesh-llm"))]
    let result = {
        let _transition_guard = lock_state.workspace_transition.lock().await;
        tokio::task::spawn_blocking(move || {
            import_identity_blocking(app_for_body, nsec, password, commit_fence, validity_check)
        })
        .await
        .map_err(|e| format!("spawn_blocking failed: {e}"))?
    };

    // identity_mutation must outlive spawn_blocking — drop explicitly here so
    // the compiler can see the guard's lifetime covers both branches.
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
fn import_identity_blocking(
    app_handle: tauri::AppHandle,
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
                // Drain failed — drop the store lock BEFORE compensating
                // (compensate_drain re-acquires it), but pass the transition
                // guard into compensate_drain so there is no interleave window.
                drop(_store_guard);
                let comp_err = match (pre_import_scope.as_ref(), _rt_transition_guard) {
                    (Some(scope), Some(rt_guard)) => crate::managed_agents::compensate_drain(
                        &app_handle,
                        &stopped,
                        scope,
                        rt_guard,
                    ),
                    (_, leftover_guard) => {
                        drop(leftover_guard);
                        None
                    }
                };
                let msg = match comp_err {
                    Some(comp) => format!(
                        "identity import drain failed: {drain_err}; compensation failed: {comp}"
                    ),
                    None => format!("identity import drain failed: {drain_err}"),
                };
                return Err(msg);
            }
        }
    } else {
        vec![]
    };

    // ── Fenced pre-commit gate + durable commit (P25-C1 / P26-C1) ─────────
    // After a successful drain, immediately before the durable commit. The
    // commit fence (when supplied) is acquired FIRST, the validity check runs
    // under it, and the durable commit runs under the SAME held guard — so a
    // racing supersession can neither slip between the check and the commit nor
    // interleave with it. A failed check short-circuits and NEVER commits.
    let commit_result = commit_under_fence(commit_fence.as_deref(), validity_check, || {
        super::commit_imported_identity(&state, &data_dir, keys, |keys| {
            // Persist into the OS keyring first (store → read-back verify →
            // marker → delete file). Falls back to the 0o600 file when the
            // keyring is unavailable; returns Err only when both backends fail.
            let store =
                crate::secret_store::SecretStore::shared(crate::app_state::keyring_service());
            crate::app_state::persist_imported_identity(store, keys, &key_path, &data_dir)
        })
    });

    // If the fenced gate or the durable persist failed after a successful
    // drain, compensate the drained runtimes with NO durable identity write.
    // Drop the store lock BEFORE calling compensate_drain; pass the transition
    // guard into it so there is no interleave window.
    let (pubkey, storage) = match commit_result {
        Ok(result) => result,
        Err(e) => {
            if !stopped_entries.is_empty() {
                drop(_store_guard);
                let comp_err = match (pre_import_scope.as_ref(), _rt_transition_guard) {
                    (Some(scope), Some(rt_guard)) => crate::managed_agents::compensate_drain(
                        &app_handle,
                        &stopped_entries,
                        scope,
                        rt_guard,
                    ),
                    (_, leftover_guard) => {
                        drop(leftover_guard);
                        None
                    }
                };
                if let Some(comp_err) = comp_err {
                    eprintln!(
                        "buzz-desktop: identity import persist failed, compensation failed: {comp_err}"
                    );
                }
            }
            return Err(e);
        }
    };

    // ── Clear active scope and bump generation ────────────────────────────
    // For no-active-scope path: no scope was ever set; clearing is a no-op
    // but bumping generation invalidates any in-flight stale operations.
    // For live-active path: agents are stopped; clearing scope makes all
    // agent commands fail closed until the frontend re-applies a workspace.
    //
    // Invariant: the fallback relay can never claim legacy data — claims
    // are only written inside apply_workspace's prepare stage.
    //
    // `clear_active_scope()` internally calls `next_scope_generation()` —
    // no additional bump is needed here.
    state.clear_active_scope();

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
