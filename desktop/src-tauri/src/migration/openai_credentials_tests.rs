use super::*;
fn custom_gateway_harnesses() -> std::collections::HashMap<String, Map<String, Value>> {
    std::collections::HashMap::from([(
        "custom-gateway".to_string(),
        serde_json::json!({
            "OPENAI_COMPAT_BASE_URL": "https://gateway.example/v1"
        })
        .as_object()
        .unwrap()
        .clone(),
    )])
}

fn migrate_file(
    path: &Path,
    effective_provider: Option<&str>,
    inherited_env_vars: Option<&Map<String, Value>>,
) -> Result<(), String> {
    migrate_openai_credentials_in_file(
        path,
        effective_provider,
        inherited_env_vars,
        &std::collections::HashMap::new(),
    )
}

fn migrate(value: Value) -> (Value, bool) {
    let mut record = value.as_object().unwrap().clone();
    let changed = migrate_openai_credential_record(&mut record, None, None, true).unwrap();
    (Value::Object(record), changed)
}

#[test]
fn official_openai_renames_the_legacy_credential_and_removes_routing_state() {
    let (record, changed) = migrate(serde_json::json!({
        "provider": "openai",
        "env_vars": {
            "OPENAI_COMPAT_API_KEY": "official-secret",
            "OPENAI_COMPAT_BASE_URL": "https://api.openai.com/v1",
            "KEEP": "value"
        }
    }));

    assert!(changed);
    assert_eq!(record["env_vars"][OPENAI_API_KEY], "official-secret");
    assert!(record["env_vars"].get(OPENAI_COMPAT_API_KEY).is_none());
    assert!(record["env_vars"].get(OPENAI_COMPAT_BASE_URL).is_none());
    assert_eq!(record["env_vars"]["KEEP"], "value");
}

#[test]
fn custom_endpoint_stays_openai_compat_with_its_credential() {
    let original = serde_json::json!({
        "provider": "openai-compat",
        "env_vars": {
            "OPENAI_COMPAT_API_KEY": "compat-secret",
            "OPENAI_COMPAT_BASE_URL": "https://gateway.example/v1"
        }
    });
    let (record, changed) = migrate(original.clone());

    assert!(!changed);
    assert_eq!(record, original);
}

#[test]
fn legacy_openai_custom_endpoint_becomes_openai_compat() {
    let (record, changed) = migrate(serde_json::json!({
        "provider": "openai",
        "env_vars": {
            "OPENAI_COMPAT_API_KEY": "compat-secret",
            "OPENAI_COMPAT_BASE_URL": "http://localhost:11434/v1"
        }
    }));

    assert!(changed);
    assert_eq!(record["provider"], "openai-compat");
    assert_eq!(record["env_vars"][OPENAI_COMPAT_API_KEY], "compat-secret");
    assert!(record["env_vars"].get(OPENAI_API_KEY).is_none());
}

#[test]
fn non_api_openai_subdomain_is_still_a_compat_endpoint() {
    let (record, changed) = migrate(serde_json::json!({
        "provider": "openai",
        "env_vars": {
            "OPENAI_COMPAT_API_KEY": "compat-secret",
            "OPENAI_COMPAT_BASE_URL": "https://gateway.openai.com/v1"
        }
    }));

    assert!(changed);
    assert_eq!(record["provider"], "openai-compat");
    assert_eq!(record["env_vars"][OPENAI_COMPAT_API_KEY], "compat-secret");
}

#[test]
fn non_api_path_on_openai_host_is_still_a_compat_endpoint() {
    let (record, changed) = migrate(serde_json::json!({
        "provider": "openai",
        "env_vars": {
            "OPENAI_COMPAT_API_KEY": "compat-secret",
            "OPENAI_COMPAT_BASE_URL": "https://api.openai.com/proxy/v1"
        }
    }));

    assert!(changed);
    assert_eq!(record["provider"], "openai-compat");
    assert_eq!(record["env_vars"][OPENAI_COMPAT_API_KEY], "compat-secret");
    assert!(record["env_vars"].get(OPENAI_API_KEY).is_none());
}

#[test]
fn legacy_openai_compat_without_custom_endpoint_becomes_official() {
    let (record, changed) = migrate(serde_json::json!({
        "provider": "openai-compat",
        "env_vars": { "OPENAI_COMPAT_API_KEY": "official-secret" }
    }));

    assert!(changed);
    assert_eq!(record["provider"], "openai");
    assert_eq!(record["env_vars"][OPENAI_API_KEY], "official-secret");
    assert!(record["env_vars"].get(OPENAI_COMPAT_API_KEY).is_none());
}

