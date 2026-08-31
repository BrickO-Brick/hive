import * as React from "react";

import { useRelaySelfQuery } from "@/features/moderation/hooks";
import {
  fetchActiveHuddleLifecycle,
  HuddlePresenceTracker,
} from "@/features/huddle/lib/huddlePresence";
import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_HUDDLE_ENDED,
  KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT,
  KIND_HUDDLE_STARTED,
} from "@/shared/constants/kinds";
import { normalizePubkey } from "@/shared/lib/pubkey";

const EMPTY_HUDDLE_PRESENCE = new Set<string>();
const MAX_PENDING_LIVE_EVENTS = 1_000;
const HuddlePresenceContext = React.createContext<ReadonlySet<string>>(
  EMPTY_HUDDLE_PRESENCE,
);

/** Keeps one community-wide lifecycle subscription for name indicators. */
export function HuddlePresenceProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const relaySelfQuery = useRelaySelfQuery();
  const relaySelfPubkey = relaySelfQuery.data;
  const [participantPubkeys, setParticipantPubkeys] = React.useState<
    ReadonlySet<string>
  >(EMPTY_HUDDLE_PRESENCE);

  React.useEffect(() => {
    if (!relaySelfPubkey || relaySelfQuery.isError) {
      setParticipantPubkeys(EMPTY_HUDDLE_PRESENCE);
      return;
    }

    let disposed = false;
    let cleanup: (() => Promise<void>) | null = null;
    const tracker = new HuddlePresenceTracker(relaySelfPubkey);
    let hydrated = false;
    let hydrationFailed = false;
    const pendingLiveEvents: RelayEvent[] = [];

    const applyLiveEvent = (event: RelayEvent) => {
      if (disposed) return;
      if (!hydrated) {
        if (pendingLiveEvents.length >= MAX_PENDING_LIVE_EVENTS) {
          hydrationFailed = true;
          return;
        }
        pendingLiveEvents.push(event);
        return;
      }
      if (tracker.apply(event)) setParticipantPubkeys(tracker.snapshot());
    };

    void relayClient
      .subscribeLive(
        {
          kinds: [
            KIND_HUDDLE_STARTED,
            KIND_HUDDLE_PARTICIPANT_JOINED,
            KIND_HUDDLE_PARTICIPANT_LEFT,
            KIND_HUDDLE_ENDED,
          ],
          limit: 0,
        },
        applyLiveEvent,
      )
      .then(async (dispose) => {
        if (disposed) {
          void dispose();
          return;
        }
        cleanup = dispose;
        try {
          const history = await fetchActiveHuddleLifecycle((filter) =>
            relayClient.fetchEvents(filter),
          );
          if (disposed) return;
          for (const event of history) tracker.apply(event);
        } catch (error) {
          hydrationFailed = true;
          console.error("[huddle] Presence backfill failed:", error);
        }
        if (disposed) return;
        if (hydrationFailed) {
          void dispose();
          cleanup = null;
          pendingLiveEvents.length = 0;
          setParticipantPubkeys(EMPTY_HUDDLE_PRESENCE);
          return;
        }
        hydrated = true;
        for (const event of pendingLiveEvents) tracker.apply(event);
        pendingLiveEvents.length = 0;
        setParticipantPubkeys(tracker.snapshot());
      })
      .catch((error) => {
        if (disposed) return;
        pendingLiveEvents.length = 0;
        setParticipantPubkeys(EMPTY_HUDDLE_PRESENCE);
        console.error("[huddle] Presence subscription failed:", error);
      });

    return () => {
      disposed = true;
      if (cleanup) void cleanup();
      setParticipantPubkeys(EMPTY_HUDDLE_PRESENCE);
    };
  }, [relaySelfPubkey, relaySelfQuery.isError]);

  return (
    <HuddlePresenceContext.Provider value={participantPubkeys}>
      {children}
    </HuddlePresenceContext.Provider>
  );
}

export function useIsUserInHuddle(pubkey: string | undefined): boolean {
  const participantPubkeys = React.useContext(HuddlePresenceContext);
  const normalized = normalizePubkey(pubkey ?? "");
  return normalized ? participantPubkeys.has(normalized) : false;
}
