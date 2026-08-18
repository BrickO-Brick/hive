use super::*;

#[test]
fn official_openai_models_url_rejects_compat_routing_state() {
    let env = BTreeMap::from([(
        "OPENAI_COMPAT_BASE_URL".to_string(),
        "https://arbitrary-compatible-host.example/v1".to_string(),
    )]);
    let error = openai_compatible_models_url_for_discovery(Some("openai"), &env).unwrap_err();
    assert!(error.contains("provider=openai-compat"), "{error}");

    let legacy_canonical = BTreeMap::from([(
        "OPENAI_COMPAT_BASE_URL".to_string(),
        "https://api.openai.com/v1/".to_string(),
    )]);
    assert_eq!(
        openai_compatible_models_url_for_discovery(Some("openai"), &legacy_canonical).unwrap(),
        "https://api.openai.com/v1/models"
    );
}

#[tokio::test]
async fn official_openai_discovery_does_not_accept_compat_key() {
    let provider = effective_discovery_provider(Some("openai"), None, &BTreeMap::new());
    let env = BTreeMap::from([
        ("OPENAI_API_KEY".to_string(), "   ".to_string()),
        (
            "OPENAI_COMPAT_API_KEY".to_string(),
            "must-not-cross-provider-boundary".to_string(),
        ),
    ]);

    let error = discover_openai_compatible_models(&reqwest::Client::new(), &provider, &env, None)
        .await
        .unwrap_err();

    assert!(error.contains("OPENAI_API_KEY"), "{error}");
    assert!(!error.contains("OPENAI_COMPAT_API_KEY"), "{error}");
}
