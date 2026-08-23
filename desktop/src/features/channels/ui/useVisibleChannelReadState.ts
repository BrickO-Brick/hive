import * as React from "react";

export function useVisibleChannelReadState({
  channelId,
  isAtBottom,
  isMember,
  markChannelRead,
  readAt,
}: {
  channelId: string | null;
  isAtBottom: boolean;
  isMember: boolean | undefined;
  markChannelRead: (channelId: string, readAt: string | null) => void;
  readAt: string | null;
}): void {
  React.useEffect(() => {
    if (!channelId || isMember === false || !isAtBottom) return;
    markChannelRead(channelId, readAt);
  }, [channelId, isAtBottom, isMember, markChannelRead, readAt]);
}
