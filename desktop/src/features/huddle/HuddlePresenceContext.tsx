import * as React from "react";

import { reconstructHuddlePresence } from "@/features/huddle/lib/huddlePresence";
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
const HuddlePresenceContext = React.createContext<ReadonlySet<string>>(
  EMPTY_HUDDLE_PRESENCE,
);

/** Keeps one community-wide lifecycle subscription for name indicators. */
export function HuddlePresenceProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [participantPubkeys, setParticipantPubkeys] = React.useState<
    ReadonlySet<string>
  >(EMPTY_HUDDLE_PRESENCE);

  React.useEffect(() => {
    let disposed = false;
    let cleanup: (() => Promise<void>) | null = null;
    const events = new Map<string, RelayEvent>();

    void relayClient
      .subscribeLive(
        {
          kinds: [
            KIND_HUDDLE_STARTED,
            KIND_HUDDLE_PARTICIPANT_JOINED,
            KIND_HUDDLE_PARTICIPANT_LEFT,
            KIND_HUDDLE_ENDED,
          ],
          limit: 1000,
        },
        (event) => {
          if (disposed || events.has(event.id)) return;
          events.set(event.id, event);
          setParticipantPubkeys(reconstructHuddlePresence(events.values()));
        },
      )
      .then((dispose) => {
        if (disposed) {
          void dispose();
          return;
        }
        cleanup = dispose;
      })
      .catch((error) => {
        console.error("[huddle] Presence subscription failed:", error);
      });

    return () => {
      disposed = true;
      if (cleanup) void cleanup();
      setParticipantPubkeys(EMPTY_HUDDLE_PRESENCE);
    };
  }, []);

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
