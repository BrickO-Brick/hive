//! Durable identity-transition intent journal (P28-C1).
//!
//! When the identity-transition coordinator cannot prove either identity
//! canonical after persistence ([`PersistenceOutcome::Indeterminate`]), the
//! ambiguity must survive a return AND a restart — an in-memory latch alone is
//! not durable. Before dispatching the durable B write the coordinator writes
//! an `IdentityTransitionPending { from_pubkey, to_pubkey }` row here (fsync'd,
//! same atomicity as the migration marker), and clears it only at the two
//! proven exits (`Committed` finished, or `DefinitelyUnchanged`/verified
//! rollback). Startup honors a surviving row: a pending row plus an unreachable
//! keyring plus an A-valued `identity.key` boots recovery-blocked (ephemeral
//! posture, all signing disabled) rather than resuming fully-signable A.
//!
//! The content is a small JSON object so a human (or a future migration) can
//! read the intent. Only the file's durable existence + parseable content is
//! load-bearing; a corrupt row is treated as "pending, unresolved" — the
//! fail-closed default, never silently ignored.

use std::path::{Path, PathBuf};

/// A durable record that an identity transition began but has not reached a
/// proven exit. Persisted as JSON; both pubkeys are hex for human readability
/// and cross-version stability.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct IdentityTransitionPending {
    /// The identity active before the transition (A).
    pub(crate) from_pubkey: String,
    /// The identity the transition is committing to (B).
    pub(crate) to_pubkey: String,
}

/// Filename of the pending-transition journal within `data_dir`.
fn journal_path(data_dir: &Path) -> PathBuf {
    data_dir.join("identity_transition_pending.json")
}

/// Durably write the pending-transition intent, fsync'd, BEFORE the coordinator
/// dispatches the durable B write. Returns `Err` if the row cannot be made
/// durable — the coordinator must treat that as a hard failure and NOT proceed
/// to the durable dispatch, because an undurable journal cannot fail closed on
/// restart.
// Consumed by C5 (P28 coordinator); remove allow when the coordinator writes it.
#[allow(dead_code)]
pub(crate) fn write_pending(
    data_dir: &Path,
    pending: &IdentityTransitionPending,
) -> Result<(), String> {
    use atomic_write_file::AtomicWriteFile;
    use std::io::Write;

    let body = serde_json::to_vec(pending)
        .map_err(|e| format!("serialize identity-transition journal: {e}"))?;
    let mut file = AtomicWriteFile::open(journal_path(data_dir))
        .map_err(|e| format!("open identity-transition journal for atomic write: {e}"))?;
    file.write_all(&body)
        .map_err(|e| format!("write identity-transition journal: {e}"))?;
    file.commit()
        .map_err(|e| format!("commit identity-transition journal: {e}"))
}

/// Clear the pending-transition journal at a proven exit. Idempotent: a missing
/// file is success. Best-effort on the delete itself — a proven-canonical
/// identity must never be blocked by a stale journal delete failure; the next
/// coordinator run or a manual retry can clear it. Returns `Err` only to
/// surface a diagnostic; callers on the proven-exit path log and continue.
// Consumed by C5 (P28 coordinator); remove allow when the coordinator clears it.
#[allow(dead_code)]
pub(crate) fn clear_pending(data_dir: &Path) -> Result<(), String> {
    let path = journal_path(data_dir);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("clear identity-transition journal: {e}")),
    }
}

/// Whether a pending-transition row survives on disk. Startup honors this: a
/// present-but-unparseable row is still "pending" (fail closed) — the file
/// existing at all proves the coordinator began a transition it could not prove
/// resolved. Returns `Ok(None)` only when no file exists.
// Consumed by C5 (P28 startup); remove allow when startup reads it.
#[allow(dead_code)]
pub(crate) fn read_pending(data_dir: &Path) -> Result<Option<IdentityTransitionPending>, String> {
    let path = journal_path(data_dir);
    match std::fs::read(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read identity-transition journal: {e}")),
        // A present row parses to the recorded intent, or — if corrupt — to a
        // sentinel whose empty pubkeys still signal "pending, unresolved".
        Ok(bytes) => match serde_json::from_slice::<IdentityTransitionPending>(&bytes) {
            Ok(pending) => Ok(Some(pending)),
            Err(_) => Ok(Some(IdentityTransitionPending {
                from_pubkey: String::new(),
                to_pubkey: String::new(),
            })),
        },
    }
}

/// Whether a pending-transition row exists at all, regardless of parseability.
/// This is the startup fail-closed gate: any surviving journal means the last
/// transition did not reach a proven exit.
// Consumed by C5 (P28 startup); remove allow when startup checks it.
#[allow(dead_code)]
pub(crate) fn pending_exists(data_dir: &Path) -> bool {
    journal_path(data_dir).exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending() -> IdentityTransitionPending {
        IdentityTransitionPending {
            from_pubkey: "a".repeat(64),
            to_pubkey: "b".repeat(64),
        }
    }

    #[test]
    fn write_then_read_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_pending(dir.path()).unwrap().is_none());
        assert!(!pending_exists(dir.path()));
        write_pending(dir.path(), &pending()).unwrap();
        assert!(pending_exists(dir.path()));
        assert_eq!(read_pending(dir.path()).unwrap(), Some(pending()));
    }

    #[test]
    fn clear_removes_the_row_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        write_pending(dir.path(), &pending()).unwrap();
        clear_pending(dir.path()).unwrap();
        assert!(!pending_exists(dir.path()));
        assert!(read_pending(dir.path()).unwrap().is_none());
        // Idempotent: clearing an absent journal is success.
        clear_pending(dir.path()).unwrap();
    }

    #[test]
    fn corrupt_row_reads_as_pending_not_absent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(journal_path(dir.path()), b"{ not json").unwrap();
        // Fail closed: a corrupt row still means a transition is unresolved.
        assert!(pending_exists(dir.path()));
        let read = read_pending(dir.path()).unwrap();
        assert!(read.is_some(), "corrupt row must not read as absent");
    }
}