#[test]
fn existing_distinct_credentials_are_both_preserved() {
    let original = serde_json::json!({
        "provider": "openai",
        "env_vars": {
            "OPENAI_API_KEY": "official-secret",
            "OPENAI_COMPAT_API_KEY": "compat-secret"
        }
    });
    let (record, changed) = migrate(original.clone());

    assert!(!changed);
    assert_eq!(record, original);
}

#[test]
fn providerless_record_is_not_guessed() {
    let original = serde_json::json!({
        "env_vars": { "OPENAI_COMPAT_API_KEY": "ambiguous-secret" }
    });
    let (record, changed) = migrate(original.clone());

    assert!(!changed);
    assert_eq!(record, original);
}

#[test]
fn record_inherits_custom_global_endpoint_for_classification() {
    let inherited_env = serde_json::json!({
        "OPENAI_COMPAT_BASE_URL": "https://gateway.example/v1"
    });
    let mut record = serde_json::json!({
        "provider": "openai",
        "env_vars": { "OPENAI_COMPAT_API_KEY": "compat-secret" }
    })
    .as_object()
    .unwrap()
    .clone();

    let changed =
        migrate_openai_credential_record(&mut record, None, inherited_env.as_object(), true)
            .unwrap();

    assert!(changed);
    assert_eq!(record["provider"], "openai-compat");
    assert_eq!(record["env_vars"][OPENAI_COMPAT_API_KEY], "compat-secret");
    assert!(record["env_vars"].get(OPENAI_API_KEY).is_none());
}

#[test]
fn local_endpoint_override_wins_over_inherited_endpoint() {
    let inherited_env = serde_json::json!({
        "OPENAI_COMPAT_BASE_URL": "https://gateway.example/v1"
    });
    let mut record = serde_json::json!({
        "provider": "openai",
        "env_vars": {
            "OPENAI_COMPAT_API_KEY": "official-secret",
            "OPENAI_COMPAT_BASE_URL": "https://api.openai.com/v1"
        }
    })
    .as_object()
    .unwrap()
    .clone();

    let changed =
        migrate_openai_credential_record(&mut record, None, inherited_env.as_object(), true)
            .unwrap();

    assert!(changed);
    assert_eq!(record["provider"], "openai");
    assert_eq!(record["env_vars"][OPENAI_API_KEY], "official-secret");
}

#[test]
fn credentialed_openai_host_is_not_classified_as_official() {
    let (record, changed) = migrate(serde_json::json!({
        "provider": "openai",
        "env_vars": {
            "OPENAI_COMPAT_API_KEY": "compat-secret",
            "OPENAI_COMPAT_BASE_URL": "https://attacker@example.com@api.openai.com/v1"
        }
    }));

    assert!(changed);
    assert_eq!(record["provider"], "openai-compat");
    assert_eq!(record["env_vars"][OPENAI_COMPAT_API_KEY], "compat-secret");
}

#[test]
fn custom_harness_origin_prevents_official_credential_relabeling() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("managed-agents.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!([{
            "pubkey": "",
            "slug": "custom-definition",
            "runtime": "custom-gateway",
            "provider": "openai",
            "env_vars": { "OPENAI_COMPAT_API_KEY": "compat-secret" }
        }]))
        .unwrap(),
    )
    .unwrap();
    let harnesses = custom_gateway_harnesses();

    migrate_openai_credentials_in_file(&path, None, None, &harnesses).unwrap();
    let records: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

    assert_eq!(records[0]["provider"], "openai-compat");
    assert_eq!(
        records[0]["env_vars"][OPENAI_COMPAT_API_KEY],
        "compat-secret"
    );
    assert!(records[0]["env_vars"].get(OPENAI_API_KEY).is_none());
}

#[test]
fn unresolved_custom_harness_leaves_file_unmarked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("managed-agents.json");
    let original = serde_json::to_vec(&serde_json::json!([{
        "pubkey": "",
        "slug": "custom-definition",
        "runtime": "missing-custom-harness",
        "provider": "openai",
        "env_vars": { "OPENAI_COMPAT_API_KEY": "compat-secret" }
    }]))
    .unwrap();
    std::fs::write(&path, &original).unwrap();

    let error =
        migrate_openai_credentials_in_file(&path, None, None, &std::collections::HashMap::new())
            .unwrap_err();

    assert!(error.contains("unresolved custom harness"), "{error}");
    assert_eq!(std::fs::read(&path).unwrap(), original);
    assert!(!sibling_path(&path, MIGRATION_SUFFIX).exists());
}

