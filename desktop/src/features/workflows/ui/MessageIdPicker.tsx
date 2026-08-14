import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Check, LoaderCircle, Search } from "lucide-react";
import * as React from "react";

import { useUsersBatchQuery } from "@/features/profile/hooks";
import { resolveUserLabel } from "@/features/profile/lib/identity";
import { useSearchMessagesQuery } from "@/features/search/hooks";
import { getChannelWindowEvents } from "@/shared/api/channelWindow";
import { getEventById } from "@/shared/api/tauri";
import type { ChannelPageCursor, RelayEvent } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Input } from "@/shared/ui/input";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import {
  CHANNEL_MESSAGE_EVENT_KINDS,
  KIND_STREAM_MESSAGE_DIFF,
} from "@/shared/constants/kinds";
import { parseChannelWindowResponse } from "@/features/messages/lib/channelWindowResponse";

const PAGE_SIZE = 25;
const FULL_EVENT_ID = /^[0-9a-f]{64}$/i;
const PICKABLE_KINDS = new Set<number>([
  ...CHANNEL_MESSAGE_EVENT_KINDS,
  KIND_STREAM_MESSAGE_DIFF,
]);

type MessageCandidate = {
  id: string;
  pubkey: string;
  content: string;
  createdAt: number;
};

function eventChannelId(event: RelayEvent): string | null {
  return event.tags.find((tag) => tag[0] === "h")?.[1] ?? null;
}

function candidateFromEvent(event: RelayEvent): MessageCandidate {
  return {
    id: event.id,
    pubkey: event.pubkey,
    content: event.content,
    createdAt: event.created_at,
  };
}

function truncateContent(content: string): string {
  const normalized = content.trim().replaceAll(/\s+/g, " ");
  if (!normalized) return "No message body";
  return normalized.length > 120
    ? `${normalized.slice(0, 117)}...`
    : normalized;
}

function formatTimestamp(unixSeconds: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(unixSeconds * 1_000));
}

