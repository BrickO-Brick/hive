use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

const OPENAI_API_KEY: &str = "OPENAI_API_KEY";
const OPENAI_COMPAT_API_KEY: &str = "OPENAI_COMPAT_API_KEY";
const OPENAI_COMPAT_BASE_URL: &str = "OPENAI_COMPAT_BASE_URL";
const MIGRATION_SUFFIX: &str = "openai-credentials-v1.migrated";
const BACKUP_SUFFIX: &str = "pre-openai-credentials-v1.bak";

fn uses_official_openai_endpoint(
    env_vars: Option<&Map<String, Value>>,
    inherited_env_vars: Option<&Map<String, Value>>,
) -> bool {
    let Some(base_url) = env_vars
        .and_then(|env| env.get(OPENAI_COMPAT_BASE_URL))
        .or_else(|| inherited_env_vars.and_then(|env| env.get(OPENAI_COMPAT_BASE_URL)))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return true;
    };
    let Ok(url) = url::Url::parse(base_url) else {
        return false;
    };
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case("api.openai.com"))
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path().trim_end_matches('/'), "" | "/v1")
        && url.query().is_none()
        && url.fragment().is_none()
}

fn migrate_openai_credential_record(
    record: &mut Map<String, Value>,
    effective_provider: Option<&str>,
    inherited_env_vars: Option<&Map<String, Value>>,
) -> bool {
    let local_provider = record
        .get("provider")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|provider| !provider.is_empty());
    let Some(provider) = effective_provider
        .or(local_provider)
        .map(str::to_ascii_lowercase)
        .filter(|provider| matches!(provider.as_str(), "openai" | "openai-compat"))
    else {
        return false;
    };
    let official_endpoint = uses_official_openai_endpoint(
        record.get("env_vars").and_then(Value::as_object),
        inherited_env_vars,
    );
    let target_provider = if official_endpoint {
        "openai"
    } else {
        "openai-compat"
    };
    let mut changed = false;
    if local_provider.is_some() && provider != target_provider {
        record.insert(
            "provider".to_string(),
            Value::String(target_provider.to_string()),
        );
        changed = true;
    }
    if target_provider != "openai" {
        return changed;
    }

    let Some(env_vars) = record.get_mut("env_vars").and_then(Value::as_object_mut) else {
        return changed;
    };
    changed |= env_vars.remove(OPENAI_COMPAT_BASE_URL).is_some();
    if env_vars.contains_key(OPENAI_API_KEY) {
        return changed;
    }
    let Some(legacy_key) = env_vars.remove(OPENAI_COMPAT_API_KEY) else {
        return changed;
    };
    env_vars.insert(OPENAI_API_KEY.to_string(), legacy_key);
    true
}

#[derive(Clone, Debug)]
struct DefinitionContext {
    provider: Option<String>,
    runtime: Option<String>,
    env: Map<String, Value>,
}

fn harness_env_for_runtime(
    runtime: Option<&str>,
    command_override_present: bool,
    harnesses: &std::collections::HashMap<String, Map<String, Value>>,
) -> Result<Map<String, Value>, String> {
    let Some(runtime) = runtime.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(Map::new());
    };
    if let Some(env) = harnesses.get(runtime) {
        return Ok(env.clone());
    }
    if command_override_present {
        // Spawn accepts an explicit command before resolving the runtime. A
        // deleted runtime then contributes no definition env rather than
        // making the otherwise runnable record fail.
        return Ok(Map::new());
    }
    if crate::managed_agents::custom_harnesses::check_id_collision(runtime).is_ok() {
        return Err(format!("unresolved custom harness {runtime:?}"));
    }
    Ok(Map::new())
}

fn sibling_path(path: &Path, suffix: &str) -> PathBuf {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default();
    crate::util::resolved_backup_path(path, &format!("{file_name}.{suffix}"))
}

