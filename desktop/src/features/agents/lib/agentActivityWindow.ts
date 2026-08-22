import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const AGENT_ACTIVITY_WINDOW_LABEL_PREFIX = "agent-activity-";

/** Whether this webview is dedicated to an agent activity feed. */
export function isAgentActivityWindow(): boolean {
  if (!isTauri()) return false;

  try {
    return getCurrentWindow().label.startsWith(
      AGENT_ACTIVITY_WINDOW_LABEL_PREFIX,
    );
  } catch {
    return false;
  }
}
