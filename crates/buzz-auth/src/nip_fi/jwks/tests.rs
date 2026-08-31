//! Unit tests for the NIP-FI JWKS source (Phase A, PR 3).
//!
//! These tests drive [`ProductionJwksSource`] through a fake [`JwksFetcher`]
//! to avoid live network calls.

use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

// ── Fake fetcher ──────────────────────────────────────────────────────────────

struct FakeJwksFetcher {
    body: Result<String, JwksFetchError>,
    call_count: Arc<AtomicUsize>,
}

impl super::super::verifier::sealed::Sealed for FakeJwksFetcher {}

impl JwksFetcher for FakeJwksFetcher {
    fn fetch_jwks<'a>(
        &'a self,
        _uri: &'a str,
    ) -> impl std::future::Future<Output = Result<String, JwksFetchError>> + Send + 'a {
        let result = self.body.clone();
        self.call_count.fetch_add(1, Ordering::SeqCst);
        async move { result }
    }
}

/// Build a minimal valid ES256 JWK Set JSON with one key.
fn minimal_jwks_json(kid: &str) -> String {
    format!(
        r#"{{"keys":[{{"kty":"EC","crv":"P-256","x":"f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU","y":"x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0","use":"sig","alg":"ES256","kid":"{kid}"}}]}}"#
    )
}

fn make_config(issuer: &str) -> IssuerJwksConfig {
    IssuerJwksConfig {
        issuer: issuer.to_owned(),
        jwks_uri: format!("https://{issuer}/.well-known/jwks.json"),
        refresh_interval_seconds: 300,
        key_snapshot_hard_deadline_seconds: 3600,
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn get_snapshot_returns_sealed_key_set_on_success() {
    let issuer = "https://id.example";
    let fetcher = FakeJwksFetcher {
        body: Ok(minimal_jwks_json("k1")),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    let source = ProductionJwksSource::new(vec![make_config(issuer)], fetcher).unwrap();

    let snapshot = source.get_snapshot(issuer).await;
    assert!(snapshot.is_some(), "snapshot should be present on success");
    let ks = snapshot.unwrap();
    assert_eq!(ks.issuer(), issuer);
}

#[tokio::test]
async fn get_snapshot_returns_none_for_unknown_issuer() {
    let fetcher = FakeJwksFetcher {
        body: Ok(minimal_jwks_json("k1")),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    let source =
        ProductionJwksSource::new(vec![make_config("https://id.example")], fetcher).unwrap();

    let snapshot = source.get_snapshot("https://other.example").await;
    assert!(snapshot.is_none(), "unknown issuer must return None");
}

#[tokio::test]
async fn get_snapshot_returns_none_on_network_error_with_no_cache() {
    let fetcher = FakeJwksFetcher {
        body: Err(JwksFetchError::NetworkError),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    let issuer = "https://id.example";
    let source = ProductionJwksSource::new(vec![make_config(issuer)], fetcher).unwrap();

    let snapshot = source.get_snapshot(issuer).await;
    assert!(snapshot.is_none(), "no cache + network error = None");
}

#[tokio::test]
async fn get_snapshot_returns_none_on_oversized_response() {
    let fetcher = FakeJwksFetcher {
        body: Err(JwksFetchError::ResponseTooLarge),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    let issuer = "https://id.example";
    let source = ProductionJwksSource::new(vec![make_config(issuer)], fetcher).unwrap();

    assert!(source.get_snapshot(issuer).await.is_none());
}

#[tokio::test]
async fn get_snapshot_returns_none_on_parse_error() {
    let fetcher = FakeJwksFetcher {
        body: Err(JwksFetchError::ParseError),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    let issuer = "https://id.example";
    let source = ProductionJwksSource::new(vec![make_config(issuer)], fetcher).unwrap();

    assert!(source.get_snapshot(issuer).await.is_none());
}

#[tokio::test]
async fn parse_and_bound_rejects_empty_key_set() {
    let empty_jwks = r#"{"keys":[]}"#;
    let err = parse_and_bound_jwks(empty_jwks).unwrap_err();
    assert_eq!(err, JwksFetchError::KeyCountBoundsViolation);
}

#[tokio::test]
async fn parse_and_bound_rejects_oversized_key_set() {
    // Build MAX_JWKS_KEYS + 1 keys.
    let keys: Vec<String> = (0..=MAX_JWKS_KEYS)
        .map(|i| format!(
            r#"{{"kty":"EC","crv":"P-256","x":"f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU","y":"x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0","kid":"k{i}"}}"#
        ))
        .collect();
    let body = format!(r#"{{"keys":[{}]}}"#, keys.join(","));
    let err = parse_and_bound_jwks(&body).unwrap_err();
    assert_eq!(err, JwksFetchError::KeyCountBoundsViolation);
}

#[tokio::test]
async fn new_rejects_empty_configs() {
    let fetcher = FakeJwksFetcher {
        body: Ok(minimal_jwks_json("k1")),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    assert!(ProductionJwksSource::new(vec![], fetcher).is_none());
}

#[tokio::test]
async fn new_rejects_refresh_ge_hard_deadline() {
    let fetcher = FakeJwksFetcher {
        body: Ok(minimal_jwks_json("k1")),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    let bad_config = IssuerJwksConfig {
        issuer: "https://id.example".to_owned(),
        jwks_uri: "https://id.example/.well-known/jwks.json".to_owned(),
        refresh_interval_seconds: 3600, // equal to hard deadline
        key_snapshot_hard_deadline_seconds: 3600,
    };
    assert!(ProductionJwksSource::new(vec![bad_config], fetcher).is_none());
}

#[tokio::test]
async fn new_rejects_zero_refresh_interval() {
    let fetcher = FakeJwksFetcher {
        body: Ok(minimal_jwks_json("k1")),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    let bad_config = IssuerJwksConfig {
        issuer: "https://id.example".to_owned(),
        jwks_uri: "https://id.example/.well-known/jwks.json".to_owned(),
        refresh_interval_seconds: 0,
        key_snapshot_hard_deadline_seconds: 3600,
    };
    assert!(ProductionJwksSource::new(vec![bad_config], fetcher).is_none());
}

/// Issuer binding: the sealed `key_set()` synchronous path must return
/// `None` before any snapshot is warmed via `get_snapshot`.
#[tokio::test]
async fn sync_key_set_returns_none_before_warmup() {
    let fetcher = FakeJwksFetcher {
        body: Ok(minimal_jwks_json("k1")),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    let issuer = "https://id.example";
    let source = ProductionJwksSource::new(vec![make_config(issuer)], fetcher).unwrap();

    use crate::nip_fi::verifier::IssuerKeySource;
    assert!(
        source.key_set(issuer).is_none(),
        "cache is cold before get_snapshot"
    );
}

/// After a successful `get_snapshot`, the synchronous `key_set()` path must
/// return the same issuer's snapshot without re-fetching.
#[tokio::test]
async fn sync_key_set_returns_snapshot_after_warmup() {
    let fetcher = FakeJwksFetcher {
        body: Ok(minimal_jwks_json("k1")),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    let issuer = "https://id.example";
    let source = ProductionJwksSource::new(vec![make_config(issuer)], fetcher).unwrap();

    source.get_snapshot(issuer).await.unwrap();

    use crate::nip_fi::verifier::IssuerKeySource;
    let ks = source.key_set(issuer).unwrap();
    assert_eq!(ks.issuer(), issuer);
}
