use super::*;
use crate::nip_fi::config::{FreshnessClass, IssuerPolicy, IssuerRegistry, TokenClass};
use crate::nip_fi::jwks::IssuerJwksConfig;
use jsonwebtoken::Algorithm as JwtAlgorithm;

fn make_offline_policy(issuer: &str) -> IssuerPolicy {
    IssuerPolicy::new(
        issuer.to_owned(),
        vec![format!("https://relay.example/api")],
        TokenClass::DedicatedNipFi,
        FreshnessClass::OfflineJwt,
        vec![JwtAlgorithm::ES256],
        false,
        0,
        3600,
        None,
    )
    .unwrap()
}

fn make_status_policy(issuer: &str) -> IssuerPolicy {
    IssuerPolicy::new(
        issuer.to_owned(),
        vec![format!("https://relay.example/api")],
        TokenClass::DedicatedNipFi,
        FreshnessClass::CurrentStatus,
        vec![JwtAlgorithm::ES256],
        false,
        0,
        3600,
        Some(60),
    )
    .unwrap()
}

fn make_jwks_config(issuer: &str) -> IssuerJwksConfig {
    IssuerJwksConfig {
        issuer: issuer.to_owned(),
        jwks_uri: format!("https://{issuer}/.well-known/jwks.json"),
        refresh_interval_seconds: 300,
        key_snapshot_hard_deadline_seconds: 3600,
    }
}

#[test]
fn off_mode_accepts_empty_registry() {
    let registry = IssuerRegistry::new();
    assert!(validate_nip_fi_config(NipFiMode::Off, &registry, &[]).is_ok());
}

#[test]
fn deny_protected_mode_accepts_empty_registry() {
    let registry = IssuerRegistry::new();
    assert!(validate_nip_fi_config(NipFiMode::DenyProtected, &registry, &[]).is_ok());
}

#[test]
fn enforce_valid_config_passes() {
    let issuer = "https://id.example";
    let mut registry = IssuerRegistry::new();
    registry.insert(make_offline_policy(issuer));

    assert!(
        validate_nip_fi_config(NipFiMode::Enforce, &registry, &[make_jwks_config(issuer)]).is_ok()
    );
}

#[test]
fn enforce_multiple_issuers_passes() {
    let issuers = [
        "https://a.example",
        "https://b.example",
        "https://c.example",
    ];
    let mut registry = IssuerRegistry::new();
    for iss in &issuers {
        registry.insert(make_offline_policy(iss));
    }
    let jwks: Vec<_> = issuers.iter().map(|i| make_jwks_config(i)).collect();
    assert!(validate_nip_fi_config(NipFiMode::Enforce, &registry, &jwks).is_ok());
}

#[test]
fn enforce_empty_registry_rejects() {
    let registry = IssuerRegistry::new();
    let err = validate_nip_fi_config(NipFiMode::Enforce, &registry, &[]).unwrap_err();
    assert_eq!(err, NipFiStartupError::EmptyRegistry);
}

#[test]
fn enforce_issuer_without_jwks_rejects() {
    let issuer = "https://id.example";
    let mut registry = IssuerRegistry::new();
    registry.insert(make_offline_policy(issuer));

    let err = validate_nip_fi_config(NipFiMode::Enforce, &registry, &[]).unwrap_err();
    assert_eq!(err, NipFiStartupError::MissingJwksConfig);
}

#[test]
fn enforce_unmatched_jwks_config_rejects() {
    let issuer = "https://id.example";
    let mut registry = IssuerRegistry::new();
    registry.insert(make_offline_policy(issuer));

    let err = validate_nip_fi_config(
        NipFiMode::Enforce,
        &registry,
        &[make_jwks_config("https://other.example")],
    )
    .unwrap_err();
    assert_eq!(err, NipFiStartupError::UnmatchedJwksConfig);
}