// This migration is intentionally one-shot. After the split, a single config may
// legitimately hold both credentials; reclassifying it on every boot would delete
// a newly added compat key whenever its default provider is official OpenAI.
fn migrate_openai_credentials_in_file(
    path: &Path,
    effective_provider: Option<&str>,
    inherited_env_vars: Option<&Map<String, Value>>,
    harnesses: &std::collections::HashMap<String, Map<String, Value>>,
) -> Result<(), String> {
    let marker_path = sibling_path(path, MIGRATION_SUFFIX);
    if marker_path.exists() {
        return Ok(());
    }
    if !path.exists() {
        // A later boot migration or sync step may still create this file with
        // legacy bytes. Absence is not evidence that migration is complete.
        return Ok(());
    }

    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let mut root: Value = serde_json::from_str(&content)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))?;
    let changed = match &mut root {
        Value::Array(records) => {
            // Linked instances resolve provider and env from their definition,
            // not from the instance's legacy snapshot. Build that inheritance
            // view before mutating any record so classification follows the same
            // precedence as spawn/readiness.
            let definitions: std::collections::HashMap<String, DefinitionContext> = records
                .iter()
                .filter_map(Value::as_object)
                .filter(|record| record.get("pubkey").and_then(Value::as_str) == Some(""))
                .filter_map(|record| {
                    let slug = record.get("slug")?.as_str()?.to_string();
                    let provider = record
                        .get("provider")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    let runtime = record
                        .get("runtime")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    let env = record
                        .get("env_vars")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    Some((
                        slug,
                        DefinitionContext {
                            provider,
                            runtime,
                            env,
                        },
                    ))
                })
                .collect();
            let mut changed = false;
            for record in records.iter_mut().filter_map(Value::as_object_mut) {
                let definition = record
                    .get("persona_id")
                    .and_then(Value::as_str)
                    .and_then(|id| definitions.get(id));
                let local_provider = record
                    .get("provider")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|provider| !provider.is_empty())
                    .map(str::to_owned);
                // Linked instances ignore their legacy provider snapshot. Their
                // definition is authoritative and falls back directly to the
                // global provider; only definition-less records consult their
                // own provider before the global fallback. Own the selected
                // value so mutating the record below cannot overlap a borrow of
                // its provider field.
                let effective_provider = match definition {
                    Some(definition) => definition
                        .provider
                        .as_deref()
                        .map(str::trim)
                        .filter(|provider| !provider.is_empty())
                        .map(str::to_owned)
                        .or_else(|| effective_provider.map(str::to_owned)),
                    None => local_provider.or_else(|| effective_provider.map(str::to_owned)),
                };
                let local_runtime = record
                    .get("runtime")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|runtime| !runtime.is_empty());
                let selected_runtime = local_runtime
                    .or_else(|| definition.and_then(|definition| definition.runtime.as_deref()))
                    .map(str::trim)
                    .filter(|runtime| !runtime.is_empty());
                let command_override_present = record
                    .get("agent_command_override")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .is_some_and(|command| !command.is_empty());
                let merged_inherited_env = {
                    let mut merged = harness_env_for_runtime(
                        selected_runtime,
                        command_override_present,
                        harnesses,
                    )?;
                    if let Some(inherited) = inherited_env_vars {
                        merged.extend(inherited.clone());
                    }
                    if let Some(definition) = definition {
                        merged.extend(definition.env.clone());
                    }
                    (!merged.is_empty()).then_some(merged)
                };
                changed |= migrate_openai_credential_record(
                    record,
                    effective_provider.as_deref(),
                    merged_inherited_env.as_ref().or(inherited_env_vars),
                );
            }
            changed
        }
        Value::Object(record) => {
            migrate_openai_credential_record(record, effective_provider, inherited_env_vars)
        }
        _ => {
            return Err(format!(
                "expected a JSON object or array in {}",
                path.display()
            ));
        }
    };

    if changed {
        let backup_path = sibling_path(path, BACKUP_SUFFIX);
        crate::util::create_restricted_backup_once(&backup_path, content.as_bytes())
            .map_err(|error| format!("failed to back up {}: {error}", path.display()))?;
        let bytes = serde_json::to_vec_pretty(&root)
            .map_err(|error| format!("failed to serialize {}: {error}", path.display()))?;
        crate::managed_agents::atomic_write_json_restricted(path, &bytes)?;
    }

    crate::managed_agents::atomic_write_json_restricted(&marker_path, b"1\n")
}

pub(super) fn migrate_openai_credentials(app: &tauri::AppHandle) {
    let Ok(agents_dir) = crate::managed_agents::managed_agents_base_dir(app) else {
        return;
    };
    let custom_harnesses_dir = agents_dir
        .parent()
        .map(|path| path.join("custom_harnesses"));
    let mut harness_definitions = crate::managed_agents::preset_harness_definitions();
    harness_definitions.extend(
        custom_harnesses_dir
            .as_deref()
            .map(crate::managed_agents::custom_harnesses::load_custom_harnesses)
            .unwrap_or_default(),
    );
    let harnesses: std::collections::HashMap<String, Map<String, Value>> = harness_definitions
        .into_iter()
        .map(|definition| {
            let env = definition
                .env
                .into_iter()
                .map(|(key, value)| (key, Value::String(value)))
                .collect();
            (definition.id, env)
        })
        .collect();
    let global_path = agents_dir.join("global-agent-config.json");
    if let Err(error) = migrate_openai_credentials_in_file(&global_path, None, None, &harnesses) {
        eprintln!("buzz-desktop: openai-credential-migration: {error}");
    }

    // Agent and definition records inherit the global env floor. Classification
    // must use that effective endpoint when a record does not override it;
    // otherwise an `openai` definition inheriting a custom global origin would
    // be silently relabeled as official OpenAI and stop working.
    let global = std::fs::read_to_string(&global_path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok());
    let global_provider = global
        .as_ref()
        .and_then(|root| root.get("provider"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let global_env = global
        .as_ref()
        .and_then(|root| root.get("env_vars"))
        .and_then(Value::as_object)
        .cloned();
    let managed_path = agents_dir.join("managed-agents.json");
    if let Err(error) = migrate_openai_credentials_in_file(
        &managed_path,
        global_provider.as_deref(),
        global_env.as_ref(),
        &harnesses,
    ) {
        eprintln!("buzz-desktop: openai-credential-migration: {error}");
    }
}

#[cfg(test)]
mod tests {
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
        let changed = migrate_openai_credential_record(&mut record, None, None);
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
            migrate_openai_credential_record(&mut record, None, inherited_env.as_object());

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
            migrate_openai_credential_record(&mut record, None, inherited_env.as_object());

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
        let records: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

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

        let error = migrate_openai_credentials_in_file(
            &path,
            None,
            None,
            &std::collections::HashMap::new(),
        )
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
        let records: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

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
        let records: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

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
        let records: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

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
        let records: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

        assert_eq!(records[0]["provider"], "openai-compat");
        assert_eq!(
            records[0]["env_vars"][OPENAI_COMPAT_API_KEY],
            "official-secret"
        );
        assert!(records[0]["env_vars"].get(OPENAI_API_KEY).is_none());
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
        let records: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

        assert_eq!(records[0]["provider"], "openai-compat");
        assert_eq!(records[1]["provider"], "openai-compat");
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
        let records: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

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
        let records: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
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
        let records: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
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
        let migrated: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
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
}
