//! Concurrent save-path interleave test for `managed_agents/storage.rs`.
//!
//! A child of the `tests` module (`#[path]`-included from `storage_tests.rs`)
//! so it reuses that module's `FakeCombinedStore` and `record_with_pubkey_and_key`
//! helpers without duplication, while keeping `storage_tests.rs` under the
//! desktop file-size gate.

use super::super::{save_agent_definitions_at, save_managed_agents_at};
use super::{record_with_pubkey_and_key, FakeCombinedStore, ManagedAgentRecord};

/// Concurrent instance-save and definition-save against ONE store dir must lose
/// neither half and re-inline neither half's secrets. Each save re-reads the
/// OTHER half from disk under the shared secret transaction lock, so whichever
/// commits second observes the first's write and carries it forward — instead
/// of the last-writer-wins clobber a lock-free read-modify-write interleave
/// would cause.
///
/// Deterministic by handshake (identity_txn_lock_tests style): the instance
/// save commits while holding the lock; a non-blocking probe proves the
/// definition save is excluded mid-cycle; only after release does the
/// definition save acquire and commit, so its instance re-read is guaranteed to
/// observe the committed instance rather than the empty seed. The two saves use
/// independent stores because `RefCell` is not `Sync` and the assertions read
/// the committed JSON, not the keyring — each save only needs its own store to
/// project into.
#[test]
fn concurrent_instance_and_definition_saves_preserve_both_halves_without_reinlining() {
    use crate::secret_store::{store_txn_lock_dir, transaction_lock_at};
    use std::os::unix::io::AsRawFd;
    use std::sync::mpsc;

    let dir = tempfile::tempdir().expect("tempdir");
    let store_path = dir.path().join("managed-agents.json");
    std::fs::write(&store_path, b"[]").expect("seed empty store");
    let lock_dir = store_txn_lock_dir(&store_path);

    // Instance half: a keyed record with an inline key AND inline env, both of
    // which the save must project into the keyring (never leave in JSON).
    let mut instance = record_with_pubkey_and_key("instance-pub", "nsec1instkey");
    instance.env_vars = [("INSTANCE_SECRET".to_string(), "inst-plaintext".to_string())]
        .into_iter()
        .collect();

    let (committed_tx, committed_rx) = mpsc::channel();
    let (go_tx, go_rx) = mpsc::channel();

    // Instance-save span: hold the txn lock across its full read-modify-write
    // cycle, then release only after the definition save has probed exclusion.
    let instance_store_path = store_path.clone();
    let instance_lock_dir = lock_dir.clone();
    let instance_save = std::thread::spawn(move || {
        let store = FakeCombinedStore::new();
        let guard =
            transaction_lock_at(&instance_lock_dir).expect("instance save acquires txn lock");
        save_managed_agents_at(
            &instance_store_path,
            Some(&store),
            std::slice::from_ref(&instance),
        )
        .expect("instance save commits");
        committed_tx.send(()).expect("signal instance committed");
        go_rx.recv().expect("definition save probed exclusion");
        drop(guard);
    });

    committed_rx
        .recv()
        .expect("instance save committed while holding the lock");

    // Mid-cycle the definition save must be excluded: a non-blocking acquire on
    // an independent OFD fails while the instance save holds the lock. This is
    // what makes the ordering the lock's doing, not the scheduler's.
    let probe = std::fs::File::open(&lock_dir).expect("open store dir");
    let rc = unsafe { libc::flock(probe.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    assert_eq!(
        rc, -1,
        "a definition save must NOT acquire the txn lock while an instance save holds it"
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::EWOULDBLOCK),
        "exclusion must report EWOULDBLOCK"
    );
    drop(probe);

    // Hand back: the instance save releases and exits, then the definition save
    // acquires through the real blocking lock. Its instance re-read now sees
    // the committed instance.
    go_tx.send(()).expect("release instance save");
    instance_save.join().expect("instance save thread");

    let mut definition: ManagedAgentRecord = serde_json::from_str(
        r#"{
            "pubkey": "",
            "name": "def-def-slug",
            "slug": "def-slug",
            "relay_url": "",
            "acp_command": "buzz-acp",
            "agent_command": "goose",
            "agent_args": [],
            "mcp_command": "",
            "turn_timeout_seconds": 320,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        }"#,
    )
    .expect("definition record");
    definition.env_vars = [("DEF_SECRET".to_string(), "def-plaintext".to_string())]
        .into_iter()
        .collect();

    let def_store = FakeCombinedStore::new();
    let guard = transaction_lock_at(&lock_dir).expect("definition save acquires after release");
    save_agent_definitions_at(
        &store_path,
        Some(&def_store),
        std::slice::from_ref(&definition),
    )
    .expect("definition save commits");
    drop(guard);

    // Neither half's secrets may appear inline in the committed JSON: the
    // instance the definition save re-read stays projected, and the definition
    // it wrote is projected too.
    let committed = std::fs::read_to_string(&store_path).expect("read committed");
    assert!(
        !committed.contains("inst-plaintext"),
        "the instance env must stay projected, never re-inlined by the definition save"
    );
    assert!(
        !committed.contains("nsec1instkey"),
        "the instance key must stay in the keyring, never re-inlined by the definition save"
    );
    assert!(
        !committed.contains("def-plaintext"),
        "the definition env must be projected, never written inline"
    );

    let records: Vec<ManagedAgentRecord> =
        serde_json::from_str(&committed).expect("parse committed");
    let instance = records
        .iter()
        .find(|r| r.pubkey == "instance-pub")
        .expect("the instance must survive the concurrent definition save");
    assert!(
        instance.env_vars_ref.is_some() && instance.env_vars.is_empty(),
        "the instance env must remain a projected ref with no inline residue"
    );
    assert!(
        instance.private_key_nsec.is_empty(),
        "the instance key must remain projected out of the JSON"
    );
    let definition = records
        .iter()
        .find(|r| r.pubkey.is_empty() && r.slug.as_deref() == Some("def-slug"))
        .expect("the definition must be committed alongside the instance");
    assert!(
        definition.env_vars_ref.is_some() && definition.env_vars.is_empty(),
        "the definition env must be a projected ref with no inline residue"
    );
}
