//! JWKS discovery, snapshot caching, and the production [`IssuerKeySource`]
//! implementation for federated-assertion verification.
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
//! - **Bounded resource acquisition.** HTTP response streaming stops at
//!   [`MAX_JWKS_RESPONSE_BYTES`] + 1 byte before any allocation for parsing.
//!   Key count is bounded by [`super::config::MAX_JWKS_KEYS`] inside
//!   [`AssertionKeySet::new`].
//!
//! - **Coalesced refresh.** A single in-flight refresh per issuer prevents
//!   thundering-herd. Concurrent callers observe the snapshot just after the
//!   racing refresh commits.
//!
//! - **No secrets or key material in errors or logs.** [`JwksFetchError`]
//!   carries only non-sensitive diagnostic codes.

use super::config::MAX_JWKS_KEYS;
use super::verifier::{AssertionKeySet, IssuerKeySource};
use buzz_core::network::is_private_ip;
use chrono::{DateTime, Duration, Utc};
use futures_util::StreamExt as _;
use jsonwebtoken::jwk::JwkSet;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use tracing::warn;
use url::Url;

/// Maximum HTTP response body for a JWKS endpoint. Streaming stops at this
/// limit before any deserialization, preventing OOM from a malicious server.
pub const MAX_JWKS_RESPONSE_BYTES: usize = 512 * 1024; // 512 KiB

/// Hard upper bound on JWKS timing fields. Values above this are rejected at
/// config construction to prevent `u64`→`i64` conversion overflow and Chrono
/// range panics when computing snapshot deadlines.
pub const MAX_JWKS_TIMING_SECONDS: u64 = 365 * 24 * 3600; // 1 year

/// Per-request deadline for the complete JWKS fetch (connect + headers + body).
/// This constant documents the timeout set on the default `HttpJwksFetcher::new()`
/// client; it cannot be removed via `with_client`.
pub const JWKS_REQUEST_TIMEOUT_SECS: u64 = 10;

/// Validate that a JWKS URI is safe to fetch: HTTPS scheme, no credentials,
/// no fragment, and the host (if a bare IP) is not private/reserved. Hostnames
/// are not resolved here — runtime SSRF for hostname targets is limited by
/// redirect denial and the intrinsic request deadline.
pub fn validate_jwks_uri(uri: &str) -> Result<(), JwksFetchError> {
    let parsed = Url::parse(uri).map_err(|_| JwksFetchError::InvalidUri)?;
    if parsed.scheme() != "https" {
        return Err(JwksFetchError::InvalidUri);
    }
    // Credentials in the URI are never legitimate for a public JWKS endpoint
    // and would be forwarded to the server, leaking material in logs.
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(JwksFetchError::InvalidUri);
    }
    // Fragments are client-side only; their presence indicates a misconfigured URI.
    if parsed.fragment().is_some() {
        return Err(JwksFetchError::InvalidUri);
    }
    // Reject bare private/reserved IP targets at construction time. Hostname
    // targets are additionally constrained at runtime by redirect denial.
    if let Some(url::Host::Ipv4(addr)) = parsed.host() {
        if is_private_ip(&std::net::IpAddr::V4(addr)) {
            return Err(JwksFetchError::InvalidUri);
        }
    }
    if let Some(url::Host::Ipv6(addr)) = parsed.host() {
        if is_private_ip(&std::net::IpAddr::V6(addr)) {
            return Err(JwksFetchError::InvalidUri);
        }
    }
    Ok(())
}

#[derive(Clone)]
struct CachedSnapshot {
    key_set: AssertionKeySet,
    fetched_at: DateTime<Utc>,
    hard_deadline: DateTime<Utc>,
    /// SHA-256 of the raw JWKS bytes. Suppresses generation advances when the
    /// document is unchanged between refreshes. [FI-TRACE-JWKS-ADD/REMOVE]
    content_digest: [u8; 32],
}

