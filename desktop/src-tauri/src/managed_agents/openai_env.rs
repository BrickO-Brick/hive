use std::collections::BTreeMap;

pub(crate) fn effective_runtime_provider(
    command: &str,
    configured_provider: Option<String>,
    env: &BTreeMap<String, String>,
) -> Option<String> {
    if crate::managed_agents::known_acp_runtime(command)
        .is_some_and(|runtime| runtime.id == "buzz-agent")
    {
        env.get("BUZZ_AGENT_PROVIDER")
            .cloned()
            .or(configured_provider)
    } else {
        configured_provider
    }
}

pub(crate) fn canonicalize_openai_provider_env(
    env: &mut BTreeMap<String, String>,
    provider: Option<&str>,
) -> Option<String> {
    let mut provider = provider.map(str::trim).map(str::to_ascii_lowercase);
    if provider.as_deref() == Some("openai") {
        let official_key = env
            .get("OPENAI_API_KEY")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let legacy_key = env
            .get("OPENAI_COMPAT_API_KEY")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let has_custom_origin = env
            .get("OPENAI_COMPAT_BASE_URL")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some_and(|value| value.trim_end_matches('/') != "https://api.openai.com/v1");
        if legacy_key.is_some()
            && has_custom_origin
            && (official_key.is_none() || official_key == legacy_key)
        {
            provider = Some("openai-compat".to_string());
        }
    }

    match provider.as_deref() {
        Some("openai") => {
            env.remove("OPENAI_COMPAT_BASE_URL");
            env.remove("OPENAI_COMPAT_API_KEY");
        }
        Some("openai-compat") => {
            env.remove("OPENAI_API_KEY");
            env.entry("OPENAI_COMPAT_API_KEY".to_string()).or_default();
        }
        _ => {}
    }
    if let (Some(value), Some(slot)) = (provider.as_ref(), env.get_mut("BUZZ_AGENT_PROVIDER")) {
        *slot = value.clone();
    }
    provider
}
