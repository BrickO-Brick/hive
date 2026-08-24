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

/** Community encoded into a companion bootstrap hash. */
export function companionCommunityIdForHash(hash: string): string | null {
  const query = hash.indexOf("?");
  if (query === -1) return null;
  return new URLSearchParams(hash.slice(query + 1)).get("community");
}

/** Immutable community selected by a native companion's bootstrap URL. */
export function companionCommunityId(
  hash: string = typeof window === "undefined" ? "" : window.location.hash,
): string | null | undefined {
  if (currentCompanionWindowKind() === null) return undefined;
  return companionCommunityIdForHash(hash);
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