struct IssuerState {
    snapshot: Option<CachedSnapshot>,
    /// Advances only when `content_digest` changes; never wraps (saturating).
    generation_counter: u64,
    /// True while a refresh task owns the fetch lock. Prevents thundering-herd.
    refresh_in_flight: bool,
}

impl IssuerState {
    fn new() -> Self {
        Self {
            snapshot: None,
            generation_counter: 0,
            refresh_in_flight: false,
        }
    }
}

/// Per-issuer JWKS endpoint configuration. All fields are validated by
/// [`validate_jwks_uri`] and timing bounds at [`ProductionJwksSource::new`].
#[derive(Debug, Clone)]
pub struct IssuerJwksConfig {
    /// The exact `iss` value this config authenticates. Must match the
    /// corresponding [`IssuerPolicy`][super::config::IssuerPolicy] exactly.
    pub issuer: String,
    /// Must pass [`validate_jwks_uri`]: HTTPS, no credentials/fragment, no
    /// bare private-IP host.
    pub jwks_uri: String,
    /// Seconds until a cached snapshot is considered stale and re-fetching is
    /// triggered. Must be positive, strictly less than
    /// `key_snapshot_hard_deadline_seconds`, and ≤ [`MAX_JWKS_TIMING_SECONDS`].
    pub refresh_interval_seconds: u64,
    /// Hard upper bound from fetch time on how long a snapshot may be served.
    /// Expired snapshots are never returned, even on fetch error — no stale
    /// fallback. Folds into every `AssertionKeySet` hard deadline and therefore
    /// into every `VerifiedAssertion.revalidation_dependencies`.
    /// Must be ≤ [`MAX_JWKS_TIMING_SECONDS`].
    pub key_snapshot_hard_deadline_seconds: u64,
}

/// Reason a JWKS fetch or parse operation failed. No key material, issuer
/// URLs, or raw response content appear in these variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum JwksFetchError {
    /// Non-HTTPS scheme, embedded credentials, fragment, or bare
    /// private/reserved IP host.
    #[error("JWKS URI failed safety validation")]
    InvalidUri,
    /// Response body exceeded [`MAX_JWKS_RESPONSE_BYTES`].
    #[error("JWKS response exceeded size limit")]
    ResponseTooLarge,
    /// Network failure, TLS error, request timeout, or non-2xx status.
    #[error("JWKS HTTP request failed")]
    NetworkError,
    /// Response body was not parseable as a JWK Set.
    #[error("JWKS response was not parseable")]
    ParseError,
    /// Parsed key set was empty or exceeded [`super::config::MAX_JWKS_KEYS`].
    #[error("JWKS key set bounds violation")]
    KeyCountBoundsViolation,
}

/// Sealed injection seam for JWKS HTTP fetching. Only types inside `buzz_auth`
/// may implement it — external types cannot name the private supertrait.
///
/// Implementations MUST enforce [`MAX_JWKS_RESPONSE_BYTES`] and MUST reject
/// non-2xx responses.
pub trait JwksFetcher: super::verifier::sealed::Sealed + Send + Sync + 'static {
    /// Fetch and return the raw JSON body from the given JWKS URI.
    fn fetch_jwks<'a>(
        &'a self,
        uri: &'a str,
    ) -> impl std::future::Future<Output = Result<String, JwksFetchError>> + Send + 'a;
}

/// Production [`JwksFetcher`] backed by `reqwest`. The default client enforces:
/// - no redirects (`Policy::none()`) — a redirect to an internal host would
///   bypass the URI safety check performed at startup;
/// - a finite per-request deadline ([`JWKS_REQUEST_TIMEOUT_SECS`]).
///
/// `with_client` accepts a caller-supplied client; the caller must preserve
/// the no-redirect and finite-timeout invariants. The JWKS URI safety check
/// is still enforced by [`ProductionJwksSource::new`] regardless.
#[derive(Clone)]
pub struct HttpJwksFetcher {
    client: reqwest::Client,
}

