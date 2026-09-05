import { useMemo } from "react";
import type { NostrEvent } from "@/shared/lib/nostr-client";
import type { RepositoryDiscussion } from "@/features/repos/repository-discussions-api";
import type { HiveConversation } from "./discussionMessages";
import { selectDiscussionMessages } from "./discussionMessages";

export function useHiveVisibleMessages({
  activeConversation,
  activeConversationId,
  activeDiscussion,
  activeDiscussionId,
  messages,
}: {
  activeConversation: HiveConversation | null;
  activeConversationId: string | null;
  activeDiscussion: RepositoryDiscussion | null;
  activeDiscussionId: string | null;
  messages: NostrEvent[];
}) {
  return useMemo(() => {
    if (
      (activeDiscussionId && !activeDiscussion) ||
      (activeConversationId && !activeConversation)
    ) {
      return { activeRoot: null, visibleMessages: [] };
    }
    return selectDiscussionMessages(
      messages,
      activeDiscussion?.id ?? null,
      activeConversationId,
    );
  }, [
    activeConversation,
    activeConversationId,
    activeDiscussion,
    activeDiscussionId,
    messages,
  ]);
}