#[test]
fn raw_command_override_does_not_block_runtime_less_record_migration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("managed-agents.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!([{
            "pubkey": "agent-pubkey",
            "agent_command_override": "/opt/custom/my-agent",
            "provider": "openai",
            "env_vars": { "OPENAI_COMPAT_API_KEY": "official-secret" }
        }]))
        .unwrap(),
    )
    .unwrap();

    migrate_openai_credentials_in_file(&path, None, None, &std::collections::HashMap::new())
        .unwrap();
    let records: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

    assert_eq!(records[0]["env_vars"][OPENAI_API_KEY], "official-secret");
    assert!(sibling_path(&path, MIGRATION_SUFFIX).exists());
}

#[test]
fn raw_command_override_allows_migration_past_dangling_runtime() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("managed-agents.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!([
            {
                "pubkey": "overridden-agent",
                "runtime": "missing-custom-harness",
                "agent_command_override": "/opt/custom/my-agent",
                "provider": "openai",
                "env_vars": { "OPENAI_COMPAT_API_KEY": "overridden-secret" }
            },
            {
                "pubkey": "unrelated-agent",
                "provider": "openai",
                "env_vars": { "OPENAI_COMPAT_API_KEY": "unrelated-secret" }
            }
        ]))
        .unwrap(),
    )
    .unwrap();

    migrate_openai_credentials_in_file(&path, None, None, &std::collections::HashMap::new())
        .unwrap();
    let records: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

    assert_eq!(records[0]["env_vars"][OPENAI_API_KEY], "overridden-secret");
    assert_eq!(records[1]["env_vars"][OPENAI_API_KEY], "unrelated-secret");
    assert!(sibling_path(&path, MIGRATION_SUFFIX).exists());
}

#[test]
fn global_credentials_ignore_preferred_runtime_harness_env() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("global-agent-config.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "preferred_runtime": "custom-gateway",
            "provider": "openai",
            "env_vars": { "OPENAI_COMPAT_API_KEY": "official-secret" }
        }))
        .unwrap(),
    )
    .unwrap();
    let harnesses = custom_gateway_harnesses();

    migrate_openai_credentials_in_file(&path, None, None, &harnesses).unwrap();
    let global: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

    assert_eq!(global["provider"], "openai");
    assert_eq!(global["env_vars"][OPENAI_API_KEY], "official-secret");
    assert!(global["env_vars"].get(OPENAI_COMPAT_API_KEY).is_none());
}

#[test]
fn runtime_less_record_ignores_custom_preferred_runtime() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("managed-agents.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!([{
            "pubkey": "agent-pubkey",
            "provider": "openai",
            "env_vars": { "OPENAI_COMPAT_API_KEY": "official-secret" }
        }]))
        .unwrap(),
    )
    .unwrap();
    let harnesses = custom_gateway_harnesses();

    migrate_openai_credentials_in_file(&path, None, None, &harnesses).unwrap();
    let records: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

    assert_eq!(records[0]["provider"], "openai");
    assert_eq!(records[0]["env_vars"][OPENAI_API_KEY], "official-secret");
}

#[test]
fn command_override_does_not_suppress_record_runtime_env() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("managed-agents.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!([{
            "pubkey": "agent-pubkey",
            "runtime": "custom-gateway",
            "agent_command_override": "buzz-agent",
            "provider": "openai",
            "env_vars": { "OPENAI_COMPAT_API_KEY": "official-secret" }
        }]))
        .unwrap(),
    )
    .unwrap();
    let harnesses = custom_gateway_harnesses();

    migrate_openai_credentials_in_file(&path, None, None, &harnesses).unwrap();
    let records: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

    assert_eq!(records[0]["provider"], "openai-compat");
    assert_eq!(
        records[0]["env_vars"][OPENAI_COMPAT_API_KEY],
        "official-secret"
    );
    assert!(records[0]["env_vars"].get(OPENAI_API_KEY).is_none());
}

