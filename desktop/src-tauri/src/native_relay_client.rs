//! Shared native relay session.
//!
//! Owns the authenticated relay socket for backend features that need live
//! subscriptions (archive sync today; persona catalog and catch-up next). One
//! session per (relay, pubkey) scope, multiplexing every subscription over a
//! single socket — a second socket per feature would multiply relay connection
//! slots and duplicate the NIP-42 handshake for no benefit.
//!
//! Built on `buzz-ws-client`, which owns the wire format and the NIP-42
//! handshake. That crate is request/response shaped (one caller, `next_event`
//! off a buffer); the session lifecycle lives here instead of being pushed down
//! into it, because `buzz-cli` and `buzz-test-client` consume that crate and do
//! not want subscription bookkeeping.

use std::{collections::HashMap, sync::Arc, time::Duration};

use buzz_ws_client_pkg::{NostrWsConnection, RelayMessage};
use nostr::{Event, Keys};
use tokio::{
    sync::{mpsc, Mutex},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

/// Backoff floor for reconnect attempts.
const RECONNECT_BASE_DELAY: Duration = Duration::from_millis(500);
/// Backoff ceiling. Matches the renderer session's ceiling so a relay outage
/// produces one retry cadence across the app rather than two competing ones.
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(30);
/// How long a read may block before the loop re-checks cancellation. Not a
/// connection timeout: an idle relay is normal, so a lapsed read just loops.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Backoff floor for reopening a subscription the relay CLOSED. Matches
/// `RETRY_BASE_DELAY_MS` in `relayClosedRecovery.ts`.
const CLOSED_RETRY_BASE_DELAY: Duration = Duration::from_secs(1);
/// Backoff ceiling for reopening a CLOSED subscription. Matches
/// `RETRY_MAX_DELAY_MS` in `relayClosedRecovery.ts`.
const CLOSED_RETRY_MAX_DELAY: Duration = Duration::from_secs(30);
/// Delay for a `rate-limited:` CLOSED that carries no `retry in Ns` hint.
/// Matches `DEFAULT_RATE_LIMIT_SECONDS` on both sides of the client.
const CLOSED_RATE_LIMIT_DEFAULT: Duration = Duration::from_secs(10);

/// A live subscription request: a filter plus where its events go.
#[derive(Clone)]
pub(crate) struct Subscription {
    /// Caller-stable key. Reused verbatim as the relay subscription id so a
    /// resubscribe after reconnect replaces rather than duplicates.
    pub(crate) id: String,
    pub(crate) filter: serde_json::Value,
}

/// An event delivered to the session owner, tagged with the subscription that
/// matched it. Callers demultiplex on `subscription_id`.
pub(crate) struct MatchedEvent {
    pub(crate) subscription_id: String,
    pub(crate) event: Box<Event>,
}

/// Handle to a running session. Dropping it does not stop the session; call
/// [`RelaySession::shutdown`] so the socket closes deterministically.
pub(crate) struct RelaySession {
    desired: Arc<Mutex<Vec<Subscription>>>,
    wake: mpsc::Sender<()>,
    cancel: CancellationToken,
}

impl RelaySession {
    /// Replaces the desired subscription set and wakes the loop to reconcile.
    ///
    /// Reconciliation is declarative rather than incremental: callers state
    /// what they want and the loop diffs. An incremental add/remove API would
    /// have to be replayed in order across a reconnect, which is exactly the
    /// bug class this avoids.
    ///
    /// It is also why no revision/generation guard is needed. Every reconcile
    /// re-reads the current desired set, so a change that lands mid-pass is
    /// picked up by the wake it queued rather than having to invalidate work
    /// already in flight.
    pub(crate) async fn set_subscriptions(&self, subscriptions: Vec<Subscription>) {
        *self.desired.lock().await = subscriptions;
        // A full channel already means "reconcile pending", so a failed send
        // is success: the loop has not yet consumed the previous wake.
        let _ = self.wake.try_send(());
    }

    pub(crate) fn shutdown(&self) {
        self.cancel.cancel();
    }
}

/// Starts a session against `relay_url` authenticated as `keys`.
///
/// Returns the handle plus the receiver for matched events. The session
/// reconnects on drop with exponential backoff and resubscribes the current
/// desired set — never a snapshot captured at connect time, so a subscription
/// change during an outage is honored by the reconnect that follows.
pub(crate) fn start(
    relay_url: String,
    keys: Keys,
    auth_tag: Option<nostr::Tag>,
) -> (Arc<RelaySession>, mpsc::Receiver<MatchedEvent>) {
    let (event_tx, event_rx) = mpsc::channel(256);
    let (wake, wake_rx) = mpsc::channel(1);
    let session = Arc::new(RelaySession {
        desired: Arc::new(Mutex::new(Vec::new())),
        wake,
        cancel: CancellationToken::new(),
    });

    tauri::async_runtime::spawn(run_session(
        relay_url,
        keys,
        auth_tag,
        Arc::clone(&session),
        wake_rx,
        event_tx,
    ));

    (session, event_rx)
}

async fn run_session(
    relay_url: String,
    keys: Keys,
    auth_tag: Option<nostr::Tag>,
    session: Arc<RelaySession>,
    mut wake_rx: mpsc::Receiver<()>,
    event_tx: mpsc::Sender<MatchedEvent>,
) {
    let mut delay = RECONNECT_BASE_DELAY;
    loop {
        if session.cancel.is_cancelled() {
            return;
        }

        match NostrWsConnection::connect_authenticated(&relay_url, &keys, auth_tag.as_ref()).await {
            Ok(conn) => {
                // A connection that authenticated is healthy regardless of how
                // long it then lived, so backoff resets here rather than on
                // clean exit — a socket that drops after one event must not
                // inherit the previous failure's delay.
                delay = RECONNECT_BASE_DELAY;
                run_connection(conn, &session, &mut wake_rx, &event_tx).await;
            }
            Err(error) => {
                eprintln!("buzz-desktop: native_relay_client: connect failed: {error}");
            }
        }

        if session.cancel.is_cancelled() {
            return;
        }
        tokio::select! {
            _ = session.cancel.cancelled() => return,
            _ = tokio::time::sleep(delay) => {}
        }
        delay = (delay * 2).min(RECONNECT_MAX_DELAY);
    }
}

/// Drives one connected socket until it drops or the session is cancelled.
async fn run_connection(
    mut conn: NostrWsConnection,
    session: &RelaySession,
    wake_rx: &mut mpsc::Receiver<()>,
    event_tx: &mpsc::Sender<MatchedEvent>,
) {
    // Subscription ids currently open ON THIS SOCKET. Deliberately local: a new
    // socket has none, so reconnect resubscribes the full desired set without
    // any explicit "resubscribe" path that could drift from the normal one.
    let mut open: HashMap<String, serde_json::Value> = HashMap::new();
    // Reopen schedule for ids the relay CLOSED, keyed the same way and equally
    // local — for the same reason and one more. Backoff state cannot live in
    // `desired`: that set is reloaded from SQLite by the archive task, so a
    // subscription deleted there is re-added by the next reload. The JS port
    // could delete from its subscription map because that map WAS the desired
    // set; here the two are separate, and only this one is per-socket.
    let mut retries: HashMap<String, ClosedRetry> = HashMap::new();

    if !reconcile(&mut conn, session, &mut open, &retries).await {
        return;
    }

    loop {
        // Earliest pending reopen, or `None` when nothing is scheduled. The arm
        // below is disabled in that case rather than sleeping on a far-future
        // instant, so an idle connection never wakes on this branch.
        let retry_at = retries.values().filter_map(|retry| retry.due_at).min();

        tokio::select! {
            _ = session.cancel.cancelled() => {
                let _ = conn.disconnect().await;
                return;
            }
            Some(()) = wake_rx.recv() => {
                if !reconcile(&mut conn, session, &mut open, &retries).await {
                    return;
                }
            }
            // The edge that makes a CLOSED recoverable. Without it, nothing
            // re-enters `reconcile` unless the desired set changes again, and
            // for a stable set that means the subscription is dead for the life
            // of the socket.
            _ = tokio::time::sleep_until(retry_at.unwrap_or_else(Instant::now)),
                if retry_at.is_some() =>
            {
                for retry in retries.values_mut() {
                    if retry.due_at.is_some_and(|due| due <= Instant::now()) {
                        retry.due_at = None;
                    }
                }
                if !reconcile(&mut conn, session, &mut open, &retries).await {
                    return;
                }
            }
            message = conn.next_event(READ_TIMEOUT) => {
                match message {
                    Ok(RelayMessage::Event { subscription_id, event }) => {
                        // Only forward events for a subscription we still want.
                        // A CLOSE races in flight with events already queued at
                        // the relay, so this is the last line of defense
                        // against delivering out-of-scope events after a change.
                        if !open.contains_key(&subscription_id) {
                            continue;
                        }
                        // Delivery proves the subscription is healthy, so any
                        // accumulated backoff for it is stale. Mirrors the JS
                        // port's per-event `closedRetryAttempt = 0`.
                        retries.remove(&subscription_id);
                        if event_tx
                            .send(MatchedEvent { subscription_id, event })
                            .await
                            .is_err()
                        {
                            // Receiver gone: nobody is consuming this session.
                            let _ = conn.disconnect().await;
                            return;
                        }
                    }
                    Ok(RelayMessage::Closed { subscription_id, message }) => {
                        // The relay dropped it; forget it so a reopen re-sends
                        // REQ rather than assuming it is still live.
                        open.remove(&subscription_id);
                        let retry = retries.entry(subscription_id.clone()).or_default();
                        retry.schedule(&message);
                        eprintln!(
                            "buzz-desktop: native_relay_client: relay closed {subscription_id}: {message}"
                        );
                    }
                    Ok(RelayMessage::Eose { subscription_id }) => {
                        // The relay served this subscription, so whatever
                        // caused an earlier CLOSED has cleared. Same reset the
                        // JS port performs in `handleSubscriptionEose`, and it
                        // is what keeps an intermittent relay from ratcheting
                        // its way to the 30s ceiling and staying there.
                        retries.remove(&subscription_id);
                    }
                    Ok(_) => {}
                    Err(error) => {
                        if !is_read_timeout(&error) {
                            eprintln!("buzz-desktop: native_relay_client: read failed: {error}");
                            return;
                        }
                    }
                }
            }
        }
    }
}

/// Brings the socket's open subscriptions in line with the desired set.
///
/// Returns false when the socket failed and the caller should reconnect.
async fn reconcile(
    conn: &mut NostrWsConnection,
    session: &RelaySession,
    open: &mut HashMap<String, serde_json::Value>,
    retries: &HashMap<String, ClosedRetry>,
) -> bool {
    let desired = session.desired.lock().await.clone();

    for id in open.keys().cloned().collect::<Vec<_>>() {
        if desired.iter().any(|s| s.id == id) {
            continue;
        }
        if conn
            .send_raw(&serde_json::json!(["CLOSE", id]))
            .await
            .is_err()
        {
            return false;
        }
        open.remove(&id);
    }

    for sub in desired {
        // A filter change under the same id must reopen, not be skipped: the
        // relay replaces a subscription by id, so re-sending REQ is the update.
        if open.get(&sub.id) == Some(&sub.filter) {
            continue;
        }
        // Held back by a CLOSED: either waiting out its backoff, or terminal
        // and never to be retried on this socket. Both are `is_blocked`, which
        // is what keeps a relay that rejects on policy from being re-asked at
        // the speed of the event loop.
        if retries.get(&sub.id).is_some_and(ClosedRetry::is_blocked) {
            continue;
        }
        if conn
            .send_raw(&serde_json::json!(["REQ", sub.id, sub.filter]))
            .await
            .is_err()
        {
            return false;
        }
        open.insert(sub.id, sub.filter);
    }

    true
}

/// Reopen schedule for one subscription the relay CLOSED.
#[derive(Default)]
struct ClosedRetry {
    /// When the reopen is due. `None` means "not waiting": either the delay has
    /// elapsed and reconcile may re-send, or `terminal` latched.
    due_at: Option<Instant>,
    /// Consecutive CLOSEDs, driving the exponential delay. Reset by a delivered
    /// event or EOSE, both of which drop the whole entry.
    attempts: u32,
    /// The relay rejected this filter for a reason retrying cannot change.
    terminal: bool,
}

impl ClosedRetry {
    /// True while reconcile must leave this subscription closed.
    fn is_blocked(&self) -> bool {
        self.terminal || self.due_at.is_some_and(|due| due > Instant::now())
    }

    /// Records a CLOSED and schedules the reopen its class calls for.
    fn schedule(&mut self, message: &str) {
        match classify_closed(message) {
            // Auth, access, or filter errors will fail identically until
            // something outside this socket changes, so stop asking. Scoped to
            // this socket by construction: the state lives in `run_connection`,
            // so a reconnect retries once through the normal path. That is
            // deliberate — relay policy and our own auth can change across a
            // reconnect, and one REQ per reconnect is bounded.
            ClosedClass::Terminal => {
                self.terminal = true;
                self.due_at = None;
            }
            ClosedClass::RateLimited => {
                // Arm the process-wide gate so the HTTP bridge backs off too,
                // rather than keeping a second private notion of the same
                // relay's back-pressure.
                let hint = parse_retry_in_seconds(message);
                crate::relay_admission::activate_rate_limit(hint);
                let hinted = hint
                    .map(Duration::from_secs)
                    .unwrap_or(CLOSED_RATE_LIMIT_DEFAULT);
                // The longer of the two: a short hint must not undercut a
                // backoff already grown by repeated rejections.
                self.due_at = Some(Instant::now() + self.backoff().max(hinted));
                self.attempts = self.attempts.saturating_add(1);
            }
            ClosedClass::Retryable => {
                self.due_at = Some(Instant::now() + self.backoff());
                self.attempts = self.attempts.saturating_add(1);
            }
        }
    }

    /// Exponential delay for the current attempt, capped. The shift is bounded
    /// before it is taken, so a long-lived rejection cannot overflow its way
    /// back down to a short delay.
    fn backoff(&self) -> Duration {
        CLOSED_RETRY_BASE_DELAY
            .saturating_mul(1_u32 << self.attempts.min(16))
            .min(CLOSED_RETRY_MAX_DELAY)
    }
}

/// How a CLOSED message should be handled.
///
/// Ported from `classifyRelayClosed` in `relayClosedPolicy.ts`; the prefixes are
/// the relay's own machine-readable NIP-01 classes and must stay in step with
/// that file.
#[derive(Debug, PartialEq, Eq)]
enum ClosedClass {
    Retryable,
    RateLimited,
    Terminal,
}

fn classify_closed(message: &str) -> ClosedClass {
    let normalized = message.trim().to_ascii_lowercase();
    if normalized.starts_with("rate-limited:") {
        return ClosedClass::RateLimited;
    }
    // `auth-required:` is deliberately absent, i.e. retryable: it occurs
    // transiently when a REQ races the AUTH handshake after a reconnect, and
    // the backoff reopen re-sends once authenticated. A session that is
    // genuinely unauthenticated fails at `connect_authenticated` instead, so
    // this cannot loop forever.
    if [
        "restricted:",
        "blocked:",
        "invalid:",
        "pow:",
        "duplicate:",
        "unsupported:",
        "error: mixed search",
        "error: too many subscriptions",
    ]
    .iter()
    .any(|prefix| normalized.starts_with(prefix))
    {
        return ClosedClass::Terminal;
    }
    ClosedClass::Retryable
}

/// Parses the relay's canonical `retry in Ns` hint. Same format the HTTP bridge
/// parses in `relay::extract_retry_in_hint`.
fn parse_retry_in_seconds(message: &str) -> Option<u64> {
    let after = &message[message.find("retry in ")? + "retry in ".len()..];
    after
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()
}

/// A lapsed read is an idle relay, not a failure. Distinguished by variant
/// rather than by message text so a reworded error cannot turn every idle
/// period into a reconnect storm.
fn is_read_timeout(error: &buzz_ws_client_pkg::WsClientError) -> bool {
    matches!(error, buzz_ws_client_pkg::WsClientError::Timeout)
}

#[cfg(test)]
mod closed_recovery_tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::protocol::Message;

    /// Minimal relay that completes the NIP-42 handshake, records every REQ,
    /// and sends a CLOSED only when the test asks it to.
    ///
    /// A real socket rather than a fake `NostrWsConnection`, because the bug
    /// this covers lives in the lifecycle between frames — the loop's only
    /// reconcile triggers — and a fake that hands the loop a `Closed` value
    /// cannot show that a REQ went back out over the wire afterwards. Same
    /// `accept_async` stub shape as `native_websocket.rs`'s live-TCP tests.
    ///
    /// CLOSED is test-driven rather than a scripted reply to the first REQ so
    /// the test can wait for the session to go quiet first. `set_subscriptions`
    /// queues a wake that may still be pending when an immediate CLOSED lands,
    /// and that wake reopens the subscription on its own — which made the first
    /// version of this test pass against the unfixed code.
    async fn stub_relay() -> (
        String,
        mpsc::Receiver<String>,
        mpsc::Sender<(String, String)>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stub relay");
        let address = listener.local_addr().expect("stub relay address");
        let (req_tx, req_rx) = mpsc::channel(16);
        let (closed_tx, mut closed_rx) = mpsc::channel::<(String, String)>(4);

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("websocket handshake");

            socket
                .send(Message::Text(r#"["AUTH","stub-challenge"]"#.into()))
                .await
                .expect("send challenge");

            loop {
                tokio::select! {
                    incoming = socket.next() => {
                        let Some(Ok(Message::Text(text))) = incoming else { return };
                        let Ok(frame) = serde_json::from_str::<serde_json::Value>(&text) else {
                            continue;
                        };
                        match frame[0].as_str() {
                            Some("AUTH") => {
                                let id = frame[1]["id"].as_str().unwrap_or_default();
                                socket
                                    .send(Message::Text(
                                        serde_json::json!(["OK", id, true, ""]).to_string().into(),
                                    ))
                                    .await
                                    .expect("send auth ok");
                            }
                            Some("REQ") => {
                                let id = frame[1].as_str().unwrap_or_default().to_string();
                                if req_tx.send(id).await.is_err() {
                                    return;
                                }
                            }
                            _ => {}
                        }
                    }
                    Some((id, message)) = closed_rx.recv() => {
                        socket
                            .send(Message::Text(
                                serde_json::json!(["CLOSED", id, message]).to_string().into(),
                            ))
                            .await
                            .expect("send closed");
                    }
                }
            }
        });

        (format!("ws://{address}"), req_rx, closed_tx)
    }

    fn probe_subscription() -> Subscription {
        Subscription {
            id: "archive:probe".to_string(),
            filter: serde_json::json!({ "kinds": [1], "limit": 0 }),
        }
    }

    async fn next_req(reqs: &mut mpsc::Receiver<String>, label: &str) -> String {
        tokio::time::timeout(Duration::from_secs(10), reqs.recv())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {label}"))
            .unwrap_or_else(|| panic!("stub relay closed before {label}"))
    }

    /// Waits out the wake `set_subscriptions` queued, so a CLOSED sent after
    /// this cannot be reopened by anything but the CLOSED path itself.
    ///
    /// A pending wake is harmless while the subscription is still open — that
    /// reconcile is a no-op — so draining it before the CLOSED is what makes
    /// the assertion below attributable.
    async fn settle() {
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    /// The blocker: a CLOSED with the desired set never changing again must
    /// still reopen the subscription.
    ///
    /// Before the fix the loop removed the id from `open` and waited on a wake
    /// that only `set_subscriptions` can produce, so a stable desired set left
    /// the subscription dead for the life of the socket — silent permanent
    /// loss for ephemeral kind 24200.
    #[tokio::test]
    async fn a_closed_subscription_reopens_without_a_desired_set_change() {
        let (relay_url, mut reqs, closed) = stub_relay().await;
        let (session, _events) = start(relay_url, Keys::generate(), None);

        session.set_subscriptions(vec![probe_subscription()]).await;
        assert_eq!(
            next_req(&mut reqs, "the initial REQ").await,
            "archive:probe"
        );
        settle().await;

        // Retryable class, sent once: the reopen is answered normally, so a
        // failure here means "never retried" rather than "retried into another
        // rejection".
        closed
            .send(("archive:probe".into(), "error: temporary".into()))
            .await
            .expect("stub relay accepts the closed command");

        // No `set_subscriptions` between the two REQs: the reopen must come
        // from the CLOSED itself, which is exactly the edge that was missing.
        assert_eq!(
            next_req(&mut reqs, "the reopened REQ").await,
            "archive:probe"
        );

        session.shutdown();
    }

    /// A relay that rejects on policy must not be re-asked in a tight loop.
    #[tokio::test]
    async fn a_terminal_closed_is_not_retried_on_the_same_socket() {
        let (relay_url, mut reqs, closed) = stub_relay().await;
        let (session, _events) = start(relay_url, Keys::generate(), None);

        session.set_subscriptions(vec![probe_subscription()]).await;
        assert_eq!(
            next_req(&mut reqs, "the initial REQ").await,
            "archive:probe"
        );
        settle().await;

        closed
            .send(("archive:probe".into(), "restricted: not authorized".into()))
            .await
            .expect("stub relay accepts the closed command");

        // Long enough that a retryable class (1s base) would have reopened
        // several times, so this asserts suppression rather than just slowness.
        let retried = tokio::time::timeout(Duration::from_secs(5), reqs.recv()).await;
        assert!(
            retried.is_err(),
            "a terminal CLOSED must not be retried on this socket, got {retried:?}"
        );

        session.shutdown();
    }

    #[test]
    fn closed_messages_classify_like_the_renderer_policy() {
        assert_eq!(
            classify_closed("rate-limited: quota exceeded; retry in 4s"),
            ClosedClass::RateLimited
        );
        assert_eq!(
            classify_closed("restricted: not authorized"),
            ClosedClass::Terminal
        );
        assert_eq!(
            classify_closed("error: too many subscriptions"),
            ClosedClass::Terminal
        );
        // Transient AUTH race, not a permanent rejection — the one prefix that
        // looks terminal and deliberately is not.
        assert_eq!(
            classify_closed("auth-required: we can't serve unauthenticated"),
            ClosedClass::Retryable
        );
        assert_eq!(classify_closed(""), ClosedClass::Retryable);
        // Case and padding come from the relay, not from us.
        assert_eq!(
            classify_closed("  RESTRICTED: nope  "),
            ClosedClass::Terminal
        );
    }

    #[test]
    fn retry_delay_grows_and_stops_at_the_ceiling() {
        let mut retry = ClosedRetry::default();
        assert_eq!(retry.backoff(), CLOSED_RETRY_BASE_DELAY);

        retry.schedule("error: temporary");
        assert_eq!(retry.backoff(), CLOSED_RETRY_BASE_DELAY * 2);

        for _ in 0..40 {
            retry.schedule("error: temporary");
        }
        assert_eq!(
            retry.backoff(),
            CLOSED_RETRY_MAX_DELAY,
            "backoff must saturate at the ceiling rather than wrapping"
        );
    }

    #[test]
    fn a_rate_limited_closed_waits_at_least_the_relay_hint() {
        let mut retry = ClosedRetry::default();
        retry.schedule("rate-limited: quota exceeded; retry in 12s");

        let due = retry.due_at.expect("rate-limited must schedule a reopen");
        // The hint dominates the 1s first backoff, so this asserts the hint was
        // honored rather than that anything at all was scheduled.
        assert!(
            due >= Instant::now() + Duration::from_secs(11),
            "a 12s hint must not be undercut by the base backoff"
        );
        crate::relay_admission::reset_rate_limit_gate();
    }

    #[test]
    fn a_hintless_rate_limited_closed_uses_the_shared_default() {
        let mut retry = ClosedRetry::default();
        retry.schedule("rate-limited: quota exceeded");

        let due = retry.due_at.expect("rate-limited must schedule a reopen");
        assert!(
            due >= Instant::now() + CLOSED_RATE_LIMIT_DEFAULT - Duration::from_secs(1),
            "a hintless rate-limit must fall back to the shared default window"
        );
        crate::relay_admission::reset_rate_limit_gate();
    }

    #[test]
    fn retry_hints_parse_the_relays_canonical_format() {
        assert_eq!(
            parse_retry_in_seconds("rate-limited: quota exceeded; retry in 4s"),
            Some(4)
        );
        assert_eq!(parse_retry_in_seconds("rate-limited: quota exceeded"), None);
        assert_eq!(parse_retry_in_seconds("retry in s"), None);
    }
}

#[cfg(test)]
mod relay_backed_tests {
    use super::*;
    use nostr::{EventBuilder, Tag};

    /// Relay-backed proof that the session's wire shape is one a real relay
    /// accepts and answers.
    ///
    /// Every other test in this commit drives `run_sync` through a fake
    /// [`crate::archive::sync::ArchiveSyncIo`], which is the right default:
    /// batching and demultiplexing are the logic worth pinning, and they must
    /// not need a socket. But a fake cannot fail the one way this layer
    /// actually can — by sending a REQ the relay rejects, or by filtering on a
    /// tag key that matches nothing. The JS manager's filters were validated by
    /// years of production traffic; this port's have been validated by my
    /// reading of that code, which is exactly the claim a real relay can check
    /// and I cannot.
    ///
    /// `#[ignore]`d because it needs a relay on `BUZZ_TEST_RELAY_URL`. Run:
    ///
    /// ```text
    /// ./scripts/start-isolated-test-relay.sh          # ws://localhost:3030
    /// BUZZ_TEST_RELAY_URL=ws://localhost:3030 \
    ///   cargo test -p buzz-desktop -- --ignored archive_sync_session
    /// ```
    #[tokio::test]
    #[ignore = "requires a local relay (set BUZZ_TEST_RELAY_URL)"]
    async fn archive_sync_session_receives_live_events_from_a_real_relay() {
        let Ok(relay_url) = std::env::var("BUZZ_TEST_RELAY_URL") else {
            panic!("set BUZZ_TEST_RELAY_URL to a running relay");
        };

        let owner = Keys::generate();
        let author = Keys::generate();
        let owner_pk = owner.public_key();

        // Kind 1 rather than the archive's own kind 24200. Publishing a real
        // observer frame requires a registered agent-owner binding in the
        // relay's database — a relay ACL concern that says nothing about this
        // layer. What this test can prove, and what no fake can, is the wire
        // shape: that the `#p` tag key and the `limit: 0` live tail produce a
        // REQ a real relay accepts and answers. Scope demultiplexing on the
        // archive side is covered in `archive/sync_tests.rs`.
        let (session, mut events) = start(relay_url.clone(), owner.clone(), None);
        session
            .set_subscriptions(vec![Subscription {
                id: "archive:owner_p:test".to_string(),
                filter: serde_json::json!({
                    "kinds": [1],
                    "limit": 0,
                    "#p": [owner_pk.to_hex()],
                }),
            }])
            .await;

        // The subscription must be live at the relay before the event is
        // published. A `limit: 0` filter is a live tail: it replays nothing,
        // so anything published into a not-yet-open subscription is missed.
        // That is the same ordering hazard the renderer start gate exists to
        // prevent for the ephemeral archive kind.
        tokio::time::sleep(Duration::from_secs(1)).await;

        let mut publisher = NostrWsConnection::connect_authenticated(&relay_url, &author, None)
            .await
            .expect("publisher connect");
        let frame = EventBuilder::text_note("archive-sync-probe")
            .tag(Tag::public_key(owner_pk))
            .sign_with_keys(&author)
            .expect("sign event");
        let frame_id = frame.id.to_hex();
        let ok = publisher.send_event(frame).await.expect("publish frame");
        assert!(
            ok.accepted,
            "relay rejected the observer frame, so a delivery timeout below would \
             blame the subscription for a publish failure: {}",
            ok.message
        );

        let received = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("timed out waiting for the relay to deliver the frame")
            .expect("session channel closed");

        assert_eq!(
            received.subscription_id, "archive:owner_p:test",
            "delivered event must carry the subscription id the loop demultiplexes on"
        );
        assert_eq!(
            received.event.id.to_hex(),
            frame_id,
            "must deliver the published frame"
        );

        session.shutdown();
    }
}
