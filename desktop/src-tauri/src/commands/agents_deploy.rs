//! Provider deploy payload construction, split from `agents.rs` (file-size
//! guard). The launch block is derived from the same effective descriptor and
//! policy helpers as local spawn so remote execution does not reimplement them.

use std::collections::BTreeMap;

use tauri::AppHandle;

use crate::managed_agents::AgentDefinition;
use crate::{
    app_state::AppState,
    managed_agents::{load_personas, ManagedAgentRecord},
    relay::relay_ws_url_with_override,
};

/// Effective projection fields for the deploy payload — all derived from the
/// resolved descriptor and effective config so that the serialised payload and
/// the `launch` block are always internally consistent.
pub(super) struct DeployProjections {
    pub effective_model: Option<String>,
    pub effective_provider: Option<String>,
    pub effective_prompt: Option<String>,
    /// Effective parallelism derived from the same resolved `descriptor.command`
    /// as `launch.policy_env["BUZZ_ACP_AGENTS"]`.
    pub effective_parallelism: u32,
    /// Access fields projected from the same build policy that gates local starts.
    pub owner_only_access: bool,
}

/// Resolve the deploy-specific structured model/provider for a managed agent.
#[cfg(test)]
pub(crate) fn resolve_deploy_model_provider(
    record: &ManagedAgentRecord,
    personas: &[AgentDefinition],
    global: &crate::managed_agents::GlobalAgentConfig,
) -> (Option<String>, Option<String>) {
    crate::managed_agents::effective_config::resolve_effective_model_provider_pair(
        record, personas, global,
    )
    .unwrap_or((None, None))
}

pub(super) struct LaunchExperimentContext<'a> {
    pub effective_model: Option<&'a str>,
    pub shared_instructions_enabled: bool,
}

/// Resolve assignments and serialize the portable launch contract used by production deploys.
pub(super) fn build_launch_block(
    record: &ManagedAgentRecord,
    descriptor: &crate::managed_agents::readiness::EffectiveHarnessDescriptor,
    teams: &[crate::managed_agents::TeamRecord],
    personas: &[AgentDefinition],
    effective_prompt: Option<&str>,
    experiment: LaunchExperimentContext<'_>,
    owner_pubkey: &str,
) -> Result<serde_json::Value, String> {
    let assigned_shared_instructions: &[String] = if experiment.shared_instructions_enabled {
        crate::managed_agents::effective_config::resolve_effective_assigned_shared_instructions(
            record, personas,
        )?
    } else {
        &[]
    };
    Ok(serialize_launch_block(
        record,
        descriptor,
        teams,
        effective_prompt,
        experiment.effective_model,
        assigned_shared_instructions,
        owner_pubkey,
    ))
}

