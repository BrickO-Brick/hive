//! Unit tests for NIP-FI startup validation (Phase A, PR 3).

use super::*;
use crate::nip_fi::config::{FreshnessClass, IssuerPolicy, IssuerRegistry, TokenClass};
use crate::nip_fi::jwks::IssuerJwksConfig;
use jsonwebtoken::Algorithm as JwtAlgorithm;

/// Build a minimal valid offline-jwt `IssuerPolicy`.
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

/// Build a minimal valid current-status `IssuerPolicy`.
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

// ── Off / DenyProtected accept anything ───────────────────────────────────────

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

// ── Enforce: basic happy path ─────────────────────────────────────────────────

#[test]
fn enforce_valid_config_passes() {
    let issuer = "https://id.example";
    let mut registry = IssuerRegistry::new();
    registry.insert(make_offline_policy(issuer));

    let jwks = vec![make_jwks_config(issuer)];
    assert!(validate_nip_fi_config(NipFiMode::Enforce, &registry, &jwks).is_ok());
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

// ── Enforce: empty registry ───────────────────────────────────────────────────

#[test]
fn enforce_empty_registry_rejects() {
    let registry = IssuerRegistry::new();
    let err = validate_nip_fi_config(NipFiMode::Enforce, &registry, &[]).unwrap_err();
    assert_eq!(err, NipFiStartupError::EmptyRegistry);
}

// ── Enforce: missing JWKS config ─────────────────────────────────────────────

#[test]
fn enforce_issuer_without_jwks_rejects() {
    let issuer = "https://id.example";
    let mut registry = IssuerRegistry::new();
    registry.insert(make_offline_policy(issuer));

    let err = validate_nip_fi_config(NipFiMode::Enforce, &registry, &[]).unwrap_err();
    assert_eq!(err, NipFiStartupError::MissingJwksConfig);
}

// ── Enforce: unmatched JWKS config ───────────────────────────────────────────

#[test]
fn enforce_unmatched_jwks_config_rejects() {
    let issuer = "https://id.example";
    let mut registry = IssuerRegistry::new();
    registry.insert(make_offline_policy(issuer));

    // JWKS config for a different issuer.
    let jwks = vec![make_jwks_config("https://other.example")];
    let err = validate_nip_fi_config(NipFiMode::Enforce, &registry, &jwks).unwrap_err();
    assert_eq!(err, NipFiStartupError::UnmatchedJwksConfig);
}

// ── Enforce: invalid JWKS timing ─────────────────────────────────────────────

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
    let err = validate_nip_fi_config(NipFiMode::Enforce, &registry, &jwks).unwrap_err();
    assert_eq!(err, NipFiStartupError::InvalidJwksTiming);
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
    let err = validate_nip_fi_config(NipFiMode::Enforce, &registry, &jwks).unwrap_err();
    assert_eq!(err, NipFiStartupError::InvalidJwksTiming);
}

// ── current-status requires JWKS ─────────────────────────────────────────────

#[test]
fn enforce_current_status_without_jwks_rejects() {
    let issuer = "https://id.example";
    let mut registry = IssuerRegistry::new();
    registry.insert(make_status_policy(issuer));

    let err = validate_nip_fi_config(NipFiMode::Enforce, &registry, &[]).unwrap_err();
    // Either CurrentStatusRequiresJwks or MissingJwksConfig is correct here;
    // the current implementation returns CurrentStatusRequiresJwks.
    assert!(
        err == NipFiStartupError::CurrentStatusRequiresJwks
            || err == NipFiStartupError::MissingJwksConfig,
        "expected a JWKS-missing error, got {err:?}"
    );
}

#[test]
fn enforce_current_status_with_jwks_passes() {
    let issuer = "https://id.example";
    let mut registry = IssuerRegistry::new();
    registry.insert(make_status_policy(issuer));

    let jwks = vec![make_jwks_config(issuer)];
    assert!(validate_nip_fi_config(NipFiMode::Enforce, &registry, &jwks).is_ok());
}
