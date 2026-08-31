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

// ── Mutation-effective seam tests (apply_effort_update) ──────────────────────
//
// These tests call `apply_effort_update`, the SAME function production calls
// inside `update_managed_agent`. They verify:
//   - non-local records are rejected AND the column is NOT mutated;
//   - local set writes to the column;
//   - local clear zeroes the column.
//
// Mutation proof for the guard: deleting `ensure_effort_change_supported` from
// `apply_effort_update` makes the reject tests pass `Ok(())` instead of `Err`,
// and the "record not mutated" assertions fail because the column is now set.
//
// Mutation proof for the apply call: deleting `apply_picker_effort_level` from
// `apply_effort_update` makes the local-set test find `effort_level == None`.

#[test]
fn non_local_set_is_rejected_and_record_not_mutated() {
    let mut record = provider_record(false);
    let err = apply_effort_update(&mut record, Some(Some("high".to_string())))
        .expect_err("non-local record must reject effort writes");
    assert!(
        err.contains("remote effort is set at deploy time"),
        "error must explain why non-local effort writes are rejected: {err}"
    );
    // Column must not be touched — the rejection is before mutation.
    assert_eq!(
        record.effort_level, None,
        "non-local record column must be unchanged after a rejected set"
    );
}

#[test]
fn non_local_clear_is_rejected_and_record_not_mutated() {
    // Clear (None inner value) is also rejected for non-local records — the
    // outer Some signals presence; the inner None is the clear sentinel.
    let mut record = provider_record(false);
    let err = apply_effort_update(&mut record, Some(None))
        .expect_err("non-local record effort clear must also be rejected");
    assert!(err.contains("remote effort is set at deploy time"));
    assert_eq!(
        record.effort_level, None,
        "non-local record column must be unchanged after a rejected clear"
    );
}

#[test]
fn local_set_writes_column_and_sweeps_stale_alias() {
    // `apply_effort_update` must write `effort_level` for a local record and
    // strip any stale record-scope effort alias (via `apply_picker_effort_level`).
    // Deleting the `apply_picker_effort_level` call inside `apply_effort_update`
    // leaves `effort_level == None` and this assertion fails.
    let mut record = local_record();
    record
        .env_vars
        .insert("GOOSE_THINKING_EFFORT".to_string(), "low".to_string());

    apply_effort_update(&mut record, Some(Some("high".to_string())))
        .expect("local record must accept effort set");

    assert_eq!(
        record.effort_level.as_deref(),
        Some("high"),
        "local set must write the canonical column"
    );
    assert!(
        !record.env_vars.contains_key("GOOSE_THINKING_EFFORT"),
        "local set must sweep the stale record-native alias"
    );
}

#[test]
fn local_clear_zeroes_column_and_sweeps_alias() {
    let mut record = local_record();
    record.effort_level = Some("high".to_string());
    record
        .env_vars
        .insert("GOOSE_THINKING_EFFORT".to_string(), "high".to_string());

    apply_effort_update(&mut record, Some(None)).expect("local record must accept effort clear");

    assert_eq!(
        record.effort_level, None,
        "local clear must zero the canonical column"
    );
    assert!(
        !record.env_vars.contains_key("GOOSE_THINKING_EFFORT"),
        "local clear must sweep the stale record-native alias"
    );
}

#[test]
fn absent_effort_is_noop_for_any_backend() {
    // A missing effortLevel field (the common case) must never be rejected and
    // must never touch the column — this is the don't-touch path.
    let mut local = local_record();
    apply_effort_update(&mut local, None).expect("absent effort must pass for local");
    assert_eq!(
        local.effort_level, None,
        "absent effort must not touch local column"
    );

    let mut provider = provider_record(true);
    apply_effort_update(&mut provider, None).expect("absent effort must pass for provider");
    assert_eq!(
        provider.effort_level, None,
        "absent effort must not touch provider column"
    );
}
