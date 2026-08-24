import * as React from "react";

import { useAppShell } from "@/app/AppShellContext";
import { isThreadReply } from "@/features/messages/lib/threading";
import type { FeedItem } from "@/shared/api/types";

import { useVisibleChannelReadState } from "./useVisibleChannelReadState";

/**
 * Inbox overrides for top-level rows are consumed by opening the channel.
 * Thread-reply overrides intentionally remain until their thread is read.
 */
export function getTopLevelInboxUnreadOverrideIds(
  items: FeedItem[],
  channelId: string,
): string[] {
  return items.flatMap((item) =>
    item.channelId === channelId && !isThreadReply(item.tags) ? [item.id] : [],
  );
}

export function useChannelOpenReadState(
  activeChannelId: string | null,
  isChannelMember: boolean | undefined,
  activeReadAt: number | null,
  isAtBottom: boolean,
) {
  const { feedItemState, locallyUnreadFeedItems, markChannelRead } =
    useAppShell();

  const markVisibleChannelRead = React.useCallback(
    (channelId: string, readAt: string | null) =>
      markChannelRead(channelId, readAt, { topLevelOnly: true }),
    [markChannelRead],
  );
  useVisibleChannelReadState({
    channelId: activeChannelId,
    isAtBottom,
    isMember: isChannelMember,
    markChannelRead: markVisibleChannelRead,
    readAt: activeReadAt,
  });

  React.useEffect(() => {
    if (!activeChannelId || isChannelMember === false || !isAtBottom) return;
    for (const itemId of getTopLevelInboxUnreadOverrideIds(
      locallyUnreadFeedItems,
      activeChannelId,
    )) {
      feedItemState.undoUnread(itemId);
    }
  }, [
    activeChannelId,
    feedItemState.undoUnread,
    isAtBottom,
    isChannelMember,
    locallyUnreadFeedItems,
  ]);
}
