//! JWKS discovery, snapshot caching, and the production [`IssuerKeySource`]
//! implementation (NIP-FI Phase A, PR 3).
//!
//! ## Design invariants
//!
//! - **Issuer binding is sealed.** [`ProductionJwksSource`] builds each
//!   [`AssertionKeySet`] using the crate-private constructor and stores it
//!   keyed by the exact `iss` it authenticates. A caller cannot relabel one
//!   issuer's JWKS as another's — the cross-issuer bypass is closed at both
//!   the request seam (the verifier re-checks `iss`) and here.
//!
//! - **No stale-key fallback.** On fetch error the source returns the current
//!   snapshot if it is within its hard deadline, or `None`. It never serves
//!   an expired snapshot. [FI-TRACE-JWKS-REMOVE]
//!
//! - **Bounded resource acquisition.** The HTTP response is capped at
//!   [`MAX_JWKS_RESPONSE_BYTES`] before parsing. Key count is bounded by
//!   [`super::config::MAX_JWKS_KEYS`] inside [`AssertionKeySet::new`].
//!
//! - **Coalesced refresh.** A single in-flight refresh per issuer prevents
//!   thundering-herd. Concurrent callers observe the snapshot just after the
//!   racing refresh commits.
//!
//! - **No secrets or key material in errors or logs.** [`JwksFetchError`]
//!   carries only non-sensitive diagnostic codes.

use super::config::MAX_JWKS_KEYS;
use super::verifier::{AssertionKeySet, IssuerKeySource};
use chrono::{DateTime, Duration, Utc};
use jsonwebtoken::jwk::JwkSet;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use tracing::warn;

/// Maximum HTTP response size for a JWKS endpoint, in bytes. Bounded before
/// parsing to prevent a large or malicious response from consuming unbounded
/// memory during deserialization.
pub const MAX_JWKS_RESPONSE_BYTES: usize = 512 * 1024; // 512 KiB

/// A JWKS snapshot with its fetch time and configured hard deadline.
#[derive(Clone)]
struct CachedSnapshot {
    key_set: AssertionKeySet,
    fetched_at: DateTime<Utc>,
    hard_deadline: DateTime<Utc>,
}

/// Per-issuer runtime state: the current snapshot and in-flight flag.
struct IssuerState {
    snapshot: Option<CachedSnapshot>,
    /// True while a refresh task owns the fetch. Prevents concurrent fetches.
    refresh_in_flight: bool,
}

impl IssuerState {
    fn new() -> Self {
        Self {
            snapshot: None,
            refresh_in_flight: false,
        }
    }
}

/// Configuration for one issuer's JWKS endpoint.
#[derive(Debug, Clone)]
pub struct IssuerJwksConfig {
    /// The exact `iss` value this config authenticates. Must match the
    /// configured [`IssuerPolicy`][super::config::IssuerPolicy] exactly.
    pub issuer: String,
    /// The HTTPS JWKS endpoint URI.
    pub jwks_uri: String,
    /// How long a cached snapshot remains fresh before re-fetching is
    /// triggered, in seconds. Must be positive and less than
    /// `key_snapshot_hard_deadline_seconds`.
    pub refresh_interval_seconds: u64,
    /// Hard upper bound from fetch time on how long a snapshot may be served.
    /// A snapshot whose deadline has passed is never returned, even on error.
    /// Folds into every `AssertionKeySet` hard deadline and therefore into
    /// every `VerifiedAssertion.revalidation_dependencies`.
    pub key_snapshot_hard_deadline_seconds: u64,
}

/// Why a JWKS fetch or parse operation failed. No key material, issuer URLs,
/// or raw response content appear in these variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum JwksFetchError {
    /// The HTTP response exceeded [`MAX_JWKS_RESPONSE_BYTES`].
    #[error("JWKS response exceeded size limit")]
    ResponseTooLarge,
    /// The HTTP request failed (network, TLS, timeout).
    #[error("JWKS HTTP request failed")]
    NetworkError,
    /// The response body was not parseable as a JWK Set.
    #[error("JWKS response was not parseable")]
    ParseError,
    /// The parsed key set was empty or exceeded the key-count bound.
    #[error("JWKS key set bounds violation")]
    KeyCountBoundsViolation,
}

/// Async HTTP fetch of a JWKS endpoint.
///
/// This is a sealed injection seam: only types inside `buzz_auth` may
/// implement it (the private supertrait `sealed` prevents external impls).
/// The production implementation uses `reqwest`; the test implementation
/// returns hard-coded bodies without network calls.
///
/// Implementations MUST enforce [`MAX_JWKS_RESPONSE_BYTES`].
pub trait JwksFetcher: super::verifier::sealed::Sealed + Send + Sync + 'static {
    /// Fetch the JWK Set from the given URI, returning the raw JSON body.
    fn fetch_jwks<'a>(
        &'a self,
        uri: &'a str,
    ) -> impl std::future::Future<Output = Result<String, JwksFetchError>> + Send + 'a;
}

