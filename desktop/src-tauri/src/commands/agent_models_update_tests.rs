use super::*;

fn provider_record(deployed: bool) -> ManagedAgentRecord {
    let mut record: ManagedAgentRecord = serde_json::from_value(serde_json::json!({
        "pubkey": "agent", "name": "Agent", "relay_url": "", "acp_command": "",
        "agent_command": "", "agent_args": [], "mcp_command": "",
        "turn_timeout_seconds": 0, "system_prompt": null, "created_at": "",
        "updated_at": "", "last_started_at": null, "last_stopped_at": null,
        "last_exit_code": null, "last_error": null
    }))
    .unwrap();
    record.backend = crate::managed_agents::BackendKind::Provider {
        id: "provider".into(),
        config: serde_json::json!({}),
    };
    record.backend_agent_id = deployed.then(|| "deployment".to_string());
    record
}

#[test]
fn deployed_provider_rejects_access_edits_that_cannot_be_revoked() {
    let error = ensure_access_policy_change_supported(&provider_record(true), true)
        .expect_err("deployed provider access edit must fail closed");
    assert!(error.contains("no explicit stop or revocation acknowledgement"));
}

#[test]
fn undeployed_provider_accepts_access_edits() {
    ensure_access_policy_change_supported(&provider_record(false), true)
        .expect("no running provider deployment can retain stale access");
}

fn local_record() -> ManagedAgentRecord {
    serde_json::from_value(serde_json::json!({
        "pubkey": "local", "name": "Local Agent", "relay_url": "", "acp_command": "",
        "agent_command": "", "agent_args": [], "mcp_command": "",
        "turn_timeout_seconds": 0, "system_prompt": null, "created_at": "",
        "updated_at": "", "last_started_at": null, "last_stopped_at": null,
        "last_exit_code": null, "last_error": null
    }))
    .unwrap()
    // BackendKind deserializes as Local when the field is absent (the json! above).
}

#[test]
fn non_local_record_rejects_effort_set() {
    // A provider-backed record must not have its canonical effort column mutated
    // through update_managed_agent. Same contract as persist_agent_effort_level.
    let err =
        ensure_effort_change_supported(&provider_record(false), &Some(Some("high".to_string())))
            .expect_err("non-local record must reject effort writes");
    assert!(
        err.contains("remote effort is set at deploy time"),
        "error must explain why non-local effort writes are rejected: {err}"
    );
}

#[test]
fn non_local_record_rejects_effort_clear() {
    // Clear (None inner value) is also rejected for non-local records — the
    // outer Some signals presence; the inner None is the clear sentinel.
    let err = ensure_effort_change_supported(&provider_record(false), &Some(None))
        .expect_err("non-local record effort clear must also be rejected");
    assert!(err.contains("remote effort is set at deploy time"));
}

#[test]
fn local_record_accepts_effort_set() {
    ensure_effort_change_supported(&local_record(), &Some(Some("high".to_string())))
        .expect("local record must accept effort set");
}

#[test]
fn local_record_accepts_effort_clear() {
    ensure_effort_change_supported(&local_record(), &Some(None))
        .expect("local record must accept effort clear");
}

#[test]
fn absent_effort_always_passes_guard_for_any_backend() {
    // A missing effortLevel field (the common case) must never be rejected
    // regardless of backend — this is the don't-touch path.
    ensure_effort_change_supported(&local_record(), &None)
        .expect("absent effort must not trigger the non-local guard (local)");
    ensure_effort_change_supported(&provider_record(true), &None)
        .expect("absent effort must not trigger the non-local guard (provider)");
}
