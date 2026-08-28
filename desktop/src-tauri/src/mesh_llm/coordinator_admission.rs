use std::time::Duration;

use tauri::{AppHandle, Manager};

/// Prevent a flaky startup mode probe from creating an unbounded whole-app
/// restart loop while recovering a self-only fallback into open mode.
const MODE_RECOVERY_RESTART_COOLDOWN: Duration = Duration::from_secs(10 * 60);
const MODE_RECOVERY_RESTART_MARKER: &str = "mesh-mode-recovery-restart";

fn mode_recovery_restart_marker(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))?
        .join(MODE_RECOVERY_RESTART_MARKER))
}

pub(super) fn mode_recovery_restart_is_throttled(app: &AppHandle) -> Result<bool, String> {
    let marker = mode_recovery_restart_marker(app)?;
    let modified = match std::fs::metadata(marker).and_then(|metadata| metadata.modified()) {
        Ok(modified) => modified,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("failed to read mesh restart marker: {error}")),
    };
    Ok(modified
        .elapsed()
        .is_ok_and(|elapsed| elapsed < MODE_RECOVERY_RESTART_COOLDOWN))
}

pub(super) fn mark_mode_recovery_restart(app: &AppHandle) -> Result<(), String> {
    let marker = mode_recovery_restart_marker(app)?;
    if let Some(parent) = marker.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create app data directory: {error}"))?;
    }
    std::fs::write(marker, b"self-only-to-open\n")
        .map_err(|error| format!("failed to write mesh restart marker: {error}"))
}

pub(super) fn clear_mode_recovery_restart(app: &AppHandle) {
    if let Ok(marker) = mode_recovery_restart_marker(app) {
        match std::fs::remove_file(marker) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => eprintln!("buzz-mesh: failed to clear mesh restart marker: {error}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ModeEvidence {
    Open,
    Closed,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct ModeReconcileState {
    pending: Option<ModeEvidence>,
    consecutive_unknown: u8,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ModeReconcileAction {
    Keep,
    AwaitConfirm,
    RestartProcess,
}

/// Require two consecutive mode observations before restarting the whole app.
/// Unknown observations preserve a running policy once, but a second
/// consecutive unknown while admission is unenforced restarts fail-closed.
pub(super) fn mode_reconcile_action(
    state: &mut ModeReconcileState,
    evidence: Result<ModeEvidence, ()>,
    running_open: bool,
) -> ModeReconcileAction {
    match evidence {
        Err(()) => {
            state.pending = None;
            state.consecutive_unknown = state.consecutive_unknown.saturating_add(1);
            if running_open && state.consecutive_unknown >= 2 {
                state.consecutive_unknown = 0;
                ModeReconcileAction::RestartProcess
            } else {
                ModeReconcileAction::Keep
            }
        }
        Ok(observed) => {
            state.consecutive_unknown = 0;
            let transition = (running_open && observed == ModeEvidence::Closed)
                || (!running_open && observed == ModeEvidence::Open);
            if !transition {
                state.pending = None;
                return ModeReconcileAction::Keep;
            }
            if state.pending == Some(observed) {
                state.pending = None;
                ModeReconcileAction::RestartProcess
            } else {
                state.pending = Some(observed);
                ModeReconcileAction::AwaitConfirm
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transition_requires_two_matching_observations() {
        let mut state = ModeReconcileState::default();
        assert_eq!(
            mode_reconcile_action(&mut state, Ok(ModeEvidence::Closed), true),
            ModeReconcileAction::AwaitConfirm
        );
        assert_eq!(
            mode_reconcile_action(&mut state, Ok(ModeEvidence::Closed), true),
            ModeReconcileAction::RestartProcess
        );
    }

    #[test]
    fn recovery_cancels_pending_restart() {
        let mut state = ModeReconcileState::default();
        assert_eq!(
            mode_reconcile_action(&mut state, Ok(ModeEvidence::Closed), true),
            ModeReconcileAction::AwaitConfirm
        );
        assert_eq!(
            mode_reconcile_action(&mut state, Ok(ModeEvidence::Open), true),
            ModeReconcileAction::Keep
        );
        assert_eq!(state, ModeReconcileState::default());
    }

    #[test]
    fn persistently_unknown_open_runtime_restarts_fail_closed() {
        let mut state = ModeReconcileState::default();
        assert_eq!(
            mode_reconcile_action(&mut state, Err(()), true),
            ModeReconcileAction::Keep
        );
        assert_eq!(
            mode_reconcile_action(&mut state, Err(()), true),
            ModeReconcileAction::RestartProcess
        );
    }

    #[test]
    fn isolated_open_recovery_requires_confirmation() {
        let mut state = ModeReconcileState::default();
        assert_eq!(
            mode_reconcile_action(&mut state, Ok(ModeEvidence::Open), false),
            ModeReconcileAction::AwaitConfirm
        );
        assert_eq!(
            mode_reconcile_action(&mut state, Ok(ModeEvidence::Open), false),
            ModeReconcileAction::RestartProcess
        );
    }
}
