import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import {
  getChannelIdFromTags,
  getThreadReference,
} from "@/features/messages/lib/threading";
import { relayClient } from "@/shared/api/relayClient";
import type { Channel, RelayEvent } from "@/shared/api/types";
import {
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_TYPING_INDICATOR,
} from "@/shared/constants/kinds";
import { resolveEventAuthorPubkey } from "@/shared/lib/authors";

export type TypingIndicatorEntry = {
  pubkey: string;
  threadHeadId: string | null;
};

type TypingEntry = {
  expiresAt: number;
  firstSeenAt: number;
  pubkey: string;
  threadHeadId: string | null;
};
type TypingState = Record<string, TypingEntry>;
type TypingCompletionWatermarks = Record<string, number>;
type TypingSuppressionDeadlines = Record<string, number>;

const TYPING_INDICATOR_TTL_MS = 8_000;
const TYPING_PRUNE_INTERVAL_MS = 1_000;
const TYPING_POST_MESSAGE_SUPPRESS_MS = 2_000;

/**
 * Advance one author + thread completion watermark when it can still affect
 * an acceptable typing indicator. Returns whether matching typing state should
 * be cleared. Exported so replay and out-of-order behavior stays unit-tested.
 */
export function recordTypingCompletion({
  createdAt,
  latestMessageCreatedAtByPubkey,
  now = Date.now(),
  suppressUntilByPubkey,
  typingKey,
}: {
  createdAt: number;
  latestMessageCreatedAtByPubkey: TypingCompletionWatermarks;
  now?: number;
  suppressUntilByPubkey: TypingSuppressionDeadlines;
  typingKey: string;
}) {
  for (const [key, watermark] of Object.entries(
    latestMessageCreatedAtByPubkey,
  )) {
    if (watermark * 1_000 + TYPING_INDICATOR_TTL_MS <= now) {
      delete latestMessageCreatedAtByPubkey[key];
    }
  }
  for (const [key, suppressUntil] of Object.entries(suppressUntilByPubkey)) {
    if (suppressUntil <= now) {
      delete suppressUntilByPubkey[key];
    }
  }

  if (createdAt * 1_000 + TYPING_INDICATOR_TTL_MS <= now) {
    return false;
  }

  const latestMessageCreatedAt = latestMessageCreatedAtByPubkey[typingKey] ?? 0;
  if (createdAt <= latestMessageCreatedAt) {
    return false;
  }
  latestMessageCreatedAtByPubkey[typingKey] = createdAt;

  const suppressUntil = createdAt * 1_000 + TYPING_POST_MESSAGE_SUPPRESS_MS;
  if (suppressUntil > now) {
    suppressUntilByPubkey[typingKey] = suppressUntil;
  } else {
    delete suppressUntilByPubkey[typingKey];
  }
  return true;
}

function pruneTypingState(state: TypingState, now = Date.now()) {
  let changed = false;
  const next: TypingState = {};

  for (const [pubkey, entry] of Object.entries(state)) {
    if (entry.expiresAt > now) {
      next[pubkey] = entry;
      continue;
    }

    changed = true;
  }

  return changed ? next : state;
}

function isTypingCompletionEvent(event: RelayEvent | null | undefined) {
  if (!event) {
    return false;
  }

  return (
    event.kind === KIND_STREAM_MESSAGE ||
    event.kind === KIND_STREAM_MESSAGE_DIFF
  );
}

function getTypingScopeId(event: RelayEvent) {
  return getThreadReference(event.tags).parentId ?? null;
}

function getTypingStateKey(pubkey: string, threadHeadId: string | null) {
  return `${pubkey}:${threadHeadId ?? "channel"}`;
}