/// Production [`JwksFetcher`] backed by `reqwest`.
///
/// Enforces [`MAX_JWKS_RESPONSE_BYTES`] before reading the full body.
#[derive(Clone)]
pub struct HttpJwksFetcher {
    client: reqwest::Client,
}

impl HttpJwksFetcher {
    /// Construct with a default `reqwest` client.
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }

    /// Construct with an explicit `reqwest::Client` (e.g., with custom TLS
    /// certificates or timeout configuration).
    pub fn with_client(client: reqwest::Client) -> Self {
        Self { client }
    }
}

impl Default for HttpJwksFetcher {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for HttpJwksFetcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HttpJwksFetcher")
    }
}

// Sealed so only in-crate types implement `JwksFetcher`.
impl super::verifier::sealed::Sealed for HttpJwksFetcher {}

impl JwksFetcher for HttpJwksFetcher {
    fn fetch_jwks<'a>(
        &'a self,
        uri: &'a str,
    ) -> impl std::future::Future<Output = Result<String, JwksFetchError>> + Send + 'a {
        async move {
            let response = self
                .client
                .get(uri)
                .send()
                .await
                .map_err(|_| JwksFetchError::NetworkError)?;

            // Reject based on Content-Length before reading body.
            if let Some(content_length) = response.content_length() {
                if content_length as usize > MAX_JWKS_RESPONSE_BYTES {
                    return Err(JwksFetchError::ResponseTooLarge);
                }
            }

            let bytes = response
                .bytes()
                .await
                .map_err(|_| JwksFetchError::NetworkError)?;

            if bytes.len() > MAX_JWKS_RESPONSE_BYTES {
                return Err(JwksFetchError::ResponseTooLarge);
            }

            String::from_utf8(bytes.to_vec()).map_err(|_| JwksFetchError::ParseError)
        }
    }
}

/// Parse a raw JWKS JSON body into a bounded, validated [`JwkSet`].
///
/// Rejects parse errors and key-count bound violations before any per-key
/// lookup or allocation.
fn parse_and_bound_jwks(body: &str) -> Result<JwkSet, JwksFetchError> {
    let key_set: JwkSet = serde_json::from_str(body).map_err(|_| JwksFetchError::ParseError)?;

    if key_set.keys.is_empty() || key_set.keys.len() > MAX_JWKS_KEYS {
        return Err(JwksFetchError::KeyCountBoundsViolation);
    }

    Ok(key_set)
}

/// The production [`IssuerKeySource`]: a multi-issuer JWKS cache that performs
/// bounded periodic refresh and never serves snapshots past their hard deadline.
///
/// One `ProductionJwksSource` is constructed at startup after
/// [`super::startup::validate_nip_fi_config`] passes. The `Arc<RwLock<…>>`
/// internal structure lets it be shared across async tasks cheaply.
///
/// ## Security
///
/// - Each issuer's JWKS is stored under its exact `iss` — no relabelling.
/// - Expired snapshots are purged on access; no stale-key fallback.
/// - Errors are logged with a stable code; no key material appears in logs.
pub struct ProductionJwksSource<F = HttpJwksFetcher> {
    configs: HashMap<String, IssuerJwksConfig>,
    /// Keyed by exact issuer string.
    states: Arc<RwLock<HashMap<String, Mutex<IssuerState>>>>,
    fetcher: Arc<F>,
}

impl<F: JwksFetcher> ProductionJwksSource<F> {
    /// Construct a new source from validated issuer JWKS configs.
    ///
    /// Returns `None` when `configs` is empty (startup validation rejects this
    /// before the source is ever built) or when any config has invalid timing
    /// bounds.
    pub fn new(configs: Vec<IssuerJwksConfig>, fetcher: F) -> Option<Self> {
        if configs.is_empty() {
            return None;
        }
        let mut config_map = HashMap::with_capacity(configs.len());
        let mut state_map = HashMap::with_capacity(configs.len());
        for c in configs {
            // Hard deadline must be strictly greater than refresh interval so
            // a snapshot is always fresh for at least one cycle before expiry.
            if c.refresh_interval_seconds == 0
                || c.key_snapshot_hard_deadline_seconds == 0
                || c.key_snapshot_hard_deadline_seconds <= c.refresh_interval_seconds
            {
                return None;
            }
            let issuer = c.issuer.clone();
            state_map.insert(issuer.clone(), Mutex::new(IssuerState::new()));
            config_map.insert(issuer, c);
        }
        Some(Self {
            configs: config_map,
            states: Arc::new(RwLock::new(state_map)),
            fetcher: Arc::new(fetcher),
        })
    }

