import type { RepositoryDiscussion } from "@/features/repos/repository-discussions-api";
import type { NostrEvent } from "@/shared/lib/nostr-client";
import { eventTag } from "./hiveMessageUtils";

export function latestDiscussionActivity(
  discussions: RepositoryDiscussion[],
  messages: NostrEvent[],
): ReadonlyMap<string, number> {
  const activity = new Map<string, number>();
  for (const discussion of discussions) {
    const createdAt = Date.parse(discussion.createdAt);
    if (Number.isFinite(createdAt)) {
      activity.set(discussion.id, Math.floor(createdAt / 1_000));
    }
  }
  for (const message of messages) {
    const discussionId = eventTag(message, "discussion");
    if (!discussionId) continue;
    activity.set(
      discussionId,
      Math.max(activity.get(discussionId) ?? 0, message.created_at),
    );
  }
  return activity;
}
