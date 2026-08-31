import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_HUDDLE_ENDED,
  KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT,
  KIND_HUDDLE_STARTED,
} from "@/shared/constants/kinds";
import { normalizePubkey } from "@/shared/lib/pubkey";

type HuddleSession = { participants: Set<string> };

function ephemeralChannelId(event: RelayEvent): string | null {
  try {
    const content = JSON.parse(event.content) as {
      ephemeral_channel_id?: unknown;
    };
    return typeof content.ephemeral_channel_id === "string" &&
      content.ephemeral_channel_id
      ? content.ephemeral_channel_id
      : null;
  } catch {
    return null;
  }
}

function participantPubkey(event: RelayEvent): string | null {
  const value = event.tags.find((tag) => tag[0] === "p")?.[1] ?? event.pubkey;
  const normalized = normalizePubkey(value);
  return normalized || null;
}

function lifecyclePhase(kind: number): number {
  if (kind === KIND_HUDDLE_STARTED) return 0;
  if (kind === KIND_HUDDLE_ENDED) return 2;
  return 1;
}

/** Reconstruct everyone currently in a visible huddle across the community. */
export function reconstructHuddlePresence(
  events: Iterable<RelayEvent>,
): ReadonlySet<string> {
  const sessions = new Map<string, HuddleSession>();
  const sorted = [...events].sort(
    (left, right) =>
      left.created_at - right.created_at ||
      lifecyclePhase(left.kind) - lifecyclePhase(right.kind) ||
      left.kind - right.kind ||
      left.id.localeCompare(right.id),
  );

  for (const event of sorted) {
    const sessionId = ephemeralChannelId(event);
    if (!sessionId) continue;

    if (event.kind === KIND_HUDDLE_ENDED) {
      sessions.delete(sessionId);
      continue;
    }

    if (event.kind === KIND_HUDDLE_STARTED) {
      const creator = participantPubkey(event);
      sessions.set(sessionId, {
        participants: new Set(creator ? [creator] : []),
      });
      continue;
    }

    const session = sessions.get(sessionId) ?? { participants: new Set() };
    const participant = participantPubkey(event);
    if (!participant) continue;

    if (event.kind === KIND_HUDDLE_PARTICIPANT_JOINED) {
      session.participants.add(participant);
      sessions.set(sessionId, session);
    } else if (event.kind === KIND_HUDDLE_PARTICIPANT_LEFT) {
      session.participants.delete(participant);
      sessions.set(sessionId, session);
    }
  }

  return new Set(
    [...sessions.values()].flatMap((session) => [...session.participants]),
  );
}