#[test]
fn enforce_refresh_equals_hard_deadline_rejects() {
    let issuer = "https://id.example";
    let mut registry = IssuerRegistry::new();
    registry.insert(make_offline_policy(issuer));

    let jwks = vec![IssuerJwksConfig {
        issuer: issuer.to_owned(),
        jwks_uri: "https://id.example/.well-known/jwks.json".to_owned(),
        refresh_interval_seconds: 3600,
        key_snapshot_hard_deadline_seconds: 3600,
    }];
    assert_eq!(
        validate_nip_fi_config(NipFiMode::Enforce, &registry, &jwks).unwrap_err(),
        NipFiStartupError::InvalidJwksTiming
    );
}

#[test]
fn enforce_zero_refresh_interval_rejects() {
    let issuer = "https://id.example";
    let mut registry = IssuerRegistry::new();
    registry.insert(make_offline_policy(issuer));

    let jwks = vec![IssuerJwksConfig {
        issuer: issuer.to_owned(),
        jwks_uri: "https://id.example/.well-known/jwks.json".to_owned(),
        refresh_interval_seconds: 0,
        key_snapshot_hard_deadline_seconds: 3600,
    }];
    assert_eq!(
        validate_nip_fi_config(NipFiMode::Enforce, &registry, &jwks).unwrap_err(),
        NipFiStartupError::InvalidJwksTiming
    );
}

/// Rejected regardless of whether a JWKS config is present — the verifier
/// has no status witness to satisfy the freshness guarantee.
#[test]
fn enforce_current_status_policy_always_rejects() {
    let issuer = "https://id.example";
    let mut registry = IssuerRegistry::new();
    registry.insert(make_status_policy(issuer));

    assert_eq!(
        validate_nip_fi_config(NipFiMode::Enforce, &registry, &[]).unwrap_err(),
        NipFiStartupError::UnsupportedPosture
    );
    assert_eq!(
        validate_nip_fi_config(NipFiMode::Enforce, &registry, &[make_jwks_config(issuer)])
            .unwrap_err(),
        NipFiStartupError::UnsupportedPosture
    );
}

/// Duplicate JWKS configs for the same issuer must not silently succeed.
#[test]
fn enforce_duplicate_jwks_issuer_in_configs_rejects() {
    let issuer = "https://id.example";
    let mut registry = IssuerRegistry::new();
    registry.insert(make_offline_policy(issuer));

    let jwks = vec![make_jwks_config(issuer), make_jwks_config(issuer)];
    assert!(
        validate_nip_fi_config(NipFiMode::Enforce, &registry, &jwks).is_err(),
        "duplicate JWKS configs must not pass"
    );
}

#[test]
fn enforce_non_https_jwks_uri_rejects() {
    let issuer = "https://id.example";
    let mut registry = IssuerRegistry::new();
    registry.insert(make_offline_policy(issuer));

    let jwks = vec![IssuerJwksConfig {
        issuer: issuer.to_owned(),
        jwks_uri: "http://id.example/.well-known/jwks.json".to_owned(),
        refresh_interval_seconds: 300,
        key_snapshot_hard_deadline_seconds: 3600,
    }];
    assert_eq!(
        validate_nip_fi_config(NipFiMode::Enforce, &registry, &jwks).unwrap_err(),
        NipFiStartupError::InvalidJwksUri
    );
}

#[test]
fn enforce_loopback_jwks_uri_rejects() {
    let issuer = "https://id.example";
    let mut registry = IssuerRegistry::new();
    registry.insert(make_offline_policy(issuer));

    let jwks = vec![IssuerJwksConfig {
        issuer: issuer.to_owned(),
        jwks_uri: "https://127.0.0.1/.well-known/jwks.json".to_owned(),
        refresh_interval_seconds: 300,
        key_snapshot_hard_deadline_seconds: 3600,
    }];
    assert_eq!(
        validate_nip_fi_config(NipFiMode::Enforce, &registry, &jwks).unwrap_err(),
        NipFiStartupError::InvalidJwksUri
    );
}