    /// Fetch and seal a fresh snapshot for one issuer, without updating the
    /// cache. Returns `None` when the fetch or parse fails (already logged).
    async fn fetch_fresh(&self, issuer: &str) -> Option<CachedSnapshot> {
        let config = self.configs.get(issuer)?;
        let body = match self.fetcher.fetch_jwks(&config.jwks_uri).await {
            Ok(b) => b,
            Err(err) => {
                warn!(
                    error = %err,
                    "nip-fi jwks fetch failed; will use cached snapshot if live"
                );
                return None;
            }
        };

        let jwks = match parse_and_bound_jwks(&body) {
            Ok(k) => k,
            Err(err) => {
                warn!(
                    error = %err,
                    "nip-fi jwks parse failed; will use cached snapshot if live"
                );
                return None;
            }
        };

        let now = Utc::now();
        let hard_deadline =
            now + Duration::seconds(config.key_snapshot_hard_deadline_seconds as i64);

        // Generation: milliseconds since epoch, floored to 1 to satisfy the
        // non-zero invariant. Monotone unless the system clock goes backwards.
        let generation = u64::try_from(now.timestamp_millis()).unwrap_or(1).max(1);

        let key_set = AssertionKeySet::new(issuer.to_owned(), generation, jwks, hard_deadline)?;

        Some(CachedSnapshot {
            key_set,
            fetched_at: now,
            hard_deadline,
        })
    }

    /// Return the current snapshot for `issuer`, refreshing if stale.
    ///
    /// Returns `None` when no live snapshot is available and the fetch fails.
    ///
    /// ## Refresh logic
    ///
    /// - If the cached snapshot is past its hard deadline, it is cleared.
    /// - If there is no snapshot, or the snapshot is past its refresh
    ///   interval, a refresh runs inline (holding the issuer's mutex).
    /// - Concurrent calls share the inline refresh via the per-issuer mutex.
    pub async fn get_snapshot(&self, issuer: &str) -> Option<AssertionKeySet> {
        let states = self.states.read().await;
        let state_mutex = states.get(issuer)?;
        let mut state = state_mutex.lock().await;

        let now = Utc::now();
        let config = self.configs.get(issuer)?;

        // Evict expired snapshot.
        if let Some(ref cached) = state.snapshot {
            if now >= cached.hard_deadline {
                state.snapshot = None;
            }
        }

        let needs_refresh = match state.snapshot {
            None => true,
            Some(ref cached) => {
                let age_secs = (now - cached.fetched_at).num_seconds().max(0) as u64;
                age_secs >= config.refresh_interval_seconds
            }
        };

        if !needs_refresh {
            return state.snapshot.as_ref().map(|c| c.key_set.clone());
        }

        if state.refresh_in_flight {
            // Another task is already refreshing; return the current snapshot
            // (may be None if no snapshot is available yet).
            return state.snapshot.as_ref().map(|c| c.key_set.clone());
        }

        state.refresh_in_flight = true;
        // Drop mutex and read lock while doing async I/O so other issuers
        // are not blocked.
        drop(state);
        drop(states);

        let fresh = self.fetch_fresh(issuer).await;

        // Re-acquire to commit the result and clear the in-flight flag.
        let states = self.states.read().await;
        if let Some(state_mutex) = states.get(issuer) {
            let mut st = state_mutex.lock().await;
            st.refresh_in_flight = false;
            if let Some(ref cached) = fresh {
                st.snapshot = Some(cached.clone());
            }
            let now2 = Utc::now();
            return st
                .snapshot
                .as_ref()
                .filter(|c| now2 < c.hard_deadline)
                .map(|c| c.key_set.clone());
        }

        None
    }
}

// Sealed so only in-crate types implement `IssuerKeySource`.
impl<F: JwksFetcher> super::verifier::sealed::Sealed for ProductionJwksSource<F> {}

impl<F: JwksFetcher> IssuerKeySource for ProductionJwksSource<F> {
    /// Synchronous read of the currently cached snapshot.
    ///
    /// The verifier calls this per-request after the runtime has ensured the
    /// cache is warm via [`get_snapshot`][Self::get_snapshot]. Returns `None`
    /// if no snapshot is available or the snapshot is past its hard deadline.
    ///
    /// Uses `try_read`/`try_lock` so it is safe to call from any context —
    /// including inside an async runtime. If the lock is momentarily held
    /// (in-flight refresh), fails closed by returning `None` rather than
    /// blocking or panicking. [FI-INV-14]
    fn key_set(&self, issuer: &str) -> Option<AssertionKeySet> {
        let states = self.states.try_read().ok()?;
        let state_mutex = states.get(issuer)?;
        let state = state_mutex.try_lock().ok()?;
        let now = Utc::now();
        state
            .snapshot
            .as_ref()
            .filter(|c| now < c.hard_deadline)
            .map(|c| c.key_set.clone())
    }
}

impl<F> std::fmt::Debug for ProductionJwksSource<F> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // No issuer URIs or key material in debug output.
        write!(
            f,
            "ProductionJwksSource([REDACTED; {} issuers])",
            self.configs.len()
        )
    }
}

#[cfg(test)]
mod tests;
