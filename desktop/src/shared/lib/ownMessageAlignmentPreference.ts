import * as React from "react";

/** Horizontal placement for messages authored by the signed-in account. */
export type OwnMessageAlignment = "left" | "right";

export const OWN_MESSAGE_ALIGNMENT_STORAGE_KEY =
  "buzz.appearance.ownMessageAlignment";
export const DEFAULT_OWN_MESSAGE_ALIGNMENT: OwnMessageAlignment = "left";

const savedListeners = new Set<() => void>();
const appliedListeners = new Set<() => void>();
let savedOwnMessageAlignment: OwnMessageAlignment =
  DEFAULT_OWN_MESSAGE_ALIGNMENT;
let appliedOwnMessageAlignment: OwnMessageAlignment =
  DEFAULT_OWN_MESSAGE_ALIGNMENT;

export function parseOwnMessageAlignment(
  value: string | null | undefined,
): OwnMessageAlignment {
  return value === "left" || value === "right"
    ? value
    : DEFAULT_OWN_MESSAGE_ALIGNMENT;
}

function readStoredOwnMessageAlignment(): OwnMessageAlignment {
  try {
    return parseOwnMessageAlignment(
      globalThis.localStorage?.getItem(OWN_MESSAGE_ALIGNMENT_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_OWN_MESSAGE_ALIGNMENT;
  }
}

function applyOwnMessageAlignment(alignment: OwnMessageAlignment): void {
  globalThis.document?.documentElement?.setAttribute(
    "data-own-message-alignment",
    alignment,
  );
}

function notify(listeners: Set<() => void>): void {
  for (const listener of listeners) listener();
}

/** Apply the persisted preference before React renders to avoid a layout jump. */
export function initializeOwnMessageAlignmentPreference(): void {
  const nextAlignment = readStoredOwnMessageAlignment();
  const savedChanged = nextAlignment !== savedOwnMessageAlignment;
  const appliedChanged = nextAlignment !== appliedOwnMessageAlignment;
  savedOwnMessageAlignment = nextAlignment;
  appliedOwnMessageAlignment = nextAlignment;
  applyOwnMessageAlignment(nextAlignment);
  if (savedChanged) notify(savedListeners);
  if (appliedChanged) notify(appliedListeners);
}

function subscribeSaved(listener: () => void): () => void {
  savedListeners.add(listener);
  return () => savedListeners.delete(listener);
}

function subscribeApplied(listener: () => void): () => void {
  appliedListeners.add(listener);
  return () => appliedListeners.delete(listener);
}

export function getOwnMessageAlignment(): OwnMessageAlignment {
  return appliedOwnMessageAlignment;
}

export function getSavedOwnMessageAlignment(): OwnMessageAlignment {
  return savedOwnMessageAlignment;
}

export function setOwnMessageAlignment(alignment: OwnMessageAlignment): void {
  const savedChanged = alignment !== savedOwnMessageAlignment;
  const appliedChanged = alignment !== appliedOwnMessageAlignment;
  savedOwnMessageAlignment = alignment;
  appliedOwnMessageAlignment = alignment;
  applyOwnMessageAlignment(alignment);
  try {
    globalThis.localStorage?.setItem(
      OWN_MESSAGE_ALIGNMENT_STORAGE_KEY,
      alignment,
    );
  } catch {
    // Persistence is best-effort; the live preference still applies.
  }
  if (savedChanged) notify(savedListeners);
  if (appliedChanged) notify(appliedListeners);
}

/** Temporarily apply an alignment without changing the saved preference. */
export function previewOwnMessageAlignment(
  alignment: OwnMessageAlignment | null,
): void {
  const nextAlignment = alignment ?? savedOwnMessageAlignment;
  if (nextAlignment === appliedOwnMessageAlignment) return;
  appliedOwnMessageAlignment = nextAlignment;
  applyOwnMessageAlignment(nextAlignment);
  notify(appliedListeners);
}

/** The currently applied alignment, including a temporary settings preview. */
export function useOwnMessageAlignment(): OwnMessageAlignment {
  return React.useSyncExternalStore(
    subscribeApplied,
    getOwnMessageAlignment,
    () => DEFAULT_OWN_MESSAGE_ALIGNMENT,
  );
}

/** The persisted alignment used to mark the selected settings option. */
export function useSavedOwnMessageAlignment(): OwnMessageAlignment {
  return React.useSyncExternalStore(
    subscribeSaved,
    getSavedOwnMessageAlignment,
    () => DEFAULT_OWN_MESSAGE_ALIGNMENT,
  );
}