fn serialize_launch_block(
    record: &ManagedAgentRecord,
    descriptor: &crate::managed_agents::readiness::EffectiveHarnessDescriptor,
    teams: &[crate::managed_agents::TeamRecord],
    effective_prompt: Option<&str>,
    effective_model: Option<&str>,
    assigned_shared_instructions: &[String],
    owner_pubkey: &str,
) -> serde_json::Value {
    use crate::managed_agents::{
        known_acp_runtime, resolve_session_title, DISPLAY_NAME_ENV_VAR, SESSION_TITLE_ENV_VAR,
    };

    let runtime = known_acp_runtime(&descriptor.command);
    let mut policy_env = BTreeMap::new();

    if let Some(runtime) = runtime {
        policy_env.extend(
            runtime
                .default_env
                .iter()
                .map(|(key, value)| ((*key).to_string(), (*value).to_string())),
        );
        if runtime.mcp_hooks {
            policy_env.insert("MCP_HOOK_SERVERS".into(), "*".into());
        }
    }
    policy_env.insert("BUZZ_ACP_RELAY_OBSERVER".into(), "true".into());
    policy_env.insert("BUZZ_ACP_LAZY_POOL".into(), "true".into());
    policy_env.insert(
        "BUZZ_ACP_AGENTS".into(),
        crate::managed_agents::acp_agents_value(&descriptor.command, record.parallelism),
    );

    if let Some(value) = effective_prompt {
        policy_env.insert("BUZZ_ACP_SYSTEM_PROMPT".into(), value.to_string());
    }
    if let Some(value) = effective_model {
        // B2: remote env-authority model key. Claude's startup model authority
        // is ANTHROPIC_MODEL (same as the local A1 path — the harness reads it
        // first and skips the BUZZ_ACP_MODEL catalog-switch path that would
        // introduce a second startup authority). All other runtimes use
        // BUZZ_ACP_MODEL, which the harness reads into desired_model at spawn.
        let is_claude = runtime.map(|r| r.id == "claude").unwrap_or(false);
        let model_key = if is_claude {
            "ANTHROPIC_MODEL"
        } else {
            "BUZZ_ACP_MODEL"
        };
        policy_env.insert(model_key.into(), value.to_string());
    }
    // I-4: remote parity for persisted startup effort. Mirrors the local spawn
    // path in runtime.rs. The harness reads BUZZ_ACP_EFFORT_LEVEL into
    // PoolStartup.startup_effort and applies it at first session creation via
    // resolve_startup_effort().
    if let Some(ref value) = record.effort_level {
        policy_env.insert("BUZZ_ACP_EFFORT_LEVEL".into(), value.clone());
    }
    if let Some(value) = record.idle_timeout_seconds {
        policy_env.insert("BUZZ_ACP_IDLE_TIMEOUT".into(), value.to_string());
    }
    if let Some(value) = record.max_turn_duration_seconds {
        policy_env.insert("BUZZ_ACP_MAX_TURN_DURATION".into(), value.to_string());
    }
    if let Some(value) = resolve_session_title(record.display_name.as_deref(), &record.name) {
        policy_env.insert(SESSION_TITLE_ENV_VAR.into(), value.clone());
        policy_env.insert(DISPLAY_NAME_ENV_VAR.into(), value);
    }
    if let Some(value) =
        crate::managed_agents::spawn_snapshot::effective_team_instructions(record, teams)
    {
        policy_env.insert("BUZZ_ACP_TEAM_INSTRUCTIONS".into(), value);
    }
    if !assigned_shared_instructions.is_empty() {
        policy_env.insert(
            "BUZZ_ACP_ASSIGNED_SHARED_INSTRUCTIONS".into(),
            assigned_shared_instructions.join(","),
        );
    }

    // B5 remote parity: when a canonical effort_level is persisted, strip
    // BUZZ_ACP_EFFORT_LEVEL from launch.env so it cannot shadow the canonical
    // value in policy_env (tier 1). In the k8s three-tier model tier 2
    // (launch.env) overwrites tier 1 (policy_env) — later-wins — so the key
    // must be absent from tier 2 whenever a canonical value is present.
    // When effort_level is None there is no canonical to protect, so user
    // env passthrough stands (env may legitimately seed startup effort).
    //
    // B2 remote parity: mirror the local A1 model authority. For a Claude
    // launch, ALWAYS strip BOTH BUZZ_ACP_MODEL and ANTHROPIC_MODEL from
    // launch.env — the resolved canonical model rides policy_env.ANTHROPIC_MODEL
    // alone (set above), and launch.env later-wins over policy_env. Left in
    // launch.env, a user BUZZ_ACP_MODEL would introduce a second startup
    // authority and a user ANTHROPIC_MODEL would silently override the
    // canonical model. When no canonical model is present, neither key is in
    // policy_env, so stripping them keeps the remote process free of both —
    // matching local, where `apply_claude_model_env(None)` removes both.
    let is_claude = runtime.map(|r| r.id == "claude").unwrap_or(false);
    let strip_key = |k: &str| {
        k.eq_ignore_ascii_case("BUZZ_ACP_ASSIGNED_SHARED_INSTRUCTIONS")
            || (record.effort_level.is_some() && k.eq_ignore_ascii_case("BUZZ_ACP_EFFORT_LEVEL"))
            || (is_claude
                && (k.eq_ignore_ascii_case("BUZZ_ACP_MODEL")
                    || k.eq_ignore_ascii_case("ANTHROPIC_MODEL")))
    };
    let launch_env: BTreeMap<String, String> = descriptor
        .env
        .iter()
        .filter(|(k, _)| !strip_key(k))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    serde_json::json!({
        "command": descriptor.command,
        "args": descriptor.args,
        "env": launch_env,
        "policy_env": policy_env,
        "owner_pubkey": owner_pubkey,
    })
}

