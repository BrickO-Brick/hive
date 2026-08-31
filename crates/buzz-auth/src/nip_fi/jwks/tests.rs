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
    // Would resolve DNS and return NetworkError if validation ran after I/O.
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

/// `with_deadline` must fire before the outer guard when the inner future
/// never resolves. Removing the `tokio::time::timeout` inside `with_deadline`
/// leaves the future permanently pending — the outer guard fires and the test fails.
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

// ── Refresh permit / cancellation-safety ─────────────────────────────────────

/// Blocks until a oneshot releases it, signals an `entered` barrier on entry,
/// and returns `Ok(body)` or `Err` depending on the release value.
struct BlockingFetcher {
    /// Fires as soon as `fetch_jwks` is entered — gives tests a deterministic
    /// point to observe that the fetch is in progress before making assertions.
    entered_tx: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// Sending a body releases the fetch with success; dropping the sender
    /// causes an error.
    release_rx: std::sync::Mutex<Option<tokio::sync::oneshot::Receiver<String>>>,
    call_count: Arc<AtomicUsize>,
}

impl super::super::verifier::sealed::Sealed for BlockingFetcher {}

impl JwksFetcher for BlockingFetcher {
    fn fetch_jwks<'a>(
        &'a self,
        _uri: &'a str,
    ) -> impl std::future::Future<Output = Result<String, JwksFetchError>> + Send + 'a {
        self.call_count.fetch_add(1, Ordering::SeqCst);
        // Signal entry before any await so tests can observe it synchronously.
        if let Some(tx) = self.entered_tx.lock().unwrap().take() {
            let _ = tx.send(());
        }
        let rx = self.release_rx.lock().unwrap().take();
        async move {
            match rx {
                Some(r) => r.await.map_err(|_| JwksFetchError::NetworkError),
                None => Err(JwksFetchError::NetworkError),
            }
        }
    }
}

/// A second concurrent `get_snapshot` while the first fetch is in progress
/// must not start a second fetch — the permit blocks it.
///
/// Mutation: dropping the permit before the fetch completes allows the second
/// call to win a fresh permit and start its own fetch, producing call_count 2.
#[tokio::test]
async fn concurrent_refresh_coalesces_without_second_fetch() {
    let call_count = Arc::new(AtomicUsize::new(0));
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel::<()>();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<String>();
    let fetcher = BlockingFetcher {
        entered_tx: std::sync::Mutex::new(Some(entered_tx)),
        release_rx: std::sync::Mutex::new(Some(release_rx)),
        call_count: Arc::clone(&call_count),
    };
    let issuer = "https://id.example";
    let source = Arc::new(ProductionJwksSource::new(vec![make_config(issuer)], fetcher).unwrap());

    let source2 = Arc::clone(&source);
    let issuer_owned = issuer.to_owned();
    let first = tokio::spawn(async move { source2.get_snapshot(&issuer_owned).await });

    // Wait for the fetcher to confirm it has entered — the permit is held.
    entered_rx.await.unwrap();

    let second_result = source.get_snapshot(issuer).await;
    let count_after_second = call_count.load(Ordering::SeqCst);

    let _ = release_tx.send(minimal_jwks_json("k1"));
    let first_result = first.await.unwrap();

    assert!(first_result.is_some());
    assert!(
        second_result.is_none(),
        "second concurrent call must not start a second fetch"
    );
    assert_eq!(
        count_after_second, 1,
        "permit must coalesce concurrent callers"
    );
}

/// Aborting the first caller releases the RAII permit; the next call on the
/// same source can acquire it and fetch successfully.
///
/// Mutation: replacing the RAII permit with a manual boolean set only in the
/// success path leaves it true after abort; `get_snapshot` on the same source
/// returns None forever instead of fetching again.
#[tokio::test]
async fn aborted_first_caller_releases_permit_for_next_caller() {
    let call_count = Arc::new(AtomicUsize::new(0));

    // First call: blocks forever (we never send on this tx).
    let (entered_tx_1, entered_rx_1) = tokio::sync::oneshot::channel::<()>();
    let (_no_release_tx, no_release_rx) = tokio::sync::oneshot::channel::<String>();

    // Second call: succeeds immediately after permit is released.
    let (entered_tx_2, _entered_rx_2) = tokio::sync::oneshot::channel::<()>();
    let (release_tx_2, release_rx_2) = tokio::sync::oneshot::channel::<String>();

    // Use a shared Vec to hand out fetcher state across the two calls.
    // The first call gets `entered_tx_1` + `no_release_rx` (blocks).
    // The second call gets `entered_tx_2` + `release_rx_2` (succeeds).
    let entered_txs = Arc::new(std::sync::Mutex::new(vec![
        Some(entered_tx_2),
        Some(entered_tx_1),
    ]));
    let release_rxs = Arc::new(std::sync::Mutex::new(vec![
        Some(release_rx_2),
        Some(no_release_rx),
    ]));

    struct SequencedFetcher {
        entered_txs: Arc<std::sync::Mutex<Vec<Option<tokio::sync::oneshot::Sender<()>>>>>,
        release_rxs: Arc<std::sync::Mutex<Vec<Option<tokio::sync::oneshot::Receiver<String>>>>>,
        call_count: Arc<AtomicUsize>,
    }
    impl super::super::verifier::sealed::Sealed for SequencedFetcher {}
    impl JwksFetcher for SequencedFetcher {
        fn fetch_jwks<'a>(
            &'a self,
            _uri: &'a str,
        ) -> impl std::future::Future<Output = Result<String, JwksFetchError>> + Send + 'a {
            self.call_count.fetch_add(1, Ordering::SeqCst);
            let entered = self.entered_txs.lock().unwrap().pop().flatten();
            let rx = self.release_rxs.lock().unwrap().pop().flatten();
            if let Some(tx) = entered {
                let _ = tx.send(());
            }
            async move {
                match rx {
                    Some(r) => r.await.map_err(|_| JwksFetchError::NetworkError),
                    None => Err(JwksFetchError::NetworkError),
                }
            }
        }
    }

    let issuer = "https://id.example";
    let source = Arc::new(
        ProductionJwksSource::new(
            vec![make_config(issuer)],
            SequencedFetcher {
                entered_txs: Arc::clone(&entered_txs),
                release_rxs: Arc::clone(&release_rxs),
                call_count: Arc::clone(&call_count),
            },
        )
        .unwrap(),
    );

    // First call: enters the fetch then is aborted.
    {
        let source2 = Arc::clone(&source);
        let issuer_owned = issuer.to_owned();
        let first = tokio::spawn(async move { source2.get_snapshot(&issuer_owned).await });
        entered_rx_1.await.unwrap(); // confirmed inside the blocking fetch
        first.abort();
        let _ = first.await; // join to confirm abort completed
    }

    // The permit must now be released; the second call on the same source should succeed.
    release_tx_2.send(minimal_jwks_json("k2")).unwrap();
    let result = source.get_snapshot(issuer).await;
    assert!(
        result.is_some(),
        "second call on same source must succeed after permit is released"
    );
    assert_eq!(
        call_count.load(Ordering::SeqCst),
        2,
        "must have fetched twice"
    );
}

