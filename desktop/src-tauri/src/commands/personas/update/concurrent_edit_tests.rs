//! Regression for Carl round-4 P1: the persona edit must reject a
//! compare-and-swap conflict BEFORE it mutates or writes, so a stale
//! full-replacement input cannot clobber a concurrent writer.
//!
//! `find_persona_for_update` is the single seam `update_persona_with` uses to
//! locate the write target: the command loads the persona list under the store
//! lock, calls this to resolve the record (enforcing the revision guard), then
//! mutates and saves through the returned handle. Testing the seam directly
//! proves the guard on the real write path — removing the in-lock comparison
//! turns the two-writer test RED.

use super::{find_persona_for_update, PERSONA_REVISION_CONFLICT};
use crate::managed_agents::AgentDefinition;

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
