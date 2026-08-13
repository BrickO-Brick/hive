//! W6-A interleave coverage.
//!
//! The identity-persist entry points (`import_identity`,
//! `persist_current_identity`, and the pairing recover path) now hold the same
//! cross-process secret transaction lock that a concurrent agent save/GC holds,
//! so an identity keyring write can no longer interleave with a projection
//! transaction on the shared `SecretStore` blob.
//!
//! Both real callers reach the lock through
//! `acquire_secret_txn_lock`, which resolves it as
//! `transaction_lock_at(store_txn_lock_dir(store_file))`. Driving the Tauri
//! commands themselves needs a live `AppHandle` (integration-only); the unit
//! level below proves the property that matters — that the identity-persist
//! span and an agent-save span derive one lock target from the shared store
//! file and mutually exclude on it.

/// While the identity-persist span holds the transaction lock, a concurrent
/// agent-save projection span (an independent open file description, exactly
/// what a second process or a parallel save has) must be excluded, and may
/// acquire only after the persist span releases.
///
/// Deterministic by handshake: the persist span holds the lock until the save
/// span has probed exclusion and explicitly hands back — no timing sleeps. The
/// `released` flag is set before the guard drops, so whenever the blocking
/// acquire returns it is guaranteed to observe it, proving the save span could
/// only proceed after release.
#[cfg(all(unix, feature = "system-keyring"))]
#[test]
fn test_identity_persist_span_excludes_concurrent_agent_save_on_shared_txn_lock() {
    use crate::secret_store::{store_txn_lock_dir, transaction_lock_at};
    use std::os::unix::io::AsRawFd;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::sync::Arc;

    // A store directory shared by identity and agent secrets — the same file
    // `managed_agents_store_path` yields and `acquire_secret_txn_lock` resolves.
    let dir = std::env::temp_dir().join(format!("buzz-w6a-interleave-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create store dir");
    let store_file = dir.join("managed-agents.json");
    std::fs::write(&store_file, b"[]").expect("seed store file");

    // The crux of W6-A: both spans derive the lock target from the store FILE
    // via `store_txn_lock_dir`, so identity persist and agent save contend on
    // one directory inode instead of racing on the shared keyring blob.
    let lock_dir = store_txn_lock_dir(&store_file);

    let released = Arc::new(AtomicBool::new(false));
    let (held_tx, held_rx) = mpsc::channel();
    let (go_tx, go_rx) = mpsc::channel();

    // Identity-persist span: hold the txn lock across its keyring write, then
    // release only once the save span has verified exclusion.
    let persist_dir = lock_dir.clone();
    let persist_released = Arc::clone(&released);
    let persist = std::thread::spawn(move || {
        let guard = transaction_lock_at(&persist_dir).expect("identity persist acquires txn lock");
        held_tx.send(()).expect("signal lock held");
        go_rx.recv().expect("save span verified exclusion");
        // Set BEFORE releasing: the waiter can only unblock once this drops, so
        // it is guaranteed to observe `true`.
        persist_released.store(true, Ordering::SeqCst);
        drop(guard);
    });

    held_rx
        .recv()
        .expect("identity persist reported the lock held");

    // Agent-save projection span: a non-blocking acquire on an independent OFD
    // must fail while identity persist holds the lock.
    let probe = std::fs::File::open(&lock_dir).expect("agent save opens store dir");
    let rc = unsafe { libc::flock(probe.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    assert_eq!(
        rc, -1,
        "an agent save must NOT acquire the txn lock while identity persist holds it"
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::EWOULDBLOCK),
        "exclusion must report EWOULDBLOCK"
    );
    drop(probe);

    // Hand back: persist releases, and the save span acquires through the real
    // blocking API. It returns only after release — proven by `released`.
    go_tx.send(()).expect("release identity persist span");
    let save_guard =
        transaction_lock_at(&lock_dir).expect("agent save acquires txn lock after release");
    assert!(
        released.load(Ordering::SeqCst),
        "agent save acquired the lock only after the identity persist span released it"
    );
    drop(save_guard);

    persist.join().expect("identity persist thread");
    let _ = std::fs::remove_dir_all(&dir);
}
