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
    owns_effective_provider: bool,
) -> Result<bool, String> {
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
        return Ok(false);
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
    if provider != target_provider {
        if !owns_effective_provider {
            return Err(format!(
                "cannot migrate a linked instance whose local endpoint requires provider {target_provider:?} while its definition resolves to {provider:?}"
            ));
        }
        // Classification is based on the fully layered endpoint. Persist the
        // resulting identity at the tier that owns provider resolution even
        // when that tier previously inherited its provider. Without this, the
        // rewrite is locally plausible but resolves back to the old provider
        // after restart — precisely the kind of lie a one-shot marker makes
        // permanent.
        record.insert(
            "provider".to_string(),
            Value::String(target_provider.to_string()),
        );
        changed = true;
    }
    if target_provider != "openai" {
        return Ok(changed);
    }

    let Some(env_vars) = record.get_mut("env_vars").and_then(Value::as_object_mut) else {
        return Ok(changed);
    };
    changed |= env_vars.remove(OPENAI_COMPAT_BASE_URL).is_some();
    if env_vars.contains_key(OPENAI_API_KEY) {
        return Ok(changed);
    }
    let Some(legacy_key) = env_vars.remove(OPENAI_COMPAT_API_KEY) else {
        return Ok(changed);
    };
    env_vars.insert(OPENAI_API_KEY.to_string(), legacy_key);
    Ok(true)
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
            let definition_contexts = |records: &[Value]| {
                records
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
                    .collect::<std::collections::HashMap<String, DefinitionContext>>()
            };
            let mut changed = false;

            // Provider ownership and env ownership are not the same graph.
            // Definitions and standalone records own their provider tier, so
            // migrate them first. Linked instances are definition-authoritative
            // and must be evaluated only after those definitions have reached
            // their persisted post-migration identity.
            for record in records
                .iter_mut()
                .filter_map(Value::as_object_mut)
                .filter(|record| record.get("persona_id").and_then(Value::as_str).is_none())
            {
                let local_provider = record
                    .get("provider")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|provider| !provider.is_empty())
                    .map(str::to_owned);
                let resolved_provider = local_provider
                    .as_deref()
                    .or(effective_provider)
                    .map(str::to_owned);
                let selected_runtime = record
                    .get("runtime")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|runtime| !runtime.is_empty());
                let command_override_present = record
                    .get("agent_command_override")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .is_some_and(|command| !command.is_empty());
                let mut inherited_env =
                    harness_env_for_runtime(selected_runtime, command_override_present, harnesses)?;
                if let Some(global_env) = inherited_env_vars {
                    inherited_env.extend(global_env.clone());
                }
                changed |= migrate_openai_credential_record(
                    record,
                    resolved_provider.as_deref(),
                    (!inherited_env.is_empty()).then_some(&inherited_env),
                    true,
                )?;
            }

            let definitions = definition_contexts(records);
            for record in records.iter_mut().filter_map(Value::as_object_mut) {
                let Some(persona_id) = record.get("persona_id").and_then(Value::as_str) else {
                    continue;
                };
                let definition = definitions
                    .get(persona_id)
                    .ok_or_else(|| format!("cannot resolve linked definition {persona_id:?}"))?;
                let resolved_provider = definition
                    .provider
                    .as_deref()
                    .map(str::trim)
                    .filter(|provider| !provider.is_empty())
                    .or(effective_provider);
                let selected_runtime = record
                    .get("runtime")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|runtime| !runtime.is_empty())
                    .or_else(|| {
                        definition
                            .runtime
                            .as_deref()
                            .map(str::trim)
                            .filter(|runtime| !runtime.is_empty())
                    });
                let command_override_present = record
                    .get("agent_command_override")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .is_some_and(|command| !command.is_empty());
                let mut inherited_env =
                    harness_env_for_runtime(selected_runtime, command_override_present, harnesses)?;
                if let Some(global_env) = inherited_env_vars {
                    inherited_env.extend(global_env.clone());
                }
                inherited_env.extend(definition.env.clone());
                changed |= migrate_openai_credential_record(
                    record,
                    resolved_provider,
                    (!inherited_env.is_empty()).then_some(&inherited_env),
                    false,
                )?;
            }
            changed
        }
        Value::Object(record) => {
            migrate_openai_credential_record(record, effective_provider, inherited_env_vars, true)?
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
#[path = "openai_credentials_tests.rs"]
mod tests;