export function useChannelTyping(
  channel: Channel | null,
  currentPubkey?: string,
  latestMessageEvent?: RelayEvent | null,
  relaySelfPubkey?: string | null,
  threadReplyEvents: readonly RelayEvent[] = [],
) {
  const channelId = channel?.id ?? null;
  const channelType = channel?.channelType ?? null;
  const [typingByPubkey, setTypingByPubkey] = useState<TypingState>({});
  const normalizedCurrentPubkey = currentPubkey?.toLowerCase();
  const typingSuppressUntilByPubkeyRef = useRef<Record<string, number>>({});
  const latestMessageCreatedAtByPubkeyRef = useRef<Record<string, number>>({});

  const registerTyping = useEffectEvent((event: RelayEvent) => {
    if (!channelId || event.kind !== KIND_TYPING_INDICATOR) {
      return;
    }

    const now = Date.now();
    const eventExpiresAt = event.created_at * 1_000 + TYPING_INDICATOR_TTL_MS;
    if (eventExpiresAt <= now) {
      return;
    }

    if (getChannelIdFromTags(event.tags) !== channelId) {
      return;
    }

    const typingPubkey = event.pubkey.toLowerCase();
    const threadHeadId = getTypingScopeId(event);
    const typingKey = getTypingStateKey(typingPubkey, threadHeadId);
    if (normalizedCurrentPubkey && typingPubkey === normalizedCurrentPubkey) {
      return;
    }

    const suppressUntil =
      typingSuppressUntilByPubkeyRef.current[typingKey] ?? 0;
    if (suppressUntil > Date.now()) {
      return;
    }
    if (suppressUntil > 0) {
      delete typingSuppressUntilByPubkeyRef.current[typingKey];
    }

    const latestMessageCreatedAt =
      latestMessageCreatedAtByPubkeyRef.current[typingKey] ?? 0;
    if (event.created_at <= latestMessageCreatedAt) {
      return;
    }

    setTypingByPubkey((current) => {
      const pruned = pruneTypingState(current, now);
      const existing = pruned[typingKey];
      return {
        ...pruned,
        [typingKey]: {
          expiresAt: Math.min(now + TYPING_INDICATOR_TTL_MS, eventExpiresAt),
          firstSeenAt: existing?.firstSeenAt ?? now,
          pubkey: typingPubkey,
          threadHeadId,
        },
      };
    });
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: channel changes should clear local typing state
  useEffect(() => {
    setTypingByPubkey({});
    typingSuppressUntilByPubkeyRef.current = {};
    latestMessageCreatedAtByPubkeyRef.current = {};
  }, [channelId]);

  const clearTypingForMessage = useEffectEvent((event: RelayEvent) => {
    if (!channelId || !isTypingCompletionEvent(event)) {
      return;
    }

    if (getChannelIdFromTags(event.tags) !== channelId) {
      return;
    }

    const authorPubkey = resolveEventAuthorPubkey({
      event,
      preferActorTag: true,
      relaySelfPubkey,
      requireChannelTagForPTags: true,
    }).toLowerCase();
    const threadHeadId = getTypingScopeId(event);
    const typingKey = getTypingStateKey(authorPubkey, threadHeadId);
    const shouldClearTyping = recordTypingCompletion({
      createdAt: event.created_at,
      latestMessageCreatedAtByPubkey: latestMessageCreatedAtByPubkeyRef.current,
      suppressUntilByPubkey: typingSuppressUntilByPubkeyRef.current,
      typingKey,
    });
    if (!shouldClearTyping) {
      return;
    }

    setTypingByPubkey((current) => {
      const next = pruneTypingState(current);
      if (!(typingKey in next)) {
        return next;
      }

      const updated = { ...next };
      delete updated[typingKey];
      return updated;
    });
  });

  useEffect(() => {
    if (latestMessageEvent) {
      clearTypingForMessage(latestMessageEvent);
    }
  }, [latestMessageEvent]);

  useEffect(() => {
    for (const event of threadReplyEvents) {
      clearTypingForMessage(event);
    }
  }, [threadReplyEvents]);

  useEffect(() => {
    if (!channelId || channelType === "forum") {
      return;
    }

    let isDisposed = false;
    let cleanup: (() => Promise<void>) | undefined;

    relayClient
      .subscribeToTypingIndicators(channelId, (event) => {
        if (!isDisposed) {
          registerTyping(event);
        }
      })
      .then((dispose) => {
        if (isDisposed) {
          void dispose();
          return;
        }

        cleanup = dispose;
      })
      .catch((error) => {
        console.error(
          "Failed to subscribe to typing indicators",
          channelId,
          error,
        );
      });

    return () => {
      isDisposed = true;
      if (cleanup) {
        void cleanup();
      }
    };
  }, [channelId, channelType]);

  const hasActiveTypers = Object.keys(typingByPubkey).length > 0;

  useEffect(() => {
    if (!hasActiveTypers) {
      return;
    }

    const interval = window.setInterval(() => {
      setTypingByPubkey((current) => pruneTypingState(current));
    }, TYPING_PRUNE_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [hasActiveTypers]);

  return useMemo(
    () =>
      Object.values(typingByPubkey)
        .sort((left, right) => left.firstSeenAt - right.firstSeenAt)
        .map(({ pubkey, threadHeadId }) => ({ pubkey, threadHeadId })),
    [typingByPubkey],
  );
}
