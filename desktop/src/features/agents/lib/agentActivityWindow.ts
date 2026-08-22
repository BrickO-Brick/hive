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

/** Build the concise native title for a channel-scoped activity window. */
export function agentActivityWindowTitle(
  agentName: string,
  channelName: string,
): string {
  const normalizedAgentName = agentName.trim() || "Agent";
  const normalizedChannelName = channelName.trim().replace(/^#+/, "");
  return `${normalizedAgentName} · #${normalizedChannelName}`;
}

/** Keep a companion window's native title aligned with its resolved scope. */
export async function setAgentActivityWindowTitle(
  agentName: string,
  channelName: string,
): Promise<boolean> {
  if (!isAgentActivityWindow() || !channelName.trim()) return false;

  await getCurrentWindow().setTitle(
    agentActivityWindowTitle(agentName, channelName),
  );
  return true;
}