impl HttpJwksFetcher {
    /// Builds a hardened client: no redirects (`Policy::none()`), finite
    /// request deadline ([`JWKS_REQUEST_TIMEOUT_SECS`]).
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(JWKS_REQUEST_TIMEOUT_SECS))
            .build()
            .expect("HttpJwksFetcher default client build failed");
        Self { client }
    }

    /// The caller is responsible for preserving the no-redirect and
    /// finite-timeout invariants documented on this type.
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

impl super::verifier::sealed::Sealed for HttpJwksFetcher {}

impl JwksFetcher for HttpJwksFetcher {
    async fn fetch_jwks<'a>(&'a self, uri: &'a str) -> Result<String, JwksFetchError> {
        let response = self
            .client
            .get(uri)
            .send()
            .await
            .map_err(|_| JwksFetchError::NetworkError)?;

        // Non-2xx rejected before reading the body. A 3xx here means the
        // client followed a redirect (default client disallows this); 4xx/5xx
        // means the endpoint is not serving JWKS.
        if !response.status().is_success() {
            return Err(JwksFetchError::NetworkError);
        }

        // Early-exit on Content-Length before streaming. A lying or absent
        // Content-Length is caught by the incremental counter below.
        if let Some(content_length) = response.content_length() {
            if content_length as usize > MAX_JWKS_RESPONSE_BYTES {
                return Err(JwksFetchError::ResponseTooLarge);
            }
        }

        // Stream incrementally; stop at MAX_JWKS_RESPONSE_BYTES + 1 so we
        // never buffer more than the limit before rejecting.
        let mut body = Vec::with_capacity(MAX_JWKS_RESPONSE_BYTES.min(64 * 1024));
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| JwksFetchError::NetworkError)?;
            if body.len().saturating_add(chunk.len()) > MAX_JWKS_RESPONSE_BYTES {
                return Err(JwksFetchError::ResponseTooLarge);
            }
            body.extend_from_slice(&chunk);
        }

        String::from_utf8(body).map_err(|_| JwksFetchError::ParseError)
    }
}

fn parse_and_bound_jwks(body: &str) -> Result<JwkSet, JwksFetchError> {
    let key_set: JwkSet = serde_json::from_str(body).map_err(|_| JwksFetchError::ParseError)?;
    if key_set.keys.is_empty() || key_set.keys.len() > MAX_JWKS_KEYS {
        return Err(JwksFetchError::KeyCountBoundsViolation);
    }
    Ok(key_set)
}

/// Multi-issuer JWKS cache that performs bounded periodic refresh and never
/// serves snapshots past their hard deadline.
///
/// Must be constructed at startup after
/// [`super::startup::validate_nip_fi_config`] passes. Shared across async
/// tasks via the inner `Arc<RwLock<…>>`.
///
/// ## Security
///
/// - Each issuer's JWKS is stored under its exact `iss` — no relabelling.
/// - Expired snapshots are purged on access; no stale-key fallback.
/// - Errors are logged with a stable code; no key material appears in logs.
pub struct ProductionJwksSource<F = HttpJwksFetcher> {
    configs: HashMap<String, IssuerJwksConfig>,
    states: Arc<RwLock<HashMap<String, Mutex<IssuerState>>>>,
    fetcher: Arc<F>,
}

