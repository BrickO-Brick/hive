import type { NostrEvent } from "@/shared/lib/nostr-client";

export type HiveConversation = {
  createdAt: number;
  id: string;
  participantPubkeys: string[];
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

function isDmCreatedSystemMessage(event: NostrEvent): boolean {
  try {
    const content = JSON.parse(event.content) as { type?: unknown };
    return content.type === "dm_created";
  } catch {
    return false;
  }
}

export function conversationsFromMetadata(
  events: NostrEvent[],
  currentPubkey: string,
): HiveConversation[] {
  const byId = new Map<string, HiveConversation>();
  for (const event of events) {
    const id = eventTag(event, "d");
    const title = eventTag(event, "name")?.trim();
    const participantPubkeys = event.tags
      .filter((tag) => tag[0] === "p" && tag[1])
      .map((tag) => tag[1].toLowerCase());
    if (
      event.kind !== 39000 ||
      eventTag(event, "t") !== "dm" ||
      eventTag(event, "archived") === "true" ||
      !id ||
      !title ||
      !participantPubkeys.includes(currentPubkey.toLowerCase())
    ) {
      continue;
    }
    const current = byId.get(id);
    if (!current || current.createdAt < event.created_at) {
      byId.set(id, {
        createdAt: event.created_at,
        id,
        participantPubkeys,
        title,
      });
    }
  }
  return [...byId.values()].sort(
    (left, right) =>
      right.createdAt - left.createdAt || left.title.localeCompare(right.title),
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
    return {
      activeRoot: null,
      visibleMessages: messages.filter(
        (message) => !isDmCreatedSystemMessage(message),
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
