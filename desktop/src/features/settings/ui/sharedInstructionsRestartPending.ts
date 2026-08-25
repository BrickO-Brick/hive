export const SHARED_INSTRUCTIONS_RESTART_BASELINE_KEY =
  "buzz.sharedInstructionsRestartBaseline";

function storage(): Storage | null {
  return typeof window === "undefined" ? null : window.sessionStorage;
}

export function isSharedInstructionsRestartPending(current: boolean): boolean {
  const baseline = storage()?.getItem(SHARED_INSTRUCTIONS_RESTART_BASELINE_KEY);
  return baseline !== null && baseline !== String(current);
}

export function recordSharedInstructionsToggle(current: boolean): boolean {
  const store = storage();
  if (!store) return false;

  const baseline = store.getItem(SHARED_INSTRUCTIONS_RESTART_BASELINE_KEY);
  if (baseline === null) {
    store.setItem(SHARED_INSTRUCTIONS_RESTART_BASELINE_KEY, String(!current));
    return true;
  }
  if (baseline === String(current)) {
    store.removeItem(SHARED_INSTRUCTIONS_RESTART_BASELINE_KEY);
    return false;
  }
  return true;
}

export function clearSharedInstructionsRestartPending(): void {
  storage()?.removeItem(SHARED_INSTRUCTIONS_RESTART_BASELINE_KEY);
}
