use super::*;

#[test]
fn restart_stamp_omits_shared_instructions_when_experiment_is_disabled() {
    let mut rec = record();
    rec.persona_id = Some("pers".into());
    let mut live = persona("pers", Some("goose"), "prompt");
    live.assigned_shared_instructions = vec![format!("30023:{}:kept", "b".repeat(64))];
    let personas = [live];
    let global = GlobalAgentConfig::default();
    let descriptor =
        crate::managed_agents::resolve_effective_harness_descriptor(&rec, &personas, &global)
            .unwrap();
    let effective = resolve_effective_config(&rec, &personas, &global)
        .require_resolved()
        .unwrap();
    let mut command = std::process::Command::new("buzz-acp");
    let assigned =
        crate::managed_agents::shared_instructions::resolve_and_apply_assigned_shared_instructions_env(
            &mut command,
            &rec,
            &personas,
            false,
        )
        .unwrap();
    let stamped = SpawnConfigSnapshot::from_inputs(SpawnConfigInputs {
        record: &rec,
        descriptor: &descriptor,
        relay_url: "wss://ws.example",
        team_instructions: None,
        system_prompt: effective.system_prompt.value.as_deref(),
        model: effective.model.value.as_deref(),
        provider: effective.provider.value.as_deref(),
        assigned_shared_instructions: assigned,
        enforced_owner_only: false,
    });
    let current = prospective_spawn_config_snapshot(
        &rec,
        &personas,
        &[],
        "wss://ws.example",
        &global,
        false,
        false,
    );

    assert!(stamped.assigned_shared_instructions.is_empty());
    assert_eq!(stamped.canonical(), current.canonical());
}

#[test]
fn restart_stamp_uses_live_shared_instructions_and_clears_diff() {
    let mut rec = record();
    rec.persona_id = Some("pers".into());
    rec.assigned_shared_instructions = vec![
        format!("30023:{}:kept", "b".repeat(64)),
        format!("30023:{}:revoked", "a".repeat(64)),
    ];
    let mut live = persona("pers", Some("goose"), "prompt");
    live.assigned_shared_instructions = vec![format!("30023:{}:kept", "b".repeat(64))];
    let personas = [live];
    let global = GlobalAgentConfig::default();
    let descriptor =
        crate::managed_agents::resolve_effective_harness_descriptor(&rec, &personas, &global)
            .unwrap();
    let effective = resolve_effective_config(&rec, &personas, &global)
        .require_resolved()
        .unwrap();
    let mut command = std::process::Command::new("buzz-acp");
    let assigned =
        crate::managed_agents::shared_instructions::resolve_and_apply_assigned_shared_instructions_env(
            &mut command,
            &rec,
            &personas,
            true,
        )
        .unwrap();
    let stamped = SpawnConfigSnapshot::from_inputs(SpawnConfigInputs {
        record: &rec,
        descriptor: &descriptor,
        relay_url: "wss://ws.example",
        team_instructions: None,
        system_prompt: effective.system_prompt.value.as_deref(),
        model: effective.model.value.as_deref(),
        provider: effective.provider.value.as_deref(),
        assigned_shared_instructions: assigned,
        enforced_owner_only: false,
    });
    let current = prospective_spawn_config_snapshot(
        &rec,
        &personas,
        &[],
        "wss://ws.example",
        &global,
        true,
        false,
    );

    assert_eq!(
        stamped.assigned_shared_instructions,
        personas[0].assigned_shared_instructions
    );
    assert_eq!(stamped.canonical(), current.canonical());
}
