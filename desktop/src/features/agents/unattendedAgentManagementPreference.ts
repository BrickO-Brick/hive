import * as React from "react";

/**
 * Owner opt-in: let owned agents create, update, and delete agents through
 * `buzz agents …` without a review dialog. Off by default — every request
 * then opens the existing review surface and nothing changes until the owner
 * saves it.
 */
export const UNATTENDED_AGENT_MANAGEMENT_STORAGE_KEY =
  "buzz.agents.unattendedAgentManagement";

const listeners = new Set<() => void>();
let enabled = readStored();

function readStored(): boolean {
  try {
    return (
      globalThis.localStorage?.getItem(
        UNATTENDED_AGENT_MANAGEMENT_STORAGE_KEY,
      ) === "1"
    );
  } catch {
    return false;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isUnattendedAgentManagementEnabled(): boolean {
  return enabled;
}

export function setUnattendedAgentManagementEnabled(next: boolean): void {
  enabled = next;
  try {
    globalThis.localStorage?.setItem(
      UNATTENDED_AGENT_MANAGEMENT_STORAGE_KEY,
      next ? "1" : "0",
    );
  } catch {
    // Persistence is best-effort; the in-memory preference still applies.
  }
  for (const listener of listeners) listener();
}

export function useUnattendedAgentManagement(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    isUnattendedAgentManagementEnabled,
    () => false,
  );
}
