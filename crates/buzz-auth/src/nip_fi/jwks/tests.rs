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
fn validate_uri_accepts_public_ipv6() {
    assert!(validate_jwks_uri("https://[2606:4700::1]/.well-known/jwks.json").is_ok());
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

#[tokio::test]
async fn http_fetcher_rejects_http_uri_before_connection() {
    let fetcher = HttpJwksFetcher::new();
    let err = fetcher
        .fetch_jwks("http://id.example/.well-known/jwks.json")
        .await
        .unwrap_err();
    assert_eq!(err, JwksFetchError::InvalidUri);
}

#[tokio::test]
async fn http_fetcher_rejects_credentials_uri_before_connection() {
    let fetcher = HttpJwksFetcher::new();
    let err = fetcher
        .fetch_jwks("https://user:pass@id.example/.well-known/jwks.json")
        .await
        .unwrap_err();
    assert_eq!(err, JwksFetchError::InvalidUri);
}

#[tokio::test]
async fn http_fetcher_rejects_fragment_uri_before_connection() {
    let fetcher = HttpJwksFetcher::new();
    let err = fetcher
        .fetch_jwks("https://id.example/.well-known/jwks.json#section")
        .await
        .unwrap_err();
    assert_eq!(err, JwksFetchError::InvalidUri);
}

#[tokio::test]
async fn http_fetcher_rejects_private_ip_uri_before_connection() {
    let fetcher = HttpJwksFetcher::new();
    let err = fetcher
        .fetch_jwks("https://10.0.0.1/.well-known/jwks.json")
        .await
        .unwrap_err();
    assert_eq!(err, JwksFetchError::InvalidUri);
}

#[tokio::test]
async fn resolve_ssrf_rejects_ipv6_loopback_fast_path() {
    let err = super::resolve_and_check_ssrf("::1", 443).await.unwrap_err();
    assert_eq!(err, JwksFetchError::InvalidUri);
}

#[tokio::test]
async fn resolve_ssrf_accepts_public_ipv6_fast_path() {
    let ip = super::resolve_and_check_ssrf("2606:4700::1", 443)
        .await
        .unwrap();
    assert_eq!(ip, "2606:4700::1".parse::<std::net::IpAddr>().unwrap());
}

/// `with_deadline` fires before the outer guard: removing `tokio::time::timeout`
/// inside `with_deadline` leaves the pending future unresolved and the outer guard fires.
#[tokio::test(start_paused = true)]
async fn with_deadline_fires_before_outer_guard() {
    let inner = super::with_deadline(
        std::future::pending::<Result<String, JwksFetchError>>(),
        std::time::Duration::ZERO,
    );
    let result = tokio::time::timeout(std::time::Duration::from_secs(1), inner).await;
    assert_eq!(
        result.expect("outer guard fired — with_deadline timeout seam missing"),
        Err(JwksFetchError::NetworkError),
    );
}

// A fetcher whose per-call behaviour is scripted by an explicit sequence of steps.
// Each call pops the next step: signals `entered` on entry, then blocks until
// its release channel resolves.
struct FetchStep {
    entered: tokio::sync::oneshot::Sender<()>,
    release: tokio::sync::oneshot::Receiver<String>,
}

struct ScriptedFetcher {
    steps: std::sync::Mutex<std::collections::VecDeque<FetchStep>>,
    call_count: Arc<AtomicUsize>,
}

impl super::super::verifier::sealed::Sealed for ScriptedFetcher {}

impl JwksFetcher for ScriptedFetcher {
    fn fetch_jwks<'a>(
        &'a self,
        _uri: &'a str,
    ) -> impl std::future::Future<Output = Result<String, JwksFetchError>> + Send + 'a {
        self.call_count.fetch_add(1, Ordering::SeqCst);
        let step = self.steps.lock().unwrap().pop_front();
        async move {
            match step {
                Some(FetchStep { entered, release }) => {
                    let _ = entered.send(());
                    release.await.map_err(|_| JwksFetchError::NetworkError)
                }
                None => Err(JwksFetchError::NetworkError),
            }
        }
    }
}

fn script(steps: impl IntoIterator<Item = FetchStep>) -> ScriptedFetcher {
    ScriptedFetcher {
        steps: std::sync::Mutex::new(steps.into_iter().collect()),
        call_count: Arc::new(AtomicUsize::new(0)),
    }
}

fn pending_step() -> (
    FetchStep,
    tokio::sync::oneshot::Receiver<()>,
    tokio::sync::oneshot::Sender<String>,
) {
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<String>();
    // release_tx is returned to the caller; the fetch future is genuinely
    // pending until the caller drops or sends it — not resolved immediately.
    (
        FetchStep {
            entered: entered_tx,
            release: release_rx,
        },
        entered_rx,
        release_tx,
    )
}

