import * as React from "react";

import {
  abandonChannelSwitchTrace,
  markChannelSwitchRouteCommit,
  settleChannelSwitchTrace,
} from "@/shared/lib/channelSwitchPerf";
import type { ChannelType } from "@/shared/api/types";

/**
 * Switch-trace stage marks for the channel screen. Route commit fires in a
 * layout effect — before the first paint — of the first commit where the
 * target channel object has resolved; settle fires once its timeline leaves
 * the loading latch. Both are no-ops unless goChannel opened a trace for this
 * channel. Forum readiness is owned by ForumView's own queries, which the
 * timeline latch cannot observe — those traces are abandoned instead of
 * underreported.
 */
export function useChannelSwitchTraceMarks({
  activeChannelId,
  activeChannelType,
  isTimelineLoading,
}: {
  activeChannelId: string | null;
  activeChannelType: ChannelType | null;
  isTimelineLoading: boolean;
}): void {
  // Layout effect: a passive effect flushes after paint, which would report
  // "commit" as first-paint time rather than commit time.
  React.useLayoutEffect(() => {
    if (activeChannelId) markChannelSwitchRouteCommit(activeChannelId);
  }, [activeChannelId]);
  React.useEffect(() => {
    if (!activeChannelId) return;
    if (activeChannelType === "forum") {
      abandonChannelSwitchTrace(activeChannelId);
      return;
    }
    if (!isTimelineLoading) {
      settleChannelSwitchTrace(activeChannelId);
    }
  }, [activeChannelId, activeChannelType, isTimelineLoading]);
}
