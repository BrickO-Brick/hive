use std::time::Duration;

use tauri::{AppHandle, Manager};

/// Prevent a flaky mode probe from creating an unbounded whole-app restart
/// loop while changing admission policy.
const MODE_RESTART_COOLDOWN: Duration = Duration::from_secs(10 * 60);
const MODE_RESTART_MARKER: &str = "mesh-mode-recovery-restart";

fn mode_restart_marker(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))?
        .join(MODE_RESTART_MARKER))
}

fn restart_marker_is_throttled(
    modified: std::time::SystemTime,
    now: std::time::SystemTime,
) -> bool {
    // A clock rollback makes the marker appear to be in the future. Fail safe:
    // retain the throttle rather than disabling the only cross-process bound.
    now.duration_since(modified)
        .map_or(true, |elapsed| elapsed < MODE_RESTART_COOLDOWN)
}

fn mode_restart_is_throttled(app: &AppHandle) -> Result<bool, String> {
    let marker = mode_restart_marker(app)?;
    let modified = match std::fs::metadata(marker).and_then(|metadata| metadata.modified()) {
        Ok(modified) => modified,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("failed to read mesh restart marker: {error}")),
    };
    Ok(restart_marker_is_throttled(
        modified,
        std::time::SystemTime::now(),
    ))
}

fn mark_mode_restart(app: &AppHandle, reason: &str) -> Result<(), String> {
    let marker = mode_restart_marker(app)?;
    if let Some(parent) = marker.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create app data directory: {error}"))?;
    }
    std::fs::write(marker, format!("{reason}\n"))
        .map_err(|error| format!("failed to write mesh restart marker: {error}"))
}

pub(super) fn clear_mode_restart(app: &AppHandle) {
    if let Ok(marker) = mode_restart_marker(app) {
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
    restart_requested: bool,
}

impl ModeReconcileState {
    pub(super) fn restart_requested(&self) -> bool {
        self.restart_requested
    }

    pub(super) fn latch_restart(&mut self) -> bool {
        if self.restart_requested {
            false
        } else {
            self.restart_requested = true;
            true
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ModeReconcileAction {
    Keep,
    AwaitConfirm,
    RestartProcess,
}

pub(super) fn request_mode_restart(
    app: &AppHandle,
    state: &mut ModeReconcileState,
    reason: &str,
) -> Result<bool, String> {
    if state.restart_requested || mode_restart_is_throttled(app)? {
        return Ok(false);
    }
    mark_mode_restart(app, reason)?;
    if !state.latch_restart() {
        return Ok(false);
    }
    app.request_restart();
    Ok(true)
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
    fn restart_latch_only_arms_once() {
        let mut state = ModeReconcileState::default();
        assert!(state.latch_restart());
        assert!(state.restart_requested());
        assert!(!state.latch_restart());
    }

    #[test]
    fn clock_rollback_keeps_restart_throttled() {
        let now = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(100);
        let future_marker = now + Duration::from_secs(1);
        assert!(restart_marker_is_throttled(future_marker, now));
    }

    #[test]
    fn old_restart_marker_is_not_throttled() {
        let marker = std::time::SystemTime::UNIX_EPOCH;
        let now = marker + MODE_RESTART_COOLDOWN + Duration::from_secs(1);
        assert!(!restart_marker_is_throttled(marker, now));
    }

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
