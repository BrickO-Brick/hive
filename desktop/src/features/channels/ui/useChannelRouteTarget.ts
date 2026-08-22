import * as React from "react";

import type { TimelineMessage } from "@/features/messages/types";
import { isBroadcastReply } from "@/features/messages/lib/threading";
import type { Channel } from "@/shared/api/types";
import type { PanelValueSetter } from "./useChannelPanelHistoryState";

function getThreadRouteTarget(
  targetMessage: TimelineMessage,
  messageById: ReadonlyMap<string, TimelineMessage>,
): { expandedReplyIds: Set<string>; threadHeadId: string } | null {
  const threadHeadId = targetMessage.rootId ?? targetMessage.parentId ?? null;
  if (!threadHeadId || !messageById.has(threadHeadId)) {
    return null;
  }

  const expandedReplyIds = new Set<string>();
  let ancestorId = targetMessage.parentId ?? null;
  let guard = 0;
  const maxHops = messageById.size + 1;

  while (ancestorId && ancestorId !== threadHeadId && guard < maxHops) {
    const ancestor = messageById.get(ancestorId);
    if (!ancestor) {
      return null;
    }

    expandedReplyIds.add(ancestor.id);
    ancestorId = ancestor.parentId ?? null;
    guard += 1;
  }

  if (ancestorId !== threadHeadId) {
    return null;
  }

  return { expandedReplyIds, threadHeadId };
}

export type RouteTargetPanelAction =
  | { kind: "none" }
  | { kind: "main-timeline-only" }
  | {
      kind: "open-thread";
      expandedReplyIds: Set<string>;
      replyTargetId: string;
      scrollTargetId: string | null;
      threadHeadId: string;
    };

/**
 * Decides what a message route target does to the thread panel.
 *
 * - Top-level target without an explicit `threadRootId` (inbox message rows,
 *   desktop notifications, search hits, `buzz://` root links): the
 *   main-timeline scroll + highlight is the entire navigation. Opening the
 *   reply panel here would show an empty "no replies" pane instead of the
 *   message in its own context — the exact defect this guards against.
 * - Top-level target with an explicit `threadRootId` (inbox "Open full
 *   thread", thread-draft auto-send, channel-activity rows): the surface
 *   asked for the thread, so the panel opens at that root.
 * - Reply target: the panel opens at the thread head, scrolled to the reply.
 * - `none`: not actionable yet (broadcast reply, or the thread head is not
 *   loaded) — the caller retries when more messages arrive.
 *
 * Exported as a pure function so the routing contract is unit-testable
 * without mounting the hook.
 */
export function getRouteTargetPanelAction(
  targetMessage: TimelineMessage,
  targetThreadRootId: string | null,
  messageById: ReadonlyMap<string, TimelineMessage>,
): RouteTargetPanelAction {
  if (!targetMessage.parentId) {
    if (!targetThreadRootId) {
      return { kind: "main-timeline-only" };
    }
    return {
      kind: "open-thread",
      expandedReplyIds: new Set(),
      replyTargetId: targetMessage.id,
      scrollTargetId: null,
      threadHeadId: targetMessage.id,
    };
  }

  if (isBroadcastReply(targetMessage.tags ?? [])) {
    return { kind: "none" };
  }

  const routeTarget = getThreadRouteTarget(targetMessage, messageById);
  if (!routeTarget) {
    return { kind: "none" };
  }

  return {
    kind: "open-thread",
    expandedReplyIds: routeTarget.expandedReplyIds,
    replyTargetId: routeTarget.threadHeadId,
    scrollTargetId: targetMessage.id,
    threadHeadId: routeTarget.threadHeadId,
  };
}

function getRouteMainTimelineTargetId(
  targetMessageId: string | null,
  targetMessage: TimelineMessage | null,
): string | null {
  if (!targetMessageId) {
    return null;
  }

  if (!targetMessage?.parentId || isBroadcastReply(targetMessage.tags ?? [])) {
    return targetMessageId;
  }

  return targetMessage.rootId ?? targetMessage.parentId;
}

export function useChannelRouteTarget({
  activeChannel,
  activeChannelId,
  closeAgentSession,
  setEditTargetId,
  setExpandedThreadReplyIds,
  setOpenThreadHeadId,
  setProfilePanelPubkey,
  setThreadReplyTargetId,
  setThreadScrollTargetId,
  targetMessageId,
  targetThreadRootId,
  timelineMessages,
}: {
  activeChannel: Channel | null;
  activeChannelId: string | null;
  closeAgentSession: () => void;
  setEditTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  setExpandedThreadReplyIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setOpenThreadHeadId: PanelValueSetter;
  setProfilePanelPubkey: PanelValueSetter;
  setThreadReplyTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  setThreadScrollTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  targetMessageId: string | null;
  targetThreadRootId: string | null;
  timelineMessages: TimelineMessage[];
}) {
  const timelineMessageById = React.useMemo(
    () => new Map(timelineMessages.map((message) => [message.id, message])),
    [timelineMessages],
  );
  const targetTimelineMessage = targetMessageId
    ? (timelineMessageById.get(targetMessageId) ?? null)
    : null;
  const mainTimelineTargetMessageId = getRouteMainTimelineTargetId(
    targetMessageId,
    targetTimelineMessage,
  );
  const handledThreadRouteTargetRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!targetMessageId) {
      handledThreadRouteTargetRef.current = null;
      return;
    }

    const targetKey = `${activeChannelId ?? "none"}:${targetMessageId}`;
    if (handledThreadRouteTargetRef.current !== targetKey) {
      handledThreadRouteTargetRef.current = null;
    }

    if (
      handledThreadRouteTargetRef.current === targetKey ||
      !activeChannel ||
      activeChannel.channelType === "forum"
    ) {
      return;
    }

    const targetMessage = timelineMessageById.get(targetMessageId) ?? null;
    if (!targetMessage) {
      return;
    }

    const action = getRouteTargetPanelAction(
      targetMessage,
      targetThreadRootId,
      timelineMessageById,
    );
    if (action.kind === "none") {
      return;
    }

    if (action.kind === "main-timeline-only") {
      // Top-level target with no requested thread: the main-timeline
      // scroll/highlight (mainTimelineTargetMessageId) is the whole
      // navigation. Mark handled so a later timeline update cannot
      // re-process this target.
      handledThreadRouteTargetRef.current = targetKey;
      return;
    }

    closeAgentSession();
    // Replace so the deep-link entry itself carries the opened thread —
    // back should leave the deep link, not strip the panel from it.
    setProfilePanelPubkey(null, { replace: true });
    setEditTargetId(null);
    setOpenThreadHeadId(action.threadHeadId, { replace: true });
    setThreadReplyTargetId(action.replyTargetId);
    setThreadScrollTargetId(action.scrollTargetId);
    setExpandedThreadReplyIds(action.expandedReplyIds);
    handledThreadRouteTargetRef.current = targetKey;
  }, [
    activeChannel,
    activeChannelId,
    closeAgentSession,
    setEditTargetId,
    setExpandedThreadReplyIds,
    setOpenThreadHeadId,
    setProfilePanelPubkey,
    setThreadReplyTargetId,
    setThreadScrollTargetId,
    targetMessageId,
    targetThreadRootId,
    timelineMessageById,
  ]);

  return mainTimelineTargetMessageId;
}
