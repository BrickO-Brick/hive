//! Actual HTTP handler + signed NIP-98 + isolated Postgres/Redis, no fake pages.
use super::*;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use base64::Engine;
use nostr::{Event, EventBuilder, Kind, Tag};
use sha2::{Digest, Sha256};

async fn query_http(
    state: Arc<AppState>,
    host: &str,
    signer: &Keys,
    filter: Value,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let body = serde_json::to_vec(&json!([filter])).unwrap();
    let url = format!(
        "{}://{host}/query",
        if state.config.relay_url.starts_with("wss:") {
            "https"
        } else {
            "http"
        }
    );
    let auth = EventBuilder::new(Kind::HttpAuth, "")
        .tags([
            Tag::parse(["u", &url]).unwrap(),
            Tag::parse(["method", "POST"]).unwrap(),
            Tag::parse(["payload", &hex::encode(Sha256::digest(&body))]).unwrap(),
            Tag::parse(["nonce", &Uuid::new_v4().to_string()]).unwrap(),
        ])
        .sign_with_keys(signer)
        .unwrap();
    let mut headers = HeaderMap::new();
    headers.insert("host", host.parse().unwrap());
    headers.insert(
        "authorization",
        format!(
            "Nostr {}",
            base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&auth).unwrap())
        )
        .parse()
        .unwrap(),
    );
    crate::api::bridge::query_events(State(state), headers, body.into()).await
}

#[tokio::test]
#[ignore = "requires isolated Postgres MULTIVERSE_TEST_DATABASE_URL and Redis REDIS_URL"]
async fn host_http_pages_exhaust_timestamp_ties_and_never_leak_other_owners() {
    let url = std::env::var("MULTIVERSE_TEST_DATABASE_URL").expect("isolated DB required");
    let pool = sqlx::PgPool::connect(&url).await.unwrap();
    let db = Db::from_pool(pool.clone());
    let hostname = format!("host-pages-{}.test", Uuid::new_v4());
    let community = db.ensure_configured_community(&hostname).await.unwrap();
    let owner = Keys::generate();
    let host = Keys::generate();
    let other = Keys::generate();
    let timestamp = nostr::Timestamp::now().as_secs();
    let mut registrations = vec![];
    let mut profiles = vec![];
    let report = buzz_core::host::Report {
        v: 2,
        name: "Private test machine".into(),
        os: "test".into(),
        arch: "test".into(),
        launcher_version: "test".into(),
        runtimes: vec![],
        accepts_start: false,
    };
    // All records tie on timestamp. No event_mentions are populated. The
    // profile query must not lose its rows to a registration candidate page.
    for _ in 0..1001 {
        let reg = buzz_core::host::registration(&owner, host.public_key(), timestamp).unwrap();
        let profile = buzz_core::host::profile(&host, &reg, &report, timestamp).unwrap();
        for e in [&reg, &profile] {
            buzz_db::event::insert_event(&pool, community.id, e, None)
                .await
                .unwrap();
        }
        registrations.push(reg.id.to_hex());
        profiles.push(profile.id.to_hex());
    }
    let foreign = buzz_core::host::registration(&other, host.public_key(), timestamp + 1).unwrap();
    buzz_db::event::insert_event(&pool, community.id, &foreign, None)
        .await
        .unwrap();
    let state = state_with_redis(
        db,
        pool.clone(),
        std::env::var("REDIS_URL").expect("isolated Redis required"),
    )
    .await;
    let tenant = TenantContext::resolved(community.id, &hostname);
    let (_conn, _rx) = connection(&state, tenant, &owner);
    for (label, author, mut expected) in [
        ("registration", owner.public_key(), registrations),
        ("profile", host.public_key(), profiles),
    ] {
        let mut filter = json!({"kinds":[50000], "authors":[author.to_hex()], "#p":[owner.public_key().to_hex()], "#L":["buzz.host.v1"], "#l":[label], "#x":[host.public_key().to_hex()], "limit":1000});
        let mut ids = vec![];
        let mut sizes = vec![];
        loop {
            let Json(value) = query_http(state.clone(), &hostname, &owner, filter.clone())
                .await
                .unwrap();
            let mut events: Vec<Event> = serde_json::from_value(value).unwrap();
            events.sort_by_key(|e| e.id.to_hex());
            sizes.push(events.len());
            ids.extend(events.iter().map(|e| e.id.to_hex()));
            if events.len() < 1000 {
                break;
            }
            let last = events.last().unwrap();
            filter["until"] = json!(last.created_at.as_secs());
            filter["before_id"] = json!(last.id.to_hex());
        }
        expected.sort();
        assert_eq!(ids, expected);
        assert_eq!(sizes, [1000, 1]);
        // Reusing an owner's filters from a different signed identity is denied.
        let denied = query_http(state.clone(), &hostname, &other, filter)
            .await
            .unwrap_err();
        assert_eq!(denied.0, StatusCode::FORBIDDEN);
    }
    let Json(rows) = query_http(
        state.clone(),
        &hostname,
        &owner,
        json!({"ids":[foreign.id.to_hex()], "limit":1}),
    )
    .await
    .unwrap();
    assert_eq!(rows, json!([]));
    // Malformed composite cursor is a failure, never an empty successful page.
    let bad = query_http(state, &hostname, &owner, json!({"kinds":[50000], "#p":[owner.public_key().to_hex()], "before_id":"bad", "until":timestamp})).await.unwrap_err();
    assert_eq!(bad.0, StatusCode::BAD_REQUEST);
    pool.close().await;
}