impl<F: JwksFetcher> ProductionJwksSource<F> {
    /// Returns `None` when `configs` is empty, any config has invalid timing
    /// bounds or fails URI validation, or any two configs share the same
    /// `issuer` (duplicate issuers make trust configuration ambiguous).
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
                || c.refresh_interval_seconds > MAX_JWKS_TIMING_SECONDS
                || c.key_snapshot_hard_deadline_seconds > MAX_JWKS_TIMING_SECONDS
            {
                return None;
            }
            if validate_jwks_uri(&c.jwks_uri).is_err() {
                return None;
            }
            if config_map.contains_key(&c.issuer) {
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

    async fn fetch_fresh(
        &self,
        issuer: &str,
        prev_digest: Option<[u8; 32]>,
        prev_generation: u64,
    ) -> Option<(CachedSnapshot, u64)> {
        let config = self.configs.get(issuer)?;
        let body = match self.fetcher.fetch_jwks(&config.jwks_uri).await {
            Ok(b) => b,
            Err(err) => {
                warn!(error = %err, "nip-fi jwks fetch failed; will use cached snapshot if live");
                return None;
            }
        };

        let jwks = match parse_and_bound_jwks(&body) {
            Ok(k) => k,
            Err(err) => {
                warn!(error = %err, "nip-fi jwks parse failed; will use cached snapshot if live");
                return None;
            }
        };

        let content_digest: [u8; 32] = Sha256::digest(body.as_bytes()).into();

        // Advance only when the document changed so key-rotation events are
        // visible [FI-TRACE-JWKS-ADD/REMOVE] while identical refetches are
        // stable. Saturating add prevents wrap on the (unreachable) u64 ceiling.
        let generation = if Some(content_digest) == prev_digest {
            prev_generation
        } else {
            prev_generation.saturating_add(1).max(1)
        };

        let now = Utc::now();
        // MAX_JWKS_TIMING_SECONDS ≤ ~31.5M < i64::MAX, so this conversion is
        // always safe for values that passed the bounds check in new().
        let deadline_secs =
            i64::try_from(config.key_snapshot_hard_deadline_seconds).unwrap_or(i64::MAX / 2);
        let hard_deadline = now
            + Duration::try_seconds(deadline_secs)
                .unwrap_or_else(|| Duration::seconds(i64::MAX / 2));

        let key_set = AssertionKeySet::new(issuer.to_owned(), generation, jwks, hard_deadline)?;

        Some((
            CachedSnapshot {
                key_set,
                fetched_at: now,
                hard_deadline,
                content_digest,
            },
            generation,
        ))
    }

    /// Returns the cached snapshot for `issuer`, refreshing inline if stale.
    /// Returns `None` when no live snapshot is available and the fetch fails.
    ///
    /// If a refresh is already in flight for this issuer, returns the current
    /// snapshot rather than blocking — coalesces concurrent callers. Drops
    /// both locks before the async fetch so other issuers are not blocked.
    pub async fn get_snapshot(&self, issuer: &str) -> Option<AssertionKeySet> {
        let states = self.states.read().await;
        let state_mutex = states.get(issuer)?;
        let mut state = state_mutex.lock().await;

        let now = Utc::now();
        let config = self.configs.get(issuer)?;

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
            return state.snapshot.as_ref().map(|c| c.key_set.clone());
        }

        state.refresh_in_flight = true;
        let prev_digest = state.snapshot.as_ref().map(|c| c.content_digest);
        let prev_generation = state.generation_counter;
        drop(state);
        drop(states);

        let fresh = self.fetch_fresh(issuer, prev_digest, prev_generation).await;

        let states = self.states.read().await;
        if let Some(state_mutex) = states.get(issuer) {
            let mut st = state_mutex.lock().await;
            st.refresh_in_flight = false;
            if let Some((ref cached, new_generation)) = fresh {
                st.generation_counter = new_generation;
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

impl<F: JwksFetcher> super::verifier::sealed::Sealed for ProductionJwksSource<F> {}

impl<F: JwksFetcher> IssuerKeySource for ProductionJwksSource<F> {
    /// Called per-request by the verifier after the cache has been warmed via
    /// [`get_snapshot`][Self::get_snapshot].
    ///
    /// Uses `try_read`/`try_lock` — safe to call from any async context.
    /// Fails closed (returns `None`) when the lock is momentarily held by an
    /// in-flight refresh, rather than blocking or panicking. [FI-INV-14]
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
