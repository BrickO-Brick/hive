import * as React from "react";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import type { UserStatusInput } from "@/features/user-status/types";
import { relayClient } from "@/shared/api/relayClient";
import type {
  RelayEvent,
  UserStatus,
  UserStatusLookup,
} from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { useFocusedRefetchInterval } from "@/shared/lib/useDocumentVisible";
import { KIND_USER_STATUS } from "@/shared/constants/kinds";

function normalizePubkeys(pubkeys: string[]) {
  return [...new Set(pubkeys.map((pk) => normalizePubkey(pk)))]
    .filter((pk) => pk.length > 0)
    .sort();
}

function statusIsExpired(
  status: UserStatus | null | undefined,
  nowSeconds: number,
): boolean {
  return status?.expiresAt !== undefined && status.expiresAt <= nowSeconds;
}

/** Remove expired entries from every mounted user-status lookup. */
export function expireUserStatusQueries(
  queryClient: Pick<QueryClient, "getQueriesData" | "setQueryData">,
  nowSeconds = Math.floor(Date.now() / 1_000),
): boolean {
  let changed = false;
  for (const [queryKey, old] of queryClient.getQueriesData<UserStatusLookup>({
    queryKey: ["user-status"],
  })) {
    if (!old) continue;
    let next: UserStatusLookup | null = null;
    for (const [pubkey, status] of Object.entries(old)) {
      if (!statusIsExpired(status, nowSeconds)) continue;
      next ??= { ...old };
      next[pubkey] = null;
    }
    if (!next) continue;
    queryClient.setQueryData(queryKey, next);
    changed = true;
  }
  return changed;
}

function nextUserStatusExpiration(
  queryClient: Pick<QueryClient, "getQueriesData">,
  nowSeconds: number,
): number | null {
  let nearest: number | null = null;
  for (const [, lookup] of queryClient.getQueriesData<UserStatusLookup>({
    queryKey: ["user-status"],
  })) {
    if (!lookup) continue;
    for (const status of Object.values(lookup)) {
      if (
        status?.expiresAt !== undefined &&
        status.expiresAt > nowSeconds &&
        (nearest === null || status.expiresAt < nearest)
      ) {
        nearest = status.expiresAt;
      }
    }
  }
  return nearest;
}

export function userStatusQueryKey(pubkeys: string[]) {
  return ["user-status", ...normalizePubkeys(pubkeys)] as const;
}

export function parseUserStatusEvent(event: RelayEvent): {
  pubkey: string;
  text: string;
  emoji: string;
  updatedAt: number;
  expiresAt?: number;
} {
  const emojiTag = event.tags.find(
    (tag) => tag[0] === "emoji" && tag.length >= 2,
  );
  const expirationTag = event.tags.find(
    (tag) => tag[0] === "expiration" && tag.length >= 2,
  );
  const parsedExpiration = Number.parseInt(expirationTag?.[1] ?? "", 10);
  return {
    pubkey: normalizePubkey(event.pubkey),
    text: event.content,
    emoji: emojiTag?.[1] ?? "",
    updatedAt: event.created_at,
    expiresAt: Number.isFinite(parsedExpiration) ? parsedExpiration : undefined,
  };
}

/** Keeps focused polling at the established 2-minute backstop cadence. */
export const USER_STATUS_REFETCH_INTERVAL_MS = 120_000;
/** Suppresses the focus refetch until user-status data is genuinely stale.
 * The live subscription (setQueriesData) is the primary freshness path. */
export const USER_STATUS_FOCUS_STALE_TIME_MS = 5 * 60_000;
export const USER_STATUS_AUTHOR_CHUNK_SIZE = 1_000;

/** Focus-refetch policy for the user-status query; consumed by focusRefetchPolicy.test.mjs. */
export const userStatusFocusRefetchPolicy = {
  staleTime: USER_STATUS_FOCUS_STALE_TIME_MS,
  refetchOnWindowFocus: false,
} as const;

type FetchStatusEvents = (
  filter: Parameters<typeof relayClient.fetchEvents>[0],
) => Promise<RelayEvent[]>;

export async function fetchUserStatusLookup(
  pubkeys: string[],
  fetchEvents: FetchStatusEvents = (filter) => relayClient.fetchEvents(filter),
): Promise<UserStatusLookup> {
  const normalizedAuthors = normalizePubkeys(pubkeys);
  const chunks: string[][] = [];
  for (
    let index = 0;
    index < normalizedAuthors.length;
    index += USER_STATUS_AUTHOR_CHUNK_SIZE
  ) {
    chunks.push(
      normalizedAuthors.slice(index, index + USER_STATUS_AUTHOR_CHUNK_SIZE),
    );
  }
  const pages = await Promise.all(
    chunks.map((authors) =>
      fetchEvents({
        kinds: [KIND_USER_STATUS],
        authors,
        "#d": ["general"],
        limit: authors.length,
      }),
    ),
  );

  const lookup: UserStatusLookup = {};
  for (const pubkey of normalizedAuthors) lookup[pubkey] = null;
  const latestEvents = new Map<string, RelayEvent>();
  for (const event of pages.flat()) {
    const pubkey = normalizePubkey(event.pubkey);
    const existing = latestEvents.get(pubkey);
    if (
      !existing ||
      event.created_at > existing.created_at ||
      (event.created_at === existing.created_at && event.id < existing.id)
    ) {
      latestEvents.set(pubkey, event);
    }
  }
  const nowSeconds = Math.floor(Date.now() / 1_000);
  for (const event of latestEvents.values()) {
    const parsed = parseUserStatusEvent(event);
    const isExpired =
      parsed.expiresAt !== undefined && parsed.expiresAt <= nowSeconds;
    lookup[parsed.pubkey] =
      (parsed.text || parsed.emoji) && !isExpired
        ? {
            text: parsed.text,
            emoji: parsed.emoji,
            updatedAt: parsed.updatedAt,
            expiresAt: parsed.expiresAt,
          }
        : null;
  }
  return lookup;
}

