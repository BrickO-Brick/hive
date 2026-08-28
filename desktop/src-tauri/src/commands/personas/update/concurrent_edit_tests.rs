//! Regression for Carl round-4 P1: the persona edit must reject a
//! compare-and-swap conflict BEFORE it mutates or writes, so a stale
//! full-replacement input cannot clobber a concurrent writer.
//!
//! Two layers of coverage:
//!
//! 1. **Comparison logic** — four unit tests against `find_persona_for_update`
//!    directly: stale rejection, matching-revision pass, absent-revision skip,
//!    and not-found vs conflict distinction.
//!
//! 2. **Command-path wiring** — one async test drives the real
//!    `update_persona_with` against a file-backed store under a
//!    `MockRuntime` `AppHandle`. Writer A commits R1→R2 through the command
//!    path; writer B then submits with expected R1, is rejected with
//!    `PERSONA_REVISION_CONFLICT`, and the store still reads R2. This pins the
//!    wiring: if `update_persona_with` stops calling `find_persona_for_update`,
//!    moves the check outside the lock, or disconnects the guard in any other
//!    way, this test turns RED — even if the comparison-logic tests stay green.

use super::{find_persona_for_update, update_persona_with, PERSONA_REVISION_CONFLICT};
use crate::app_state::build_app_state;
use crate::managed_agents::{save_personas, AgentDefinition, UpdatePersonaRequest};

/// A persisted persona at revision `updated_at`. The guard reads only `id`,
/// `display_name`, and `updated_at`.
fn persona(id: &str, display_name: &str, updated_at: &str) -> AgentDefinition {
    AgentDefinition {
        id: id.to_string(),
        display_name: display_name.to_string(),
        avatar_url: None,
        system_prompt: "Do the work.".to_string(),
        runtime: None,
        model: None,
        provider: None,
        name_pool: Vec::new(),
        is_builtin: false,
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        team_catalog_source: None,
        env_vars: std::collections::BTreeMap::new(),
        respond_to: None,
        respond_to_allowlist: Vec::new(),
        parallelism: None,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: updated_at.to_string(),
    }
}

const R1: &str = "2026-01-01T00:00:00Z";
const R2: &str = "2026-06-01T00:00:00Z";

#[test]
fn two_writer_overwrite_is_rejected_and_the_newer_revision_survives() {
    // Writer B seeded its editor at R1. Writer A then committed R2, so the
    // persisted record now reads R2 when B submits. B's compare-and-swap
    // (expected R1) must be rejected before any mutation — proving A's R2
    // survives because the caller never reaches the write.
    let mut personas = vec![persona("p1", "Alice", R2)];

    let err = find_persona_for_update(&mut personas, "p1", Some(R1))
        .expect_err("a stale expected revision must be rejected");

    assert!(
        err.starts_with(PERSONA_REVISION_CONFLICT),
        "rejection must carry the conflict marker so the UI shows the drift toast; got: {err}"
    );
    assert!(
        err.contains("Alice"),
        "rejection names the persona; got: {err}"
    );
    // R2 survives untouched: the guard returned before handing out a mutable
    // handle, so nothing was overwritten.
    assert_eq!(
        personas[0].updated_at, R2,
        "the newer revision is preserved"
    );
    assert_eq!(personas[0].display_name, "Alice");
}

#[test]
fn matching_revision_resolves_the_record_for_the_write() {
    // No concurrent writer: the persisted revision still equals the seed, so
    // the guard hands back the record and the caller proceeds to write.
    let mut personas = vec![persona("p1", "Alice", R1)];

    let resolved = find_persona_for_update(&mut personas, "p1", Some(R1))
        .expect("a matching revision must resolve the record");

    assert_eq!(resolved.id, "p1");
}

#[test]
fn absent_expected_revision_skips_the_guard() {
    // Legacy callers and instance-only saves send no expected revision; the
    // guard must be inert and still resolve the record regardless of drift.
    let mut personas = vec![persona("p1", "Alice", R2)];

    let resolved = find_persona_for_update(&mut personas, "p1", None)
        .expect("no expected revision skips the compare-and-swap");

    assert_eq!(resolved.updated_at, R2);
}

#[test]
fn missing_persona_reports_not_found_not_a_conflict() {
    // A resolve miss is a plain not-found error, distinct from the revision
    // conflict — the UI must not show the drift toast for a deleted persona.
    let mut personas = vec![persona("p1", "Alice", R1)];

    let err = find_persona_for_update(&mut personas, "ghost", Some(R1))
        .expect_err("an unknown id must error");

    assert!(
        !err.starts_with(PERSONA_REVISION_CONFLICT),
        "not a conflict"
    );
    assert!(
        err.contains("ghost") && err.contains("not found"),
        "got: {err}"
    );
}