#[test]
fn inherited_openai_is_materialized_when_local_endpoint_is_compat() {
    let dir = tempfile::tempdir().unwrap();
    let global_path = dir.path().join("global-agent-config.json");
    let managed_path = dir.path().join("managed-agents.json");
    std::fs::write(
        &global_path,
        serde_json::to_vec(&serde_json::json!({
            "provider": "openai",
            "env_vars": {}
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        &managed_path,
        serde_json::to_vec(&serde_json::json!([{
            "pubkey": "agent-pubkey",
            "agent_command_override": "buzz-agent",
            "env_vars": {
                "OPENAI_COMPAT_BASE_URL": "https://gateway.example/v1",
                "OPENAI_COMPAT_API_KEY": "compat-secret"
            }
        }]))
        .unwrap(),
    )
    .unwrap();
    let harnesses = std::collections::HashMap::new();

    migrate_openai_credentials_in_file(&global_path, None, None, &harnesses).unwrap();
    let global: Value =
        serde_json::from_str(&std::fs::read_to_string(&global_path).unwrap()).unwrap();
    migrate_openai_credentials_in_file(
        &managed_path,
        global.get("provider").and_then(Value::as_str),
        global.get("env_vars").and_then(Value::as_object),
        &harnesses,
    )
    .unwrap();
    let records: Value =
        serde_json::from_str(&std::fs::read_to_string(&managed_path).unwrap()).unwrap();

    assert_eq!(records[0]["provider"], "openai-compat");
    assert_eq!(
        records[0]["env_vars"][OPENAI_COMPAT_API_KEY],
        "compat-secret"
    );
    assert_eq!(
        records[0]["env_vars"][OPENAI_COMPAT_BASE_URL],
        "https://gateway.example/v1"
    );
    assert!(records[0]["env_vars"].get(OPENAI_API_KEY).is_none());
    assert!(sibling_path(&managed_path, MIGRATION_SUFFIX).exists());
}

#[test]
fn inherited_openai_is_materialized_on_providerless_definition() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("managed-agents.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!([
            {
                "pubkey": "",
                "slug": "shared-definition",
                "env_vars": {
                    "OPENAI_COMPAT_BASE_URL": "https://gateway.example/v1",
                    "OPENAI_COMPAT_API_KEY": "definition-secret"
                }
            },
            {
                "pubkey": "agent-pubkey",
                "persona_id": "shared-definition",
                "env_vars": {}
            }
        ]))
        .unwrap(),
    )
    .unwrap();

    migrate_file(&path, Some("openai"), None).unwrap();
    let records: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

    assert_eq!(records[0]["provider"], "openai-compat");
    assert_eq!(
        records[0]["env_vars"][OPENAI_COMPAT_API_KEY],
        "definition-secret"
    );
    assert!(records[1].get("provider").is_none());
    assert!(sibling_path(&path, MIGRATION_SUFFIX).exists());
}

#[test]
fn linked_local_endpoint_conflict_is_left_unwritten_and_unmarked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("managed-agents.json");
    let original = serde_json::to_vec(&serde_json::json!([
        {
            "pubkey": "",
            "slug": "shared-definition",
            "provider": "openai",
            "env_vars": {}
        },
        {
            "pubkey": "agent-pubkey",
            "persona_id": "shared-definition",
            "env_vars": {
                "OPENAI_COMPAT_BASE_URL": "https://gateway.example/v1",
                "OPENAI_COMPAT_API_KEY": "compat-secret"
            }
        }
    ]))
    .unwrap();
    std::fs::write(&path, &original).unwrap();

    let error = migrate_file(&path, Some("openai"), None).unwrap_err();

    assert!(
        error.contains("cannot migrate a linked instance"),
        "{error}"
    );
    assert_eq!(std::fs::read(&path).unwrap(), original);
    assert!(!sibling_path(&path, BACKUP_SUFFIX).exists());
    assert!(!sibling_path(&path, MIGRATION_SUFFIX).exists());
}

#[test]
fn linked_instance_uses_definition_provider_and_layered_endpoint() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("managed-agents.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!([
            {
                "pubkey": "",
                "slug": "shared-definition",
                "provider": "openai",
                "env_vars": {
                    "OPENAI_COMPAT_API_KEY": "definition-compat-key",
                    "OPENAI_COMPAT_BASE_URL": "https://gateway.example/v1"
                }
            },
            {
                "pubkey": "agent-pubkey",
                "persona_id": "shared-definition",
                "provider": "openai",
                "env_vars": { "OPENAI_COMPAT_API_KEY": "instance-compat-key" }
            }
        ]))
        .unwrap(),
    )
    .unwrap();

    migrate_file(&path, Some("openai"), None).unwrap();
    let records: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

    assert_eq!(records[0]["provider"], "openai-compat");
    assert_eq!(
        records[1]["provider"], "openai",
        "linked instance provider is a stale snapshot and is not an ownership tier"
    );
    assert_eq!(
        records[1]["env_vars"][OPENAI_COMPAT_API_KEY],
        "instance-compat-key"
    );
    assert!(records[1]["env_vars"].get(OPENAI_API_KEY).is_none());
}

