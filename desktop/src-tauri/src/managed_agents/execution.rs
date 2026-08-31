//! Native transition seam for authenticated host commands. The relay receiver/UI
//! is deliberately not enabled yet. Only destination-local provisioned configs
//! are supported: no source workspace, environment, loopback endpoint or key copy.
use buzz_core_pkg::host_execution::{Action, Command, Outcome};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use super::{
    execution_ledger::{Begin, Entry, Ledger},
    *,
};

#[derive(Serialize)]
pub(crate) struct LocalExecutionConfig {
    pub runtime: String,
    pub revision: String,
}

pub(super) fn config_revision(
    record: &ManagedAgentRecord,
    personas: &[AgentDefinition],
    global: &GlobalAgentConfig,
    teams: &[TeamRecord],
    descriptor: &super::readiness::EffectiveHarnessDescriptor,
) -> Result<String, String> {
    // Hash in memory; never persist/return these secret-bearing input bytes.
    let bytes = serde_json::to_vec(&(
        env!("CARGO_PKG_VERSION"),
        record,
        personas,
        global,
        teams,
        &descriptor.command,
        &descriptor.args,
        &descriptor.env,
    ))
    .map_err(|_| "cannot fingerprint destination config")?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

pub(crate) fn local_execution_config(
    app: &AppHandle,
    record: &ManagedAgentRecord,
) -> Result<LocalExecutionConfig, String> {
    if record.backend != BackendKind::Local {
        return Err("destination agent is not locally provisioned".into());
    }
    let personas = load_personas(app)?;
    let teams = load_teams(app)?;
    let global = load_global_agent_config(app)?;
    let descriptor = resolve_effective_harness_descriptor(record, &personas, &global)?;
    let runtime = known_acp_runtime(&descriptor.command)
        .ok_or("destination runtime is not in the Rust catalog")?;
    let effective = effective_config::resolve_effective_config(record, &personas, &global)
        .require_resolved()?;
    // Destination-local mesh preflight needs its own readiness gate. Do not
    // mistake a source machine's loopback endpoint for a portable provider.
    if effective.relay_mesh_model_id().is_some() {
        return Err("host command mesh preflight is not supported yet".into());
    }
    if !matches!(
        agent_readiness(&resolve_effective_agent_env(
            record,
            &personas,
            Some(runtime),
            &global
        )),
        AgentReadiness::Ready
    ) {
        return Err("destination agent configuration is not ready".into());
    }
    Ok(LocalExecutionConfig {
        runtime: runtime.id.into(),
        revision: config_revision(record, &personas, &global, &teams, &descriptor)?,
    })
}

fn ledger(app: &AppHandle, key: &ManagedAgentRuntimeKey, owner: &str) -> Result<Ledger, String> {
    if !buzz_core_pkg::host_execution::hex_id(owner, 64) {
        return Err("invalid execution owner".into());
    }
    Ledger::open(
        &managed_agents_base_dir(app)?.join("execution-ledger"),
        &format!("{owner}__{}", key.runtime_id()),
    )
}

pub(super) fn legacy_spawn_guard(
    app: &AppHandle,
    record: &ManagedAgentRecord,
    relay: &str,
    owner: Option<&str>,
) -> Result<Ledger, String> {
    let owner = owner.ok_or("managed launch requires an owner")?;
    let key = ManagedAgentRuntimeKey::new(&record.pubkey, relay)?;
    let ledger = ledger(app, &key, owner)?;
    if ledger.is_fenced() {
        return Err(
            "placement is controlled by a durable execution operation; explicit Start required"
                .into(),
        );
    }
    Ok(ledger)
}

/// Called only after signature, live registration, destination and runtime
/// compatibility checks. Caller retains owner authority, never a host-only login.
pub(crate) fn execute_host_operation(
    app: &AppHandle,
    owner: &str,
    command_id: &str,
    request: &Command,
    compatible_runtime: bool,
) -> Result<Entry, String> {
    let state = app.state::<crate::app_state::AppState>();
    let _transition = state
        .managed_agent_runtime_transition
        .lock()
        .map_err(|_| "runtime transition lock unavailable")?;
    let _store = state
        .managed_agents_store_lock
        .lock()
        .map_err(|_| "agent store lock unavailable")?;
    if state
        .shutdown_started
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Err("desktop is shutting down".into());
    }
    crate::relay::assert_expected_signer(
        Some(owner),
        &state.signing_keys()?.public_key().to_hex(),
    )?;
    crate::relay::assert_expected_relay_scope(
        Some(&request.relay),
        &crate::relay::relay_api_base_url_with_override(&state),
    )?;
    if request.expires_at <= nostr::Timestamp::now().as_secs() {
        return Err("execution command expired".into());
    }
    let key = ManagedAgentRuntimeKey::new(&request.agent, &request.relay)?;
    let mut ledger = ledger(app, &key, owner)?;
    // Retry is resolved before inspecting current config/process state. Config
    // drift after success must not turn an ACK-loss retry into another launch.
    if let Some(entry) = ledger.replay(command_id, request)? {
        return Ok(entry);
    }
    let mut records = load_managed_agents(app)?;
    let record = find_managed_agent_mut(&mut records, &request.agent)?;
    let mut runtimes = state
        .managed_agent_processes
        .lock()
        .map_err(|_| "runtime lock unavailable")?;
    if let Action::Stop { run } = &request.action {
        // Validate before persisting a new Stop fence. A stale clicked run must
        // neither kill nor take ownership of a newer local placement.
        let selected = runtimes
            .get(&key)
            .ok_or("selected run is not tracked; stop outcome unknown")?;
        if !exact_generation_matches(&selected.start_nonce, run) {
            return Err("selected generation is no longer current".into());
        }
    }
    if let Begin::Replay(entry) = ledger.begin(command_id, request)? {
        return Ok(entry);
    }
    match &request.action {
        Action::Start { runtime, revision } => {
            // No adoption or teardown of a peer, even one whose root has exited.
            // A legacy receipt (including corrupt data) is an unresolved conflict.
            let receipt_path = managed_agents_base_dir(app)?
                .join("agent-pids")
                .join(format!("{}.json", key.runtime_id()));
            let preflight = local_execution_config(app, record);
            let compatible = preflight
                .is_ok_and(|config| config.runtime == *runtime && config.revision == *revision);
            if !compatible_runtime
                || !compatible
                || runtimes.contains_key(&key)
                || receipt_path
                    .try_exists()
                    .map_err(|_| "cannot inspect prior receipt")?
            {
                return ledger.finish(&request.operation, Outcome::Rejected);
            }
            let process = match super::runtime::spawn_agent_child_for_run(
                app,
                record,
                &key.relay_url,
                false,
                Some(owner),
                Some((&request.operation, revision)),
            ) {
                Ok(process) => process,
                Err(_) => return ledger.finish(&request.operation, Outcome::Rejected),
            };
            let now = crate::util::now_iso();
            let receipt = ManagedAgentRuntimeReceipt {
                key: key.clone(),
                pid: process.child.id(),
                desktop_instance_id: current_instance_id(app),
                started_at: now.clone(),
                run_id: Some(process.start_nonce.clone()),
            };
            if write_agent_runtime_receipt(app, &receipt).is_err() {
                // Preserve a possibly surviving child in memory, even if durable
                // observation failed. Never report definite failure after spawn.
                runtimes.insert(key, ManagedAgentPairRuntime::starting(process));
                return ledger.finish(&request.operation, Outcome::Unknown);
            }
            // Process observation only: not Ready, not online, not an LLM turn.
            record.updated_at = now.clone();
            record.last_started_at = Some(now);
            record.last_stopped_at = None;
            record.last_error = None;
            record.runtime_pid = None;
            runtimes.insert(key, ManagedAgentPairRuntime::starting(process));
            if save_managed_agents(app, &records).is_err() {
                return ledger.finish(&request.operation, Outcome::Unknown);
            }
            ledger.finish(&request.operation, Outcome::Spawned)
        }
        Action::Stop { run } => {
            let Some(runtime) = runtimes.get_mut(&key) else {
                // Absence, legacy PID receipts and presence expiry are not proof.
                return ledger.finish(&request.operation, Outcome::Unknown);
            };
            if !exact_generation_matches(&runtime.start_nonce, run) {
                // A delayed selected-run Stop must not kill this newer peer.
                return ledger.finish(&request.operation, Outcome::Unknown);
            }
            if super::runtime::terminate_exact_owned_group(&mut runtime.child).is_err() {
                return ledger.finish(&request.operation, Outcome::Unknown);
            }
            // ACP/agent/MCP children can own separate process groups. Root/group
            // exit is real evidence, but NOT a full execution teardown certificate.
            // Keep the placement fenced until stronger containment/reconciliation
            // can prove Stopped; no Move or replacement may use this observation.
            let result = ledger.finish(&request.operation, Outcome::RootExited)?;
            runtimes.remove(&key);
            remove_agent_runtime_receipt(app, &key);
            state.clear_agent_session_cache(&key);
            record.runtime_pid = None;
            record.updated_at = crate::util::now_iso();
            record.last_stopped_at = Some(record.updated_at.clone());
            save_managed_agents(app, &records)?;
            Ok(result)
        }
    }
}

fn exact_generation_matches(actual: &str, expected: &str) -> bool {
    buzz_core_pkg::host_execution::hex_id(expected, 32) && actual == expected
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stop_fences_successor_and_malformed_or_legacy_generation() {
        assert!(exact_generation_matches(&"aa".repeat(16), &"aa".repeat(16)));
        assert!(!exact_generation_matches(
            &"aa".repeat(16),
            &"bb".repeat(16)
        ));
        assert!(!exact_generation_matches("", ""));
        assert!(!exact_generation_matches("legacy", "legacy"));
    }
}