function dedupeCandidates(candidates: MessageCandidate[]): MessageCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const normalized = candidate.id.toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export function MessageIdPicker({
  channelId,
  disabled,
  id,
  onChange,
  value,
}: {
  channelId?: string | null;
  disabled?: boolean;
  id: string;
  onChange: (messageId: string) => void;
  value: string;
}) {
  const [query, setQuery] = React.useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const pastedEventId = FULL_EVENT_ID.test(normalizedQuery)
    ? normalizedQuery
    : null;

  const historyQuery = useInfiniteQuery({
    enabled: Boolean(channelId),
    initialPageParam: null as ChannelPageCursor | null,
    queryKey: ["workflow-message-id-picker", channelId],
    queryFn: async ({ pageParam }) => {
      if (!channelId) throw new Error("Choose a channel first.");
      const events = await getChannelWindowEvents(
        channelId,
        pageParam,
        PAGE_SIZE,
      );
      return parseChannelWindowResponse(events, channelId, pageParam);
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
  });

  const searchQuery = useSearchMessagesQuery(query, {
    channelId: channelId ?? undefined,
    enabled: Boolean(channelId) && normalizedQuery.length > 0 && !pastedEventId,
    limit: 30,
    minimumQueryLength: 1,
  });

  const pastedEventQuery = useQuery({
    enabled: Boolean(channelId && pastedEventId),
    queryKey: ["workflow-message-id", channelId, pastedEventId],
    queryFn: () => getEventById(pastedEventId ?? ""),
    retry: false,
    staleTime: 60_000,
  });

  const recentCandidates = React.useMemo(
    () =>
      dedupeCandidates(
        (historyQuery.data?.pages ?? []).flatMap((page) =>
          page.rows
            .map(({ event }) => event)
            .filter((event) => PICKABLE_KINDS.has(event.kind))
            .map(candidateFromEvent),
        ),
      ),
    [historyQuery.data?.pages],
  );

  const searchCandidates = React.useMemo(
    () =>
      (searchQuery.data?.hits ?? [])
        .filter((hit) => PICKABLE_KINDS.has(hit.kind))
        .map((hit) => ({
          id: hit.eventId,
          pubkey: hit.pubkey,
          content: hit.content,
          createdAt: hit.createdAt,
        })),
    [searchQuery.data?.hits],
  );

  const pastedCandidate = React.useMemo(() => {
    const event = pastedEventQuery.data;
    if (
      !event ||
      !channelId ||
      eventChannelId(event) !== channelId ||
      !PICKABLE_KINDS.has(event.kind)
    ) {
      return null;
    }
    return candidateFromEvent(event);
  }, [channelId, pastedEventQuery.data]);

  const displayedCandidates = React.useMemo(() => {
    if (!normalizedQuery) return recentCandidates;
    const localMatches = recentCandidates.filter(
      (candidate) =>
        candidate.id.toLowerCase().includes(normalizedQuery) ||
        candidate.content.toLowerCase().includes(normalizedQuery),
    );
    return dedupeCandidates([
      ...(pastedCandidate ? [pastedCandidate] : []),
      ...localMatches,
      ...searchCandidates,
    ]);
  }, [normalizedQuery, pastedCandidate, recentCandidates, searchCandidates]);

  const profilePubkeys = React.useMemo(
    () => [...new Set(displayedCandidates.map(({ pubkey }) => pubkey))],
    [displayedCandidates],
  );
  const profilesQuery = useUsersBatchQuery(profilePubkeys);
  const loading =
    historyQuery.isLoading ||
    searchQuery.isFetching ||
    pastedEventQuery.isFetching;
  const pastedEventInAnotherChannel =
    Boolean(pastedEventQuery.data && channelId && pastedEventId) &&
    !pastedCandidate;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-background/35">
      <div className="relative flex-shrink-0 border-b border-border/70">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="Search messages or paste a message ID"
          autoCapitalize="off"
          autoCorrect="off"
          className="h-11 rounded-none border-0 bg-transparent pl-9 focus-visible:ring-0"
          disabled={disabled || !channelId}
          id={id}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={
            channelId
              ? "Search messages or paste a message ID..."
              : "Choose a channel first"
          }
          value={query}
        />
        {loading ? (
          <LoaderCircle
            aria-label="Loading messages"
            className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
          />
        ) : null}
      </div>

      {pastedEventInAnotherChannel ? (
        <p className="flex-shrink-0 border-b border-border/70 px-3 py-2 text-xs text-destructive">
          That message is not available in this channel.
        </p>
      ) : null}

      <div
        className="min-h-72 flex-1 overflow-y-auto overscroll-contain p-2"
        data-testid="message-id-picker-list"
        onScroll={(event) => {
          const element = event.currentTarget;
          const nearBottom =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            80;
          if (
            nearBottom &&
            !normalizedQuery &&
            historyQuery.hasNextPage &&
            !historyQuery.isFetchingNextPage
          ) {
            void historyQuery.fetchNextPage();
          }
        }}
      >
        {displayedCandidates.length > 0 ? (
          <div className="space-y-1">
            {displayedCandidates.map((message) => {
              const profile =
                profilesQuery.data?.profiles[message.pubkey.toLowerCase()];
              const author = resolveUserLabel({
                pubkey: message.pubkey,
                profiles: profilesQuery.data?.profiles,
              });
              const selected = value.toLowerCase() === message.id.toLowerCase();
              return (
                <button
                  aria-pressed={selected}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-md border px-3 py-2.5 text-left transition-colors",
                    selected
                      ? "border-foreground/40 bg-muted/70"
                      : "border-transparent hover:border-border hover:bg-muted/45",
                  )}
                  disabled={disabled}
                  key={message.id}
                  onClick={() => {
                    onChange(message.id);
                    setQuery("");
                  }}
                  type="button"
                >
                  <UserAvatar
                    avatarUrl={profile?.avatarUrl ?? null}
                    displayName={author}
                    size="sm"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate font-medium text-foreground">
                        {author}
                      </span>
                      <span className="ml-auto shrink-0">
                        {formatTimestamp(message.createdAt)}
                      </span>
                    </span>
                    <span className="mt-1 block text-sm leading-5 text-foreground">
                      {truncateContent(message.content)}
                    </span>
                    <span className="mt-1 block font-mono text-2xs text-muted-foreground">
                      {message.id.slice(0, 12)}...{message.id.slice(-8)}
                    </span>
                  </span>
                  {selected ? (
                    <Check
                      aria-label="Selected message"
                      className="mt-1 h-4 w-4 shrink-0"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : loading ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            Loading messages...
          </p>
        ) : (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            {normalizedQuery ? "No messages found." : "No messages yet."}
          </p>
        )}

        {!normalizedQuery && historyQuery.hasNextPage ? (
          <button
            className="mt-2 w-full rounded-md px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/45 hover:text-foreground"
            disabled={disabled || historyQuery.isFetchingNextPage}
            onClick={() => void historyQuery.fetchNextPage()}
            type="button"
          >
            {historyQuery.isFetchingNextPage
              ? "Loading older messages..."
              : "Load older messages"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
