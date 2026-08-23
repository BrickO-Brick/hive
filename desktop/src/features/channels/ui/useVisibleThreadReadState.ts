import * as React from "react";

import type { MainTimelineEntry } from "@/features/messages/lib/threadPanel";

export function useVisibleThreadReadState({
  isAtBottom,
  isMuted,
  markMessageRead,
  messages,
  threadRootId,
}: {
  isAtBottom: boolean;
  isMuted: boolean;
  markMessageRead: (messageId: string, timestamp: number) => void;
  messages: MainTimelineEntry[];
  threadRootId: string | null;
}): void {
  React.useEffect(() => {
    if (!threadRootId || !isAtBottom || isMuted) return;
    for (const entry of messages) {
      markMessageRead(entry.message.id, entry.message.createdAt);
    }
  }, [isAtBottom, isMuted, markMessageRead, messages, threadRootId]);
}
