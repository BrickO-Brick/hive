import * as React from "react";

import type { MessageTargetNavigation } from "@/app/navigation/messageTargetNavigationGuard";
import { registerMessageTargetNavigationGuard } from "@/app/navigation/messageTargetNavigationGuard";

export function useMessageLinkNavigationGuard(
  requireThreadEditResolution: () => boolean,
  activeChannelId: string | null,
  openThreadHeadId: string | null,
) {
  const guard = React.useCallback(
    (target: MessageTargetNavigation) => {
      if (
        target.kind === "channel-message" &&
        target.channelId === activeChannelId &&
        target.threadRootId === openThreadHeadId
      ) {
        return true;
      }
      return requireThreadEditResolution();
    },
    [activeChannelId, openThreadHeadId, requireThreadEditResolution],
  );
  React.useLayoutEffect(
    () => registerMessageTargetNavigationGuard(guard),
    [guard],
  );
}
