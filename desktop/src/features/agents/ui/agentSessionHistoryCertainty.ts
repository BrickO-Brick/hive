/**
 * Whether an empty transcript is a fact or merely an absence of evidence.
 *
 * Archived observer history is only readable when the viewing identity holds an
 * `owner_p` save subscription and the backfill index has been populated for the
 * channel. When either is missing, `useLoadArchivedObserverEvents` returns no
 * rows and forces `hasOlderArchived` to false — the same shape as a channel
 * where the agent genuinely never ran. Rendering "No ACP activity yet" in that
 * state asserts something we did not check, and a supervisor who reads it may
 * conclude an agent did nothing when its history was simply unavailable.
 *
 * So the distinction is preserved here rather than collapsed at the call site.
 */
export type TranscriptHistoryCertainty = "known-empty" | "unknown";

export type TranscriptHistoryInputs = {
  /**
   * Result of the `owner_p` save-subscription check: null while unresolved,
   * false when the identity has no subscription (or the lookup failed).
   */
  hasSubscription: boolean | null;
  /** Channel whose archive would be read; null means no archive was consulted. */
  channelId: string | null;
  /** True once the archive backfill/hydration pass finished for this channel. */
  archiveHydrated: boolean;
};

/**
 * Decide whether emptiness can be stated as fact.
 *
 * Only an identity with a resolved subscription, a real channel, and a
 * completed hydration pass has actually looked at the whole history. Every
 * other combination is uncertainty and must say so.
 */
export function getTranscriptHistoryCertainty({
  hasSubscription,
  channelId,
  archiveHydrated,
}: TranscriptHistoryInputs): TranscriptHistoryCertainty {
  if (hasSubscription !== true) return "unknown";
  if (!channelId) return "unknown";
  if (!archiveHydrated) return "unknown";
  return "known-empty";
}

export type TranscriptEmptyCopy = {
  title: string;
  description: string;
};

/**
 * Copy for the uncertain case.
 *
 * Phrased as a statement about what this view can see rather than about what
 * the agent did, and it never uses "no activity" — the whole point is that we
 * do not know. `reason` names the specific gap so the message stays actionable
 * instead of vaguely ominous.
 */
export function getUncertainHistoryCopy(
  inputs: TranscriptHistoryInputs,
): TranscriptEmptyCopy {
  if (inputs.hasSubscription === null) {
    return {
      title: "Checking for earlier activity",
      description: "Looking up whether archived history is available here.",
    };
  }
  if (inputs.hasSubscription === false) {
    return {
      title: "Earlier activity may not be shown",
      description:
        "Archived history isn't indexed for this identity, so only activity observed live appears here.",
    };
  }
  return {
    title: "Earlier activity may still be loading",
    description:
      "Archived history for this channel hasn't finished loading, so older activity may be missing.",
  };
}