export function useUserStatusQuery(pubkeys: string[]) {
  const refetchInterval = useFocusedRefetchInterval(
    USER_STATUS_REFETCH_INTERVAL_MS,
  );
  const normalizedPubkeys = normalizePubkeys(pubkeys);
  const enabled = normalizedPubkeys.length > 0;

  return useQuery<UserStatusLookup>({
    enabled,
    queryKey: userStatusQueryKey(normalizedPubkeys),
    queryFn: () => fetchUserStatusLookup(normalizedPubkeys),
    refetchInterval,
    ...userStatusFocusRefetchPolicy,
  });
}

export function useUserStatusSubscription() {
  const queryClient = useQueryClient();

  React.useEffect(() => {
    let unsub: (() => Promise<void>) | null = null;
    let isCancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let expirationTimer: ReturnType<typeof setTimeout> | null = null;
    let expirationScheduleQueued = false;

    function scheduleExpiration() {
      if (expirationTimer) clearTimeout(expirationTimer);
      expirationTimer = null;
      if (isCancelled) return;

      const nowSeconds = Math.floor(Date.now() / 1_000);
      expireUserStatusQueries(queryClient, nowSeconds);
      if (isCancelled) return;
      const expiresAt = nextUserStatusExpiration(queryClient, nowSeconds);
      if (expiresAt === null) return;

      const delay = Math.max(0, expiresAt * 1_000 - Date.now());
      expirationTimer = setTimeout(
        scheduleExpiration,
        Math.min(delay, 0x7fffffff),
      );
    }

    const unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
      if (
        event.query.queryKey[0] !== "user-status" ||
        expirationScheduleQueued
      ) {
        return;
      }
      expirationScheduleQueued = true;
      queueMicrotask(() => {
        expirationScheduleQueued = false;
        scheduleExpiration();
      });
    });
    scheduleExpiration();

    function handleStatusEvent(event: RelayEvent) {
      if (isCancelled) return;
      const dTag = event.tags.find((t) => t[0] === "d");
      if (dTag?.[1] !== "general") return;
      const parsed = parseUserStatusEvent(event);
      const isExpired =
        parsed.expiresAt !== undefined &&
        parsed.expiresAt <= Math.floor(Date.now() / 1_000);
      const status: UserStatus | null =
        (parsed.text || parsed.emoji) && !isExpired
          ? {
              text: parsed.text,
              emoji: parsed.emoji,
              updatedAt: parsed.updatedAt,
              expiresAt: parsed.expiresAt,
            }
          : null;

      queryClient.setQueriesData<UserStatusLookup>(
        { queryKey: ["user-status"] },
        (old) => {
          if (!old || !(parsed.pubkey in old)) return old;
          const existing = old[parsed.pubkey];
          if (existing && existing.updatedAt >= parsed.updatedAt) return old;
          return { ...old, [parsed.pubkey]: status };
        },
      );
    }

    function subscribeWithRetry(attempt = 0) {
      if (isCancelled) return;
      void relayClient
        .subscribeToUserStatusUpdates(handleStatusEvent)
        .then((unsubFn) => {
          if (isCancelled) {
            void unsubFn();
            return;
          }
          unsub = unsubFn;
        })
        .catch(() => {
          if (!isCancelled) {
            const delay = Math.min(1000 * 2 ** attempt, 30_000);
            retryTimer = setTimeout(
              () => subscribeWithRetry(attempt + 1),
              delay,
            );
          }
        });
    }
    subscribeWithRetry();

    const unsubReconnect = relayClient.subscribeToReconnects(() => {
      if (!isCancelled)
        void queryClient.invalidateQueries({ queryKey: ["user-status"] });
    });

    return () => {
      isCancelled = true;
      unsubscribeCache();
      unsubReconnect();
      if (retryTimer) clearTimeout(retryTimer);
      if (expirationTimer) clearTimeout(expirationTimer);
      if (unsub) void unsub();
    };
  }, [queryClient]);
}

export function useSetUserStatusMutation(pubkey?: string) {
  const queryClient = useQueryClient();
  const normalizedPubkey = normalizePubkey(pubkey ?? "");

  return useMutation({
    mutationFn: async ({ text, emoji, expiresAt }: UserStatusInput) => {
      await relayClient.publishUserStatus({ text, emoji, expiresAt });
      return { text, emoji, expiresAt };
    },
    onSuccess: ({ text, emoji, expiresAt }) => {
      if (normalizedPubkey.length === 0) return;

      const status: UserStatus | null =
        text || emoji
          ? {
              text,
              emoji,
              updatedAt: Math.floor(Date.now() / 1_000),
              expiresAt,
            }
          : null;

      queryClient.setQueryData<UserStatusLookup>(
        userStatusQueryKey([normalizedPubkey]),
        (old) => ({ ...(old ?? {}), [normalizedPubkey]: status }),
      );

      queryClient.setQueriesData<UserStatusLookup>(
        { queryKey: ["user-status"] },
        (old) => {
          if (!old || !(normalizedPubkey in old)) return old;
          return { ...old, [normalizedPubkey]: status };
        },
      );
    },
  });
}
