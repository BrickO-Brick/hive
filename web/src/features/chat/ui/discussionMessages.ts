import type { NostrEvent } from "@/shared/lib/nostr-client";

export type HiveConversation = {
  createdAt: number;
  id: string;
  title: string;
};

function eventTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

function threadAnchor(event: NostrEvent): string | undefined {
  const root = event.tags.find(
    (tag) => tag[0] === "e" && tag[3] === "root",
  )?.[1];
  return (
    root ?? event.tags.find((tag) => tag[0] === "e" && tag[3] === "reply")?.[1]
  );
}

export function conversationsFromMessages(
  messages: NostrEvent[],
): HiveConversation[] {
  const byId = new Map<string, HiveConversation>();
  for (const message of messages) {
    const id = eventTag(message, "conversation");
    const title = eventTag(message, "title")?.trim();
    if (!id || !title || eventTag(message, "conversation-meta") !== "1") {
      continue;
    }
    const current = byId.get(id);
    if (!current || current.createdAt < message.created_at) {
      byId.set(id, { createdAt: message.created_at, id, title });
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.title.localeCompare(right.title),
  );
}

export function selectDiscussionMessages(
  messages: NostrEvent[],
  activeDiscussionId: string | null,
  activeConversationId: string | null = null,
): { activeRoot: NostrEvent | null; visibleMessages: NostrEvent[] } {
  const discussionRoots = messages.filter(
    (message) => eventTag(message, "discussion") && !threadAnchor(message),
  );

  if (!activeDiscussionId && activeConversationId) {
    const conversationMessages = messages.filter(
      (message) =>
        eventTag(message, "conversation") === activeConversationId &&
        eventTag(message, "conversation-meta") !== "1",
    );
    const roots = new Set(conversationMessages.map((message) => message.id));
    return {
      activeRoot: null,
      visibleMessages: messages.filter(
        (message) =>
          (eventTag(message, "conversation") === activeConversationId &&
            eventTag(message, "conversation-meta") !== "1") ||
          roots.has(threadAnchor(message) ?? ""),
      ),
    };
  }

  if (!activeDiscussionId) {
    const discussionRootIds = new Set(
      discussionRoots.map((message) => message.id),
    );
    const conversationRootIds = new Set(
      messages
        .filter((message) => eventTag(message, "conversation"))
        .map((message) => message.id),
    );
    return {
      activeRoot: null,
      visibleMessages: messages.filter((message) => {
        if (eventTag(message, "discussion")) return false;
        if (eventTag(message, "conversation")) return false;
        const root = threadAnchor(message);
        return (
          !root ||
          (!discussionRootIds.has(root) && !conversationRootIds.has(root))
        );
      }),
    };
  }

  const activeRoots = discussionRoots.filter(
    (message) => eventTag(message, "discussion") === activeDiscussionId,
  );
  const activeRootIds = new Set(activeRoots.map((message) => message.id));
  return {
    activeRoot: activeRoots[0] ?? null,
    visibleMessages: messages.filter(
      (message) =>
        eventTag(message, "discussion") === activeDiscussionId ||
        activeRootIds.has(threadAnchor(message) ?? ""),
    ),
  };
}