#[test]
fn linked_instance_ignores_legacy_provider_snapshot_when_definition_uses_global() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("managed-agents.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!([
            {
                "pubkey": "",
                "slug": "shared-definition",
                "provider": null,
                "env_vars": {}
            },
            {
                "pubkey": "agent-pubkey",
                "persona_id": "shared-definition",
                "provider": "anthropic",
                "env_vars": { "OPENAI_COMPAT_API_KEY": "legacy-official-key" }
            }
        ]))
        .unwrap(),
    )
    .unwrap();

    migrate_file(&path, Some("openai"), None).unwrap();
    let records: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

    assert_eq!(records[1]["provider"], "anthropic");
    assert_eq!(
        records[1]["env_vars"][OPENAI_API_KEY],
        "legacy-official-key"
    );
    assert!(records[1]["env_vars"].get(OPENAI_COMPAT_API_KEY).is_none());
}

#[test]
fn array_migration_updates_every_record() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("managed-agents.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!([
            {
                "provider": "openai",
                "env_vars": { "OPENAI_COMPAT_API_KEY": "first" }
            },
            {
                "provider": "openai",
                "env_vars": { "OPENAI_COMPAT_API_KEY": "second" }
            }
        ]))
        .unwrap(),
    )
    .unwrap();

    migrate_file(&path, None, None).unwrap();
    let records: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(records[0]["env_vars"][OPENAI_API_KEY], "first");
    assert_eq!(records[1]["env_vars"][OPENAI_API_KEY], "second");
}

#[test]
fn migration_marker_preserves_post_upgrade_compat_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("managed-agents.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!([{
            "provider": "openai",
            "env_vars": { "OPENAI_COMPAT_API_KEY": "legacy-secret" }
        }]))
        .unwrap(),
    )
    .unwrap();

    migrate_file(&path, None, None).unwrap();
    let mut records: Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    records[0]["env_vars"][OPENAI_COMPAT_API_KEY] = Value::String("new-compat".to_string());
    std::fs::write(&path, serde_json::to_vec(&records).unwrap()).unwrap();

    migrate_file(&path, None, None).unwrap();
    let records: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(records[0]["env_vars"][OPENAI_API_KEY], "legacy-secret");
    assert_eq!(records[0]["env_vars"][OPENAI_COMPAT_API_KEY], "new-compat");
}

#[test]
fn changed_file_gets_pristine_backup_before_marker() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("global-agent-config.json");
    let original = serde_json::json!({
        "provider": "openai",
        "env_vars": { "OPENAI_COMPAT_API_KEY": "official-secret" }
    });
    let original_bytes = serde_json::to_vec(&original).unwrap();
    std::fs::write(&path, &original_bytes).unwrap();

    migrate_file(&path, None, None).unwrap();

    assert_eq!(
        std::fs::read(sibling_path(&path, BACKUP_SUFFIX)).unwrap(),
        original_bytes
    );
    assert_eq!(
        std::fs::read_to_string(sibling_path(&path, MIGRATION_SUFFIX)).unwrap(),
        "1\n"
    );
    let migrated: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(migrated["env_vars"][OPENAI_API_KEY], "official-secret");
}

#[test]
fn malformed_file_is_preserved_and_not_marked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("managed-agents.json");
    let original = b"{ not valid json";
    std::fs::write(&path, original).unwrap();

    let error = migrate_file(&path, None, None).unwrap_err();

    assert!(error.contains("failed to parse"), "{error}");
    assert_eq!(std::fs::read(&path).unwrap(), original);
    assert!(!sibling_path(&path, BACKUP_SUFFIX).exists());
    assert!(!sibling_path(&path, MIGRATION_SUFFIX).exists());
}

#[test]
fn absent_file_is_not_marked_so_later_legacy_content_can_be_migrated() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("global-agent-config.json");
    migrate_file(&path, None, None).unwrap();
    assert!(!sibling_path(&path, MIGRATION_SUFFIX).exists());
    let legacy = serde_json::json!({
        "provider": "openai",
        "env_vars": { "OPENAI_COMPAT_API_KEY": "official-secret" }
    });
    std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();

    migrate_file(&path, None, None).unwrap();
    let after: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(after["env_vars"][OPENAI_API_KEY], "official-secret");
    assert!(after["env_vars"].get(OPENAI_COMPAT_API_KEY).is_none());
}
