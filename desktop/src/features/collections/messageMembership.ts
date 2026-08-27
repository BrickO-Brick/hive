import { getThreadReference } from "@/features/messages/lib/threading";
import type { TimelineMessage } from "@/features/messages/types";

import type { CollectionReference } from "./types";

type CollectionMessageIdentity = Pick<
  TimelineMessage,
  "depth" | "id" | "rootId" | "tags"
>;

/** Exact explicit Collection identities represented by one rendered message. */
export function collectionReferencesForMessage(
  channelId: string,
  message: CollectionMessageIdentity,
): CollectionReference[] {
  const references: CollectionReference[] = [
    {
      type: "message",
      channel_id: channelId,
      event_id: message.id,
    },
  ];
  const threadRootId =
    message.rootId ??
    getThreadReference(message.tags ?? []).rootId ??
    (message.depth === 0 ? message.id : null);
  if (threadRootId === message.id) {
    references.push({
      type: "thread",
      channel_id: channelId,
      root_event_id: message.id,
    });
  }
  return references;
}
