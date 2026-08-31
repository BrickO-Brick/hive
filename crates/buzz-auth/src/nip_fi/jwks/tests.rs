use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

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

fn make_config_with_uri(issuer: &str, jwks_uri: &str) -> IssuerJwksConfig {
    IssuerJwksConfig {
        issuer: issuer.to_owned(),
        jwks_uri: jwks_uri.to_owned(),
        refresh_interval_seconds: 300,
        key_snapshot_hard_deadline_seconds: 3600,
    }
}

#[tokio::test]
async fn get_snapshot_returns_sealed_key_set_on_success() {
    let issuer = "https://id.example";
    let fetcher = FakeJwksFetcher {
        body: Ok(minimal_jwks_json("k1")),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    let source = ProductionJwksSource::new(vec![make_config(issuer)], fetcher).unwrap();

    let ks = source.get_snapshot(issuer).await.unwrap();
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

    assert!(source.get_snapshot("https://other.example").await.is_none());
}

#[tokio::test]
async fn get_snapshot_returns_none_on_network_error_with_no_cache() {
    let fetcher = FakeJwksFetcher {
        body: Err(JwksFetchError::NetworkError),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    let issuer = "https://id.example";
    let source = ProductionJwksSource::new(vec![make_config(issuer)], fetcher).unwrap();

    assert!(source.get_snapshot(issuer).await.is_none());
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
    let err = parse_and_bound_jwks(r#"{"keys":[]}"#).unwrap_err();
    assert_eq!(err, JwksFetchError::KeyCountBoundsViolation);
}

#[tokio::test]
async fn parse_and_bound_rejects_oversized_key_set() {
    let keys: Vec<String> = (0..=MAX_JWKS_KEYS)
        .map(|i| format!(
            r#"{{"kty":"EC","crv":"P-256","x":"f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU","y":"x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0","kid":"k{i}"}}"#
        ))
        .collect();
    let body = format!(r#"{{"keys":[{}]}}"#, keys.join(","));
    assert_eq!(
        parse_and_bound_jwks(&body).unwrap_err(),
        JwksFetchError::KeyCountBoundsViolation
    );
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
        refresh_interval_seconds: 3600,
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

#[tokio::test]
async fn new_rejects_timing_above_maximum() {
    let fetcher = FakeJwksFetcher {
        body: Ok(minimal_jwks_json("k1")),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    let bad_config = IssuerJwksConfig {
        issuer: "https://id.example".to_owned(),
        jwks_uri: "https://id.example/.well-known/jwks.json".to_owned(),
        refresh_interval_seconds: MAX_JWKS_TIMING_SECONDS + 1,
        key_snapshot_hard_deadline_seconds: MAX_JWKS_TIMING_SECONDS + 2,
    };
    assert!(ProductionJwksSource::new(vec![bad_config], fetcher).is_none());
}

#[tokio::test]
async fn new_rejects_duplicate_issuer() {
    let fetcher = FakeJwksFetcher {
        body: Ok(minimal_jwks_json("k1")),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    let issuer = "https://id.example";
    let config_a = IssuerJwksConfig {
        issuer: issuer.to_owned(),
        jwks_uri: "https://id.example/.well-known/jwks.json".to_owned(),
        refresh_interval_seconds: 300,
        key_snapshot_hard_deadline_seconds: 3600,
    };
    let config_b = IssuerJwksConfig {
        issuer: issuer.to_owned(),
        jwks_uri: "https://id.example/.well-known/jwks-alt.json".to_owned(),
        refresh_interval_seconds: 600,
        key_snapshot_hard_deadline_seconds: 7200,
    };
    assert!(ProductionJwksSource::new(vec![config_a, config_b], fetcher).is_none());
}

#[tokio::test]
async fn new_rejects_non_https_jwks_uri() {
    let fetcher = FakeJwksFetcher {
        body: Ok(minimal_jwks_json("k1")),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    assert!(ProductionJwksSource::new(
        vec![make_config_with_uri(
            "https://id.example",
            "http://id.example/.well-known/jwks.json"
        )],
        fetcher
    )
    .is_none());
}

#[tokio::test]
async fn new_rejects_loopback_jwks_uri() {
    let fetcher = FakeJwksFetcher {
        body: Ok(minimal_jwks_json("k1")),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    assert!(ProductionJwksSource::new(
        vec![make_config_with_uri(
            "https://id.example",
            "https://127.0.0.1/.well-known/jwks.json"
        )],
        fetcher
    )
    .is_none());
}

#[tokio::test]
async fn new_rejects_private_ip_jwks_uri() {
    let fetcher = FakeJwksFetcher {
        body: Ok(minimal_jwks_json("k1")),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    assert!(ProductionJwksSource::new(
        vec![make_config_with_uri(
            "https://id.example",
            "https://10.0.0.1/.well-known/jwks.json"
        )],
        fetcher
    )
    .is_none());
}

#[tokio::test]
async fn new_rejects_jwks_uri_with_credentials() {
    let fetcher = FakeJwksFetcher {
        body: Ok(minimal_jwks_json("k1")),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    assert!(ProductionJwksSource::new(
        vec![make_config_with_uri(
            "https://id.example",
            "https://user:pass@id.example/.well-known/jwks.json"
        )],
        fetcher
    )
    .is_none());
}

#[tokio::test]
async fn new_rejects_jwks_uri_with_fragment() {
    let fetcher = FakeJwksFetcher {
        body: Ok(minimal_jwks_json("k1")),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    assert!(ProductionJwksSource::new(
        vec![make_config_with_uri(
            "https://id.example",
            "https://id.example/.well-known/jwks.json#keys"
        )],
        fetcher
    )
    .is_none());
}

/// `key_set()` fails closed (returns `None`) before any snapshot is warmed via
/// `get_snapshot` — the synchronous path never fetches.
#[tokio::test]
async fn sync_key_set_returns_none_before_warmup() {
    let fetcher = FakeJwksFetcher {
        body: Ok(minimal_jwks_json("k1")),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    let issuer = "https://id.example";
    let source = ProductionJwksSource::new(vec![make_config(issuer)], fetcher).unwrap();

    use crate::nip_fi::verifier::IssuerKeySource;
    assert!(source.key_set(issuer).is_none());
}

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

/// Identical document fetched twice must not advance the generation counter
/// — stable generation for unchanged JWKS prevents spurious revalidation.
#[tokio::test]
async fn generation_stable_for_identical_document() {
    let issuer = "https://id.example";
    let fetcher = FakeJwksFetcher {
        body: Ok(minimal_jwks_json("k1")),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    let config = IssuerJwksConfig {
        issuer: issuer.to_owned(),
        jwks_uri: format!("https://{issuer}/.well-known/jwks.json"),
        refresh_interval_seconds: 1,
        key_snapshot_hard_deadline_seconds: 3600,
    };
    let source = ProductionJwksSource::new(vec![config], fetcher).unwrap();

    use crate::nip_fi::verifier::IssuerKeySource;
    source.get_snapshot(issuer).await.unwrap();
    let gen1 = source.key_set(issuer).unwrap().generation();

    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    source.get_snapshot(issuer).await.unwrap();
    let gen2 = source.key_set(issuer).unwrap().generation();

    assert_eq!(gen1, gen2);
}

/// Changed document must advance the generation so key-rotation events are
/// visible [FI-TRACE-JWKS-ADD/REMOVE].
#[tokio::test]
async fn generation_advances_for_changed_document() {
    let issuer = "https://id.example";

    let bodies = Arc::new(std::sync::Mutex::new(vec![
        Ok::<String, JwksFetchError>(minimal_jwks_json("k2")),
        Ok(minimal_jwks_json("k1")),
    ]));

    struct MultiBodyFetcher {
        bodies: Arc<std::sync::Mutex<Vec<Result<String, JwksFetchError>>>>,
    }
    impl super::super::verifier::sealed::Sealed for MultiBodyFetcher {}
    impl JwksFetcher for MultiBodyFetcher {
        fn fetch_jwks<'a>(
            &'a self,
            _uri: &'a str,
        ) -> impl std::future::Future<Output = Result<String, JwksFetchError>> + Send + 'a {
            let result = self
                .bodies
                .lock()
                .unwrap()
                .pop()
                .unwrap_or(Err(JwksFetchError::NetworkError));
            async move { result }
        }
    }

    let config = IssuerJwksConfig {
        issuer: issuer.to_owned(),
        jwks_uri: format!("https://{issuer}/.well-known/jwks.json"),
        refresh_interval_seconds: 1,
        key_snapshot_hard_deadline_seconds: 3600,
    };
    let source = ProductionJwksSource::new(vec![config], MultiBodyFetcher { bodies }).unwrap();

    use crate::nip_fi::verifier::IssuerKeySource;
    source.get_snapshot(issuer).await.unwrap();
    let gen1 = source.key_set(issuer).unwrap().generation();

    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    source.get_snapshot(issuer).await.unwrap();
    let gen2 = source.key_set(issuer).unwrap().generation();

    assert!(gen2 > gen1, "gen1={gen1}, gen2={gen2}");
}

#[test]
fn validate_uri_accepts_valid_https() {
    assert!(validate_jwks_uri("https://id.example/.well-known/jwks.json").is_ok());
}

#[test]
fn validate_uri_rejects_http() {
    assert_eq!(
        validate_jwks_uri("http://id.example/.well-known/jwks.json").unwrap_err(),
        JwksFetchError::InvalidUri
    );
}

#[test]
fn validate_uri_rejects_loopback_ip() {
    assert_eq!(
        validate_jwks_uri("https://127.0.0.1/jwks.json").unwrap_err(),
        JwksFetchError::InvalidUri
    );
}

#[test]
fn validate_uri_rejects_private_ip() {
    assert_eq!(
        validate_jwks_uri("https://192.168.1.1/jwks.json").unwrap_err(),
        JwksFetchError::InvalidUri
    );
}

#[test]
fn validate_uri_rejects_link_local_ip() {
    assert_eq!(
        validate_jwks_uri("https://169.254.169.254/jwks.json").unwrap_err(),
        JwksFetchError::InvalidUri
    );
}

#[test]
fn validate_uri_rejects_credentials() {
    assert_eq!(
        validate_jwks_uri("https://user:pass@id.example/jwks.json").unwrap_err(),
        JwksFetchError::InvalidUri
    );
}

#[test]
fn validate_uri_rejects_fragment() {
    assert_eq!(
        validate_jwks_uri("https://id.example/jwks.json#section").unwrap_err(),
        JwksFetchError::InvalidUri
    );
}

#[test]
fn validate_uri_rejects_unparseable() {
    assert_eq!(
        validate_jwks_uri("not a url").unwrap_err(),
        JwksFetchError::InvalidUri
    );
}
