import { getThreadReference } from "@/features/messages/lib/threading";
import type { TimelineMessage } from "@/features/messages/types";

import type { CollectionReference } from "./types";

type CollectionActionMessage = Pick<
  TimelineMessage,
  "depth" | "id" | "rootId" | "tags"
>;

export type MessageCollectionAction = {
  menuLabel: "Add message to Collection" | "Add thread to Collection";
  reference: CollectionReference;
  type: "message" | "thread";
};

/**
 * Derives the single Collection action appropriate for a rendered message.
 * Thread roots represent the whole thread; replies represent only themselves.
 */
export function messageCollectionAction(
  channelId: string,
  message: CollectionActionMessage,
): MessageCollectionAction {
  const threadRootId =
    message.rootId ??
    getThreadReference(message.tags ?? []).rootId ??
    (message.depth === 0 ? message.id : null);

  if (threadRootId === message.id) {
    return {
      menuLabel: "Add thread to Collection",
      reference: {
        type: "thread",
        channel_id: channelId,
        root_event_id: message.id,
      },
      type: "thread",
    };
  }

  return {
    menuLabel: "Add message to Collection",
    reference: {
      type: "message",
      channel_id: channelId,
      event_id: message.id,
    },
    type: "message",
  };
}