pub(super) fn ensure_remote_provider_supported(provider: Option<&str>) -> Result<(), String> {
    if provider.map(str::trim) == Some(crate::managed_agents::RELAY_MESH_PROVIDER_ID) {
        return Err(
            "shared-compute agents cannot be deployed remotely because the mesh endpoint is local to the desktop"
                .to_string(),
        );
    }
    Ok(())
}

/// Build the standard agent JSON payload for provider deploy calls.
pub(crate) fn build_deploy_payload(
    app: &AppHandle,
    state: &AppState,
    record: &ManagedAgentRecord,
) -> Result<serde_json::Value, String> {
    if let Some(err) = crate::managed_agents::spawn_key_refusal(record) {
        return Err(err);
    }

    let global = crate::managed_agents::load_global_agent_config(app).unwrap_or_default();
    let personas = load_personas(app).unwrap_or_default();
    let teams = crate::managed_agents::load_teams(app).unwrap_or_default();
    let persona_env =
        crate::managed_agents::live_persona_env(&personas, record.persona_id.as_deref());
    let global_persona_env = crate::managed_agents::merged_user_env(&global.env_vars, &persona_env);
    let merged_user_env =
        crate::managed_agents::merged_user_env(&global_persona_env, &record.env_vars);
    let effective = crate::managed_agents::effective_config::resolve_effective_config(
        record, &personas, &global,
    )
    .require_resolved()?;

    ensure_remote_provider_supported(effective.provider.value.as_deref())?;

    let descriptor =
        crate::managed_agents::resolve_effective_harness_descriptor(record, &personas, &global)
            .map_err(|error| crate::managed_agents::user_facing_harness_error(&error))?;
    let owner_pubkey = super::workspace_owner_hex(state)?;
    let launch = build_launch_block(
        record,
        &descriptor,
        &teams,
        &personas,
        effective.system_prompt.value.as_deref(),
        LaunchExperimentContext {
            effective_model: effective.model.value.as_deref(),
            shared_instructions_enabled: state
                .shared_instructions_enabled
                .load(std::sync::atomic::Ordering::Relaxed),
        },
        &owner_pubkey,
    )?;

    let effective_parallelism =
        crate::managed_agents::effective_parallelism(&descriptor.command, record.parallelism);

    Ok(deploy_payload_json(
        record,
        crate::relay::effective_agent_relay_url(
            &record.relay_url,
            &relay_ws_url_with_override(state),
        ),
        DeployProjections {
            effective_model: effective.model.value,
            effective_provider: effective.provider.value,
            effective_prompt: effective.system_prompt.value,
            effective_parallelism,
            owner_only_access: crate::managed_agents::owner_only_access_build(),
        },
        merged_user_env,
        launch,
    ))
}

/// Pure serialization half of [`build_deploy_payload`]. Legacy top-level fields
/// remain for display/bookkeeping; providers execute the resolved `launch` block.
/// `projections.effective_parallelism` is pre-computed from the same resolved
/// descriptor as `launch.policy_env["BUZZ_ACP_AGENTS"]`. Access is projected from
/// the same compiled policy that gates local starts.
pub(super) fn deploy_payload_json(
    record: &ManagedAgentRecord,
    relay_url: String,
    projections: DeployProjections,
    merged_env: BTreeMap<String, String>,
    launch: serde_json::Value,
) -> serde_json::Value {
    let (respond_to, respond_to_allowlist) =
        crate::managed_agents::projected_access_with_policy(record, projections.owner_only_access);
    serde_json::json!({
        "name": &record.name,
        "relay_url": relay_url,
        "private_key_nsec": &record.private_key_nsec,
        "auth_tag": &record.auth_tag,
        "agent_command": &record.agent_command,
        "agent_args": &record.agent_args,
        "system_prompt": projections.effective_prompt,
        "model": projections.effective_model,
        "provider": projections.effective_provider,
        "turn_timeout_seconds": record.turn_timeout_seconds,
        "idle_timeout_seconds": record.idle_timeout_seconds,
        "max_turn_duration_seconds": record.max_turn_duration_seconds,
        // Legacy top-level field: projected from the same resolved descriptor as
        // launch.policy_env["BUZZ_ACP_AGENTS"] — the two are always consistent.
        "parallelism": projections.effective_parallelism,
        "respond_to": respond_to,
        "respond_to_allowlist": respond_to_allowlist,
        "env_vars": merged_env,
        "launch": launch,
    })
}

#[cfg(test)]
#[path = "agents/agents_deploy_tests.rs"]
mod tests;
