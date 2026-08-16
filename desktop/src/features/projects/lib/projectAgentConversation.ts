import type {
  ProjectsConversationOpener,
  StoredProjectsAgentConversation,
} from "@/features/projects/lib/projectAgentConversationStorage";
import type { Channel } from "@/shared/api/types";
import {
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
} from "@/shared/constants/kinds";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * True when `event` is the conversation opener or comes after it in the
 * timeline's `(created_at, event_id)` ordering (`compareRelayOrder` in
 * `channelWindowStore.ts`). A bare timestamp cannot make this call — every
 * unrelated event sharing the opener's second would pass — which is why the
 * opener's exact event id participates. Id equality is checked first so the
 * opener itself is admitted even against a legacy persisted `createdAt` that
 * trails the signed event's by a second.
 *
 * Event ids are random within a second, so a fast reply signed in the
 * opener's own second can sort "older" than the opener in relay order. A
 * reply carries an `e` tag naming the opener — causality the id ordering
 * cannot fake — so events that reference the opener are always admitted.
 */
export function isAtOrAfterConversationOpener(
  event: { created_at: number; id: string; tags?: readonly string[][] },
  opener: ProjectsConversationOpener,
): boolean {
  return (
    event.id === opener.eventId ||
    event.created_at > opener.createdAt ||
    (event.created_at === opener.createdAt && event.id <= opener.eventId) ||
    (event.tags?.some((tag) => tag[0] === "e" && tag[1] === opener.eventId) ??
      false)
  );
}

/**
 * Restores an inline Projects conversation strictly from a pointer this
 * feature persisted earlier. DM channels are reused across the app, so
 * inferring a conversation from "the most recent agent DM" would surface
 * unrelated chat history on the Projects page — never infer one here.
 *
 * A stored channel id alone is not proof either: ids can collide across
 * relays, and a stale pointer could name a group channel. The channel must
 * be a DM whose participants are exactly the agent and the current user —
 * anything else renders someone else's conversation and is not restorable.
 */
export function restoreProjectsAgentConversation<
  Agent extends { pubkey: string },
>({
  stored,
  channels,
  candidates,
  currentPubkey,
}: {
  stored: StoredProjectsAgentConversation | null;
  channels: readonly Channel[];
  candidates: readonly Agent[];
  currentPubkey: string | null;
}): {
  channel: Channel;
  agent: Agent;
  opener: ProjectsConversationOpener;
} | null {
  // Only pointers anchored to a concrete opener event are restorable —
  // anything weaker would render DM history that predates the conversation.
  if (!stored || !currentPubkey) return null;
  const channel = channels.find(
    (candidate) => candidate.id === stored.channelId,
  );
  const agentPubkey = normalizePubkey(stored.agentPubkey);
  const agent = candidates.find(
    (candidate) => candidate.pubkey === agentPubkey,
  );
  if (!channel || !agent || channel.channelType !== "dm") return null;
  const participants = channel.participantPubkeys.map(normalizePubkey);
  const self = normalizePubkey(currentPubkey);
  const hasAgent = participants.includes(agentPubkey);
  const hasStranger = participants.some(
    (participant) => participant !== agentPubkey && participant !== self,
  );
  if (!hasAgent || hasStranger) return null;
  return { agent, channel, opener: stored.opener };
}

/**
 * Chat rows for the inline Projects thread: plain messages only, and nothing
 * ordered before the conversation's opener event — the backing DM may hold
 * unrelated history from ordinary DM usage, including history from the
 * opener's own second.
 */
export function visibleConversationMessages<
  Event extends { kind: number; created_at: number; id: string },
>(events: readonly Event[], opener: ProjectsConversationOpener): Event[] {
  return events
    .filter(
      (event) =>
        (event.kind === KIND_STREAM_MESSAGE ||
          event.kind === KIND_STREAM_MESSAGE_V2) &&
        isAtOrAfterConversationOpener(event, opener),
    )
    .sort((left, right) => left.created_at - right.created_at);
}

/**
 * Combines the backing DM's root events with separately queried thread
 * replies. Keep this chronological: appending the reply query after the root
 * query would otherwise render every question before every agent answer.
 */
export function mergeProjectAgentConversationEvents<
  Event extends { id: string; created_at: number },
>(rootEvents: readonly Event[], replyEvents: readonly Event[]): Event[] {
  return [
    ...new Map(
      [...rootEvents, ...replyEvents].map((event) => [event.id, event]),
    ).values(),
  ].sort((left, right) => left.created_at - right.created_at);
}