// ── Central fail-closed and issuer-isolation invariants ───────────────────────

/// An expired snapshot must never be served — both `get_snapshot` and the
/// synchronous `key_set` path return `None` after the hard deadline passes.
#[tokio::test]
async fn expired_snapshot_never_served_after_hard_deadline() {
    let issuer = "https://id.example";
    let config = IssuerJwksConfig {
        issuer: issuer.to_owned(),
        jwks_uri: format!("https://id.example/.well-known/jwks.json"),
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

/// Two issuers are fully isolated: distinct key sets, independent generation
/// counters. Advancing only issuer A's document must not change issuer B.
#[tokio::test]
async fn two_issuer_keys_and_generations_are_isolated() {
    let issuer_a = "https://a.example";
    let issuer_b = "https://b.example";

    let a_bodies = Arc::new(std::sync::Mutex::new(vec![
        Ok::<String, JwksFetchError>(minimal_jwks_json("a2")),
        Ok(minimal_jwks_json("a1")),
    ]));
    let b_body = minimal_jwks_json("b1");

    struct IsolationFetcher {
        a_bodies: Arc<std::sync::Mutex<Vec<Result<String, JwksFetchError>>>>,
        b_body: String,
    }
    impl super::super::verifier::sealed::Sealed for IsolationFetcher {}
    impl JwksFetcher for IsolationFetcher {
        fn fetch_jwks<'a>(
            &'a self,
            uri: &'a str,
        ) -> impl std::future::Future<Output = Result<String, JwksFetchError>> + Send + 'a {
            let result = if uri.contains("a.example") {
                self.a_bodies
                    .lock()
                    .unwrap()
                    .pop()
                    .unwrap_or(Err(JwksFetchError::NetworkError))
            } else {
                Ok(self.b_body.clone())
            };
            async move { result }
        }
    }

    let config_a = IssuerJwksConfig {
        issuer: issuer_a.to_owned(),
        jwks_uri: "https://a.example/.well-known/jwks.json".to_owned(),
        refresh_interval_seconds: 1,
        key_snapshot_hard_deadline_seconds: 3600,
    };
    let config_b = IssuerJwksConfig {
        issuer: issuer_b.to_owned(),
        jwks_uri: "https://b.example/.well-known/jwks.json".to_owned(),
        refresh_interval_seconds: 1,
        key_snapshot_hard_deadline_seconds: 3600,
    };

    let source = ProductionJwksSource::new(
        vec![config_a, config_b],
        IsolationFetcher {
            a_bodies: Arc::clone(&a_bodies),
            b_body,
        },
    )
    .unwrap();

    use crate::nip_fi::verifier::IssuerKeySource;

    source.get_snapshot(issuer_a).await.unwrap();
    source.get_snapshot(issuer_b).await.unwrap();

    let gen_a1 = source.key_set(issuer_a).unwrap().generation();
    let gen_b1 = source.key_set(issuer_b).unwrap().generation();

    assert_eq!(source.key_set(issuer_a).unwrap().issuer(), issuer_a);
    assert_eq!(source.key_set(issuer_b).unwrap().issuer(), issuer_b);

    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    source.get_snapshot(issuer_a).await.unwrap();
    source.get_snapshot(issuer_b).await.unwrap();

    let gen_a2 = source.key_set(issuer_a).unwrap().generation();
    let gen_b2 = source.key_set(issuer_b).unwrap().generation();

    assert!(
        gen_a2 > gen_a1,
        "issuer A generation must advance after its document changes"
    );
    assert_eq!(
        gen_b2, gen_b1,
        "issuer B generation must not change when only A's document changed"
    );

    assert_eq!(source.key_set(issuer_a).unwrap().issuer(), issuer_a);
    assert_eq!(source.key_set(issuer_b).unwrap().issuer(), issuer_b);
}