fn ready_step(body: String) -> (FetchStep, tokio::sync::oneshot::Receiver<()>) {
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<String>();
    let _ = release_tx.send(body);
    (
        FetchStep {
            entered: entered_tx,
            release: release_rx,
        },
        entered_rx,
    )
}

fn blocking_step() -> (
    FetchStep,
    tokio::sync::oneshot::Receiver<()>,
    tokio::sync::oneshot::Sender<String>,
) {
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<String>();
    (
        FetchStep {
            entered: entered_tx,
            release: release_rx,
        },
        entered_rx,
        release_tx,
    )
}

/// A second concurrent `get_snapshot` while the first fetch is in progress must
/// not start a second fetch — the RAII permit coalesces callers.
#[tokio::test]
async fn concurrent_refresh_coalesces_without_second_fetch() {
    let (step, entered_rx, release_tx) = blocking_step();
    let fetcher = script([step]);
    let call_count = Arc::clone(&fetcher.call_count);

    let issuer = "https://id.example";
    let source = Arc::new(ProductionJwksSource::new(vec![make_config(issuer)], fetcher).unwrap());

    let source2 = Arc::clone(&source);
    let issuer_owned = issuer.to_owned();
    let first = tokio::spawn(async move { source2.get_snapshot(&issuer_owned).await });

    entered_rx.await.unwrap(); // first fetch holds the permit

    let second_result = source.get_snapshot(issuer).await;
    let count_after_second = call_count.load(Ordering::SeqCst);

    let _ = release_tx.send(minimal_jwks_json("k1"));
    let first_result = first.await.unwrap();

    assert!(first_result.is_some());
    assert!(second_result.is_none());
    assert_eq!(count_after_second, 1);
}

/// Aborting the first caller releases the RAII permit; the next call on the same
/// source fetches and succeeds. A manual boolean cleared only on success would
/// leave the permit poisoned.
#[tokio::test]
async fn aborted_first_caller_releases_permit_for_next_caller() {
    let (step1, entered_rx_1, _release_tx_1) = pending_step();
    let (step2, _entered_rx_2) = ready_step(minimal_jwks_json("k2"));

    let fetcher = script([step1, step2]);
    let call_count = Arc::clone(&fetcher.call_count);

    let issuer = "https://id.example";
    let source = Arc::new(ProductionJwksSource::new(vec![make_config(issuer)], fetcher).unwrap());

    {
        let source2 = Arc::clone(&source);
        let issuer_owned = issuer.to_owned();
        let first = tokio::spawn(async move { source2.get_snapshot(&issuer_owned).await });
        entered_rx_1.await.unwrap();
        first.abort();
        let _ = first.await;
        // _release_tx_1 drops here: the fetch future was blocked on an open
        // receiver when abort fired — not resolved via an error path.
    }

    let result = source.get_snapshot(issuer).await;
    assert!(result.is_some());
    assert_eq!(call_count.load(Ordering::SeqCst), 2);
}