/// Build a headless `MockRuntime` `AppHandle` wired with `build_app_state`.
/// The app resolves its data dir from `$HOME` / `$XDG_DATA_HOME`; the caller
/// holds the path mutex and has overridden both so all store reads/writes land
/// inside its tempdir.
fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
    let state = build_app_state();
    tauri::test::mock_builder()
        .manage(state)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app builds headless")
}

/// Build a minimal `UpdatePersonaRequest` for persona `id` with an optional
/// expected revision. Only `display_name` and `system_prompt` are required;
/// all other fields default to absent.
fn update_request(id: &str, display_name: &str, expected: Option<&str>) -> UpdatePersonaRequest {
    UpdatePersonaRequest {
        id: id.to_string(),
        display_name: display_name.to_string(),
        avatar_url: None,
        system_prompt: "Do the work.".to_string(),
        runtime: None,
        model: None,
        provider: None,
        name_pool: Vec::new(),
        env_vars: None,
        behavior: None,
        expected_updated_at: expected.map(str::to_string),
    }
}

/// Command-path wiring regression: Writer A commits a definition update through
/// the real `update_persona_with` (R1 → R2 in the persisted store). Writer B
/// then submits with its seed-time expected revision R1; the command must reject
/// it with a `PERSONA_REVISION_CONFLICT` error and leave A's R2 untouched.
///
/// This test turns RED if `update_persona_with` disconnects the guard from the
/// lock-held write — even if the comparison-logic tests above stay green.
#[tokio::test]
async fn command_path_rejects_stale_writer_and_preserves_newer_revision() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();

    let old_home = std::env::var_os("HOME");
    let old_xdg = std::env::var_os("XDG_DATA_HOME");
    {
        // Hold the path mutex only during the synchronous setup phase; it must
        // be released before the async writes so clippy does not flag a
        // MutexGuard held across an await point.
        let _path_guard = crate::managed_agents::lock_path_mutex();
        std::env::set_var("HOME", &home);
        std::env::set_var("XDG_DATA_HOME", &home);
    }

    let app = mock_app();

    // Seed: one persona at R1 in the persisted store.
    save_personas(app.handle(), &[persona("p1", "Alice", R1)]).expect("seed write must succeed");

    // Writer A: submits with expected R1. Succeeds; store advances to a new
    // `updated_at` (set by `now_iso()` inside the command, so we don't know
    // the exact string — we only need it to differ from R1).
    let a_result = update_persona_with(
        update_request("p1", "Alice A", Some(R1)),
        app.handle().clone(),
        |_app, _state, _persona| Ok(()),
    )
    .await;
    let (a_persona, ()) = a_result.expect("writer A must succeed — revision matches the seed");
    let r2 = a_persona.updated_at.clone();
    assert_ne!(r2, R1, "the commit must advance the revision past R1");

    // Writer B: seeded at R1, submits after A has already committed R2.
    // The command must reject this with a PERSONA_REVISION_CONFLICT error.
    let b_result = update_persona_with(
        update_request("p1", "Alice B (must not land)", Some(R1)),
        app.handle().clone(),
        |_app, _state, _persona| Ok(()),
    )
    .await;
    let b_err = b_result.expect_err("writer B must be rejected — its seed revision R1 is stale");

    assert!(
        b_err.starts_with(PERSONA_REVISION_CONFLICT),
        "rejection must carry the conflict marker; got: {b_err}"
    );

    // Reload from the persisted store and confirm A's R2 survived B's attempt.
    let persisted =
        crate::managed_agents::load_personas(app.handle()).expect("reload must succeed");
    let stored = persisted
        .iter()
        .find(|p| p.id == "p1")
        .expect("persona must still exist after B's rejection");

    assert_eq!(
        stored.updated_at, r2,
        "A's committed revision must survive B's stale write attempt"
    );
    assert_eq!(
        stored.display_name, "Alice A",
        "A's committed display_name must survive B's stale write attempt"
    );

    // Restore env vars.
    std::env::remove_var("HOME");
    std::env::remove_var("XDG_DATA_HOME");
    match old_home {
        Some(v) => std::env::set_var("HOME", v),
        None => std::env::remove_var("HOME"),
    }
    match old_xdg {
        Some(v) => std::env::set_var("XDG_DATA_HOME", v),
        None => std::env::remove_var("XDG_DATA_HOME"),
    }
}
