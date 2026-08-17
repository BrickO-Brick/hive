//! Phase-3 §2.5 pure identity-binding helper tests: the `key_archive_protected`
//! deletion-safety predicate (P13-C1/P17-C1) and deterministic `select_binding_seed`
//! (P3-I2). Both are keyring-free pure functions; the crash-safe mint protocol and
//! their transaction wiring land later (Phase 4b). Kept in their own module so the
//! Phase-1 `tests.rs` suite stays clear of the 1000-line file ratchet.

use serde_json::json;

use super::*;

// ── key_archive_protected ──────────────────────────────────────────────────────

/// A raw entry `Value` binding `agent_pubkey` under one owner, with the given
/// `deleted` tombstone flag. Only the fields the predicate reads are populated —
/// the predicate scans raw entries, so a partial value is a faithful stand-in
/// for both a healthy and a quarantined on-disk entry. The owner map key is a
/// fixed placeholder: the predicate reads binding values, never the key.
fn bound_entry(agent_pubkey: &str, deleted: bool) -> serde_json::Value {
    json!({
        "deleted": deleted,
        "identity_bindings": {
            "owner-key-placeholder": { "agent_pubkey": agent_pubkey, "auth_tag": "{}" }
        }
    })
}

fn deferred_entry(agent_pubkey: &str) -> serde_json::Value {
    json!({
        "deferred_archives": [ { "scope_id": "scope-1", "agent_pubkey": agent_pubkey } ]
    })
}

fn library(entries: Vec<serde_json::Value>) -> LibraryDocument {
    LibraryDocument {
        version: SUPPORTED_LIBRARY_VERSION,
        entries,
        orphan_keys: vec![],
    }
}

#[test]
fn test_ever_bound_live_entry_protects_key() {
    let target = "aa".repeat(32);
    let doc = library(vec![bound_entry(&target, false)]);
    assert!(doc.key_archive_protected(&target));
}

#[test]
fn test_ever_bound_tombstoned_entry_still_protects_key() {
    // Tombstones are kept forever (P1-OQ2); a deleted entry that once bound the
    // pubkey must keep protecting it — the global keyring identity outlives the
    // tombstone.
    let target = "bb".repeat(32);
    let doc = library(vec![bound_entry(&target, true)]);
    assert!(doc.key_archive_protected(&target));
}

#[test]
fn test_quarantined_entry_binding_pubkey_protects_key() {
    // A structurally invalid entry (would be quarantined on decode) that still
    // names the pubkey in identity_bindings must protect it: the predicate scans
    // RAW entries so quarantine can never strip protection.
    let target = "cc".repeat(32);
    let garbage = json!({
        "not_a_real_field": 7,
        "identity_bindings": {
            "owner-key-placeholder": { "agent_pubkey": target, "auth_tag": "{}" }
        }
    });
    let doc = library(vec![garbage]);
    assert!(doc.key_archive_protected(&target));
}

#[test]
fn test_outstanding_deferred_archive_protects_key() {
    // A deferred-archive obligation with no surviving binding must still protect:
    // the retirement marker is the record that the key was never archived.
    let target = "dd".repeat(32);
    let doc = library(vec![deferred_entry(&target)]);
    assert!(doc.key_archive_protected(&target));
}

#[test]
fn test_unrelated_entry_does_not_protect_key() {
    let target = "ee".repeat(32);
    let other = "11".repeat(32);
    let doc = library(vec![bound_entry(&other, false), deferred_entry(&other)]);
    assert!(!doc.key_archive_protected(&target));
}

#[test]
fn test_empty_library_protects_nothing() {
    let doc = library(vec![]);
    assert!(!doc.key_archive_protected(&"22".repeat(32)));
}

// ── select_binding_seed ─────────────────────────────────────────────────────────

#[test]
fn test_seed_picks_earliest_created() {
    let seed = select_binding_seed(vec![
        SeedCandidate {
            created_at: "2026-08-11T10:00:00Z",
            pubkey: "aaa",
        },
        SeedCandidate {
            created_at: "2026-08-11T09:00:00Z",
            pubkey: "bbb",
        },
        SeedCandidate {
            created_at: "2026-08-11T11:00:00Z",
            pubkey: "ccc",
        },
    ]);
    assert_eq!(seed, Some("bbb"));
}

#[test]
fn test_seed_breaks_created_tie_by_lowest_pubkey() {
    let seed = select_binding_seed(vec![
        SeedCandidate {
            created_at: "2026-08-11T09:00:00Z",
            pubkey: "ffff",
        },
        SeedCandidate {
            created_at: "2026-08-11T09:00:00Z",
            pubkey: "0001",
        },
        SeedCandidate {
            created_at: "2026-08-11T09:00:00Z",
            pubkey: "abcd",
        },
    ]);
    assert_eq!(seed, Some("0001"));
}

#[test]
fn test_seed_single_instance() {
    let seed = select_binding_seed(vec![SeedCandidate {
        created_at: "2026-08-11T09:00:00Z",
        pubkey: "solo",
    }]);
    assert_eq!(seed, Some("solo"));
}

#[test]
fn test_seed_empty_is_none() {
    assert_eq!(select_binding_seed(Vec::new()), None);
}
