import type { NostrEvent } from "@/shared/lib/nostr-client";

function eventTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

function threadRoot(event: NostrEvent): string | undefined {
  return event.tags.find((tag) => tag[0] === "e" && tag[3] === "root")?.[1];
}

export function selectDiscussionMessages(
  messages: NostrEvent[],
  activeDiscussionId: string | null,
): { activeRoot: NostrEvent | null; visibleMessages: NostrEvent[] } {
  const discussionRoots = messages.filter(
    (message) => eventTag(message, "discussion") && !threadRoot(message),
  );

  if (!activeDiscussionId) {
    const discussionRootIds = new Set(
      discussionRoots.map((message) => message.id),
    );
    return {
      activeRoot: null,
      visibleMessages: messages.filter((message) => {
        if (eventTag(message, "discussion")) return false;
        const root = threadRoot(message);
        return !root || !discussionRootIds.has(root);
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
        activeRootIds.has(threadRoot(message) ?? ""),
    ),
  };
}
