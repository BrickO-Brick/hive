import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type CompanionWindowKind = "agent-activity" | "huddle";

/** Classify native companion surfaces that reuse the main application shell. */
export function companionWindowKindForLabel(
  label: string,
): CompanionWindowKind | null {
  if (label.startsWith("agent-activity-")) return "agent-activity";
  if (label.startsWith("huddle-")) return "huddle";
  return null;
}

/** Return this webview's companion kind, or null for the primary app window. */
export function currentCompanionWindowKind(): CompanionWindowKind | null {
  if (!isTauri()) return null;

  try {
    return companionWindowKindForLabel(getCurrentWindow().label);
  } catch {
    // Browser previews can expose the Tauri IPC mock without window metadata.
    return null;
  }
}

/** Whether this realm owns the native pending deep-link queue. */
export function acceptsNativeDeepLinks(
  companionKind: CompanionWindowKind | null,
): boolean {
  return companionKind === null;
}

/** Whether this webview is a focused companion rather than the primary app. */
export function isCompanionWindow(): boolean {
  return currentCompanionWindowKind() !== null;
}
