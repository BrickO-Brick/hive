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
  readAt: number | null;
}): void {
  React.useEffect(() => {
    if (!channelId || isMember === false || !isAtBottom) return;
    markChannelRead(
      channelId,
      readAt === null ? null : new Date(readAt * 1_000).toISOString(),
    );
  }, [channelId, isAtBottom, isMember, markChannelRead, readAt]);
}