/// An expired snapshot must never be served — both `get_snapshot` and the
/// synchronous `key_set` path return `None` after the hard deadline passes.
#[tokio::test]
async fn expired_snapshot_never_served_after_hard_deadline() {
    let issuer = "https://id.example";
    let config = IssuerJwksConfig {
        issuer: issuer.to_owned(),
        jwks_uri: "https://id.example/.well-known/jwks.json".to_owned(),
        refresh_interval_seconds: 1,
        key_snapshot_hard_deadline_seconds: 2,
    };
    let bodies = Arc::new(std::sync::Mutex::new(vec![
        Err::<String, JwksFetchError>(JwksFetchError::NetworkError),
        Ok(minimal_jwks_json("k1")),
    ]));
    struct FailAfterFirstFetcher {
        bodies: Arc<std::sync::Mutex<Vec<Result<String, JwksFetchError>>>>,
    }
    impl super::super::verifier::sealed::Sealed for FailAfterFirstFetcher {}
    impl JwksFetcher for FailAfterFirstFetcher {
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
    let source = ProductionJwksSource::new(vec![config], FailAfterFirstFetcher { bodies }).unwrap();

    assert!(
        source.get_snapshot(issuer).await.is_some(),
        "initial fetch must succeed"
    );

    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    assert!(
        source.get_snapshot(issuer).await.is_none(),
        "expired snapshot must not be served after hard deadline"
    );

    use crate::nip_fi::verifier::IssuerKeySource;
    assert!(
        source.key_set(issuer).is_none(),
        "key_set must not serve an expired snapshot"
    );
}

/// Two issuers are fully isolated: distinct key material, independent generation
/// counters, no cross-issuer forgery. Three distinct P-256 keypairs (A1, A2,
/// B1) driven through `ProductionJwksSource` into `FederatedAssertionVerifier`.
#[tokio::test]
async fn two_issuer_keys_and_generations_are_isolated() {
    use crate::nip_fi::{
        FederatedAssertionVerifier, FreshnessClass, IssuerPolicy, IssuerRegistry, TokenClass,
    };
    use jsonwebtoken::{Algorithm, EncodingKey, Header};
    use serde_json::json;

    // Three genuinely distinct P-256 keypairs (PKCS#8 PEM + public JWK coords).
    const PKCS8_A1: &str = "-----BEGIN PRIVATE KEY-----\n\
        MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgcnxDM4EiirH9dHUE\n\
        WZc759TX4s5PAn8kO5ovXSnGxCWhRANCAARFb6ZnsfkqOOXyEhj3KBQphGKF4vTa\n\
        zhebbavbZ1ZoklqkF1cGg+jTO7rONAVEzXvXUWtV6CdDV+rybiVmFP2w\n\
        -----END PRIVATE KEY-----\n";
    const X_A1: &str = "RW-mZ7H5Kjjl8hIY9ygUKYRiheL02s4Xm22r22dWaJI";
    const Y_A1: &str = "WqQXVwaD6NM7us40BUTNe9dRa1XoJ0NX6vJuJWYU_bA";

    const PKCS8_A2: &str = "-----BEGIN PRIVATE KEY-----\n\
        MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgMKMRn6EQMn67Z6tu\n\
        DbUTZWzrQpbRRTL3SJSMSd+EDG2hRANCAATGgMYxftLlZ11AIANHcr0b13pWkaLy\n\
        lkOeBZRG0bBMoUesLN7EdVYhtzcrCeNJh031QuO+UDWcwOmShbeR43x6\n\
        -----END PRIVATE KEY-----\n";
    const X_A2: &str = "xoDGMX7S5WddQCADR3K9G9d6VpGi8pZDngWURtGwTKE";
    const Y_A2: &str = "R6ws3sR1ViG3NysJ40mHTfVC475QNZzA6ZKFt5HjfHo";

    const PKCS8_B1: &str = "-----BEGIN PRIVATE KEY-----\n\
        MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgKcmDf3+zDWyC96/X\n\
        Gv8aYK552uF5aE6nXKzxAfl4fSWhRANCAATf0ccbp1c4mMd6WvSuliv5ZAS8iIWL\n\
        Ne2tqOfFa0hRpa41DANab1/EuDGi7PtIo8xSYwkaoib1MAJlfLvRMjQA\n\
        -----END PRIVATE KEY-----\n";
    const X_B1: &str = "39HHG6dXOJjHelr0rpYr-WQEvIiFizXtrajnxWtIUaU";
    const Y_B1: &str = "rjUMA1pvX8S4MaLs-0ijzFJjCRqiJvUwAmV8u9EyNAA";

    const KID_A1: &str = "a-key-1";
    const KID_A2: &str = "a-key-2";
    const KID_B1: &str = "b-key-1";

    let issuer_a = "https://a.example";
    let issuer_b = "https://b.example";
    let audience = "https://relay.example";

    fn jwks_str(kid: &str, x: &str, y: &str) -> String {
        format!(
            r#"{{"keys":[{{"kty":"EC","crv":"P-256","use":"sig","alg":"ES256","kid":"{kid}","x":"{x}","y":"{y}"}}]}}"#
        )
    }

    fn sign(pkcs8_pem: &str, kid: &str, iss: &str, aud: &str) -> String {
        let now = chrono::Utc::now().timestamp();
        let claims = json!({"iss": iss, "aud": aud, "sub": "u",
                            "iat": now, "exp": now + 600});
        let mut hdr = Header::new(Algorithm::ES256);
        hdr.kid = Some(kid.to_owned());
        hdr.typ = Some("nip-fi+jwt".to_owned());
        let key = EncodingKey::from_ec_pem(pkcs8_pem.as_bytes()).expect("valid EC PEM");
        jsonwebtoken::encode(&hdr, &claims, &key).expect("sign")
    }

    fn policy(issuer: &str, aud: &str) -> IssuerPolicy {
        IssuerPolicy::new(
            issuer.to_owned(),
            vec![aud.to_owned()],
            TokenClass::DedicatedNipFi,
            FreshnessClass::OfflineJwt,
            vec![Algorithm::ES256],
            false,
            60,
            3600,
            None,
        )
        .expect("valid policy")
    }

    fn configs(issuer_a: &str, issuer_b: &str) -> (IssuerJwksConfig, IssuerJwksConfig) {
        (
            IssuerJwksConfig {
                issuer: issuer_a.to_owned(),
                jwks_uri: "https://a.example/.well-known/jwks.json".to_owned(),
                refresh_interval_seconds: 1,
                key_snapshot_hard_deadline_seconds: 3600,
            },
            IssuerJwksConfig {
                issuer: issuer_b.to_owned(),
                jwks_uri: "https://b.example/.well-known/jwks.json".to_owned(),
                refresh_interval_seconds: 1,
                key_snapshot_hard_deadline_seconds: 3600,
            },
        )
    }

    struct TwoFetcher {
        a: std::sync::Mutex<std::collections::VecDeque<String>>,
        b: String,
    }
    impl super::super::verifier::sealed::Sealed for TwoFetcher {}
    impl JwksFetcher for TwoFetcher {
        fn fetch_jwks<'a>(
            &'a self,
            uri: &'a str,
        ) -> impl std::future::Future<Output = Result<String, JwksFetchError>> + Send + 'a {
            let result = if uri.contains("a.example") {
                self.a
                    .lock()
                    .unwrap()
                    .pop_front()
                    .map(Ok)
                    .unwrap_or(Err(JwksFetchError::NetworkError))
            } else {
                Ok(self.b.clone())
            };
            async move { result }
        }
    }

    let mut registry = IssuerRegistry::new();
    registry.insert(policy(issuer_a, audience));
    registry.insert(policy(issuer_b, audience));

    // Pre-rotation: source serves A1 and B1.
    let (cfg_a, cfg_b) = configs(issuer_a, issuer_b);
    let pre = ProductionJwksSource::new(
        vec![cfg_a, cfg_b],
        TwoFetcher {
            a: std::sync::Mutex::new([jwks_str(KID_A1, X_A1, Y_A1)].into()),
            b: jwks_str(KID_B1, X_B1, Y_B1),
        },
    )
    .unwrap();
    pre.get_snapshot(issuer_a).await.unwrap();
    pre.get_snapshot(issuer_b).await.unwrap();

    let v_pre = FederatedAssertionVerifier::new(registry.clone(), pre);
    v_pre
        .verify(&sign(PKCS8_A1, KID_A1, issuer_a, audience))
        .expect("A1 token must verify pre-rotation");
    v_pre
        .verify(&sign(PKCS8_B1, KID_B1, issuer_b, audience))
        .expect("B1 token must verify pre-rotation");
    v_pre
        .verify(&sign(PKCS8_B1, KID_A1, issuer_a, audience))
        .expect_err("B1 key must not forge issuer A");

    // Post-rotation: fresh source, A rotates A1→A2, B unchanged.
    let (cfg_a2, cfg_b2) = configs(issuer_a, issuer_b);
    let post = ProductionJwksSource::new(
        vec![cfg_a2, cfg_b2],
        TwoFetcher {
            a: std::sync::Mutex::new(
                [jwks_str(KID_A1, X_A1, Y_A1), jwks_str(KID_A2, X_A2, Y_A2)].into(),
            ),
            b: jwks_str(KID_B1, X_B1, Y_B1),
        },
    )
    .unwrap();
    post.get_snapshot(issuer_a).await.unwrap();
    post.get_snapshot(issuer_b).await.unwrap();

    use crate::nip_fi::verifier::IssuerKeySource;
    let gen_a_pre = post.key_set(issuer_a).unwrap().generation();
    let gen_b_stable = post.key_set(issuer_b).unwrap().generation();

    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    post.get_snapshot(issuer_a).await.unwrap();

    let gen_a_post = post.key_set(issuer_a).unwrap().generation();
    let gen_b_post = post.key_set(issuer_b).unwrap().generation();
    assert!(
        gen_a_post > gen_a_pre,
        "A generation must advance after rotation"
    );
    assert_eq!(
        gen_b_post, gen_b_stable,
        "B generation must not advance when only A rotates"
    );

    let v_post = FederatedAssertionVerifier::new(registry, post);
    v_post
        .verify(&sign(PKCS8_A2, KID_A2, issuer_a, audience))
        .expect("A2 token must verify post-rotation");
    v_post
        .verify(&sign(PKCS8_A1, KID_A1, issuer_a, audience))
        .expect_err("old A1 token must fail after A2 rotation");
    v_post
        .verify(&sign(PKCS8_B1, KID_A1, issuer_a, audience))
        .expect_err("B1 key must not forge issuer A post-rotation");
    v_post
        .verify(&sign(PKCS8_B1, KID_B1, issuer_b, audience))
        .expect("B1 token must still verify post-rotation");
}
