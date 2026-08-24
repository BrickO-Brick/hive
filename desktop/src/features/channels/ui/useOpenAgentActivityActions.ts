import * as React from "react";
import { toast } from "sonner";

import { isAgentActivityWindow } from "@/features/agents/lib/agentActivityWindow";
import { openAgentActivityWindow } from "@/shared/api/agentActivityWindow";

type OpenAgentSession = (pubkey: string, channelId?: string | null) => void;

export function useOpenAgentActivityActions(
  activeChannelId: string | null,
  openAgentSession: OpenAgentSession,
) {
  const openInExternalWindow = React.useCallback(
    (pubkey: string, channelId?: string | null) => {
      const destinationChannelId = channelId ?? activeChannelId;
      if (!destinationChannelId) return;

      if (isAgentActivityWindow()) {
        openAgentSession(pubkey, destinationChannelId);
        return;
      }

      void openAgentActivityWindow(destinationChannelId, pubkey)
        .then((openedNativeWindow) => {
          if (!openedNativeWindow) {
            openAgentSession(pubkey, destinationChannelId);
          }
        })
        .catch((error) => {
          console.error("Failed to open agent activity window:", error);
          toast.error("Couldn't open the agent activity window.");
        });
    },
    [activeChannelId, openAgentSession],
  );
  const openInApp = React.useCallback(
    (pubkey: string, channelId?: string | null) => {
      openAgentSession(pubkey, channelId ?? activeChannelId);
    },
    [activeChannelId, openAgentSession],
  );

  return { openInApp, openInExternalWindow };
}
