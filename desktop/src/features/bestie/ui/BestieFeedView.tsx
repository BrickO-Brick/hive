import * as React from "react";

import {
  type BestieFeedFilter,
  type BestiePanelState,
  filterBestieFeedItems,
  getVisibleBestieFeedItems,
  reduceBestiePanelState,
  sortBestieFeedItems,
} from "@/features/bestie/lib/bestieFeed";
import { BestieFeedCard } from "@/features/bestie/ui/BestieFeedCard";
import { BestieFeedHeader } from "@/features/bestie/ui/BestieFeedHeader";
import { BestieFeedPanel } from "@/features/bestie/ui/BestieFeedPanel";
import { buildInboxItems } from "@/features/home/lib/inbox";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import type { Channel, HomeFeedResponse } from "@/shared/api/types";
import { getThreadReference } from "@/features/messages/lib/threading";
import { Button } from "@/shared/ui/button";

function feedPubkeys(feed?: HomeFeedResponse) {
  if (!feed) return [];
  return [
    ...new Set(
      [
        ...feed.feed.mentions,
        ...feed.feed.needsAction,
        ...feed.feed.activity,
        ...feed.feed.agentActivity,
      ].map((item) => item.pubkey),
    ),
  ];
}

type BestieFeedViewProps = {
  channels: Channel[];
  currentPubkey?: string;
  errorMessage?: string;
  feed?: HomeFeedResponse;
  isLoading: boolean;
  onOpenContext: (
    channelId: string,
    messageId: string,
    threadRootId?: string | null,
  ) => void;
  onOpenInbox: () => void;
  onRefresh: () => void;
};

export function BestieFeedView({
  channels,
  currentPubkey,
  errorMessage,
  feed,
  isLoading,
  onOpenContext,
  onOpenInbox,
  onRefresh,
}: BestieFeedViewProps) {
  const [filter, setFilter] = React.useState<BestieFeedFilter>("all");
  const [query, setQuery] = React.useState("");
  const [snoozedUntilById, setSnoozedUntilById] = React.useState<
    Record<string, number>
  >({});
  const [lastSnoozedId, setLastSnoozedId] = React.useState<string | null>(null);
  const [panelState, dispatchPanel] = React.useReducer(reduceBestiePanelState, {
    mode: "closed",
  } satisfies BestiePanelState);
  const pubkeys = React.useMemo(() => feedPubkeys(feed), [feed]);
  const profilesQuery = useUsersBatchQuery(pubkeys, {
    enabled: pubkeys.length > 0,
  });
  const items = React.useMemo(
    () =>
      buildInboxItems({
        channels,
        currentPubkey,
        feed,
        profiles: profilesQuery.data?.profiles,
      }),
    [channels, currentPubkey, feed, profilesQuery.data?.profiles],
  );
  const visibleItems = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return filterBestieFeedItems(
      getVisibleBestieFeedItems(
        sortBestieFeedItems(items),
        snoozedUntilById,
        Date.now(),
      ),
      filter,
    ).filter((item) => {
      if (!normalizedQuery) return true;
      return [
        item.senderLabel,
        item.categoryLabel,
        item.channelLabel ?? "",
        item.preview,
        item.subject,
      ].some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [filter, items, query, snoozedUntilById]);
  const panelItem =
    panelState.mode === "closed"
      ? null
      : (items.find((item) => item.id === panelState.itemId) ?? null);
  const lastSnoozedItem = lastSnoozedId
    ? (items.find((item) => item.id === lastSnoozedId) ?? null)
    : null;

  const openSource = React.useCallback(
    (item: (typeof items)[number]) => {
      const channelId = item.item.channelId;
      if (!channelId) return;
      const thread = getThreadReference(item.item.tags);
      onOpenContext(channelId, item.item.id, thread.rootId);
    },
    [onOpenContext],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/20">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <main className="mx-auto w-full max-w-4xl px-4 pb-16 pt-10 sm:px-7 sm:pt-14">
          <BestieFeedHeader
            filter={filter}
            isLoading={isLoading}
            onFilterChange={setFilter}
            onOpenInbox={onOpenInbox}
            onRefresh={onRefresh}
            onSearchChange={setQuery}
            query={query}
          />

          {lastSnoozedItem ? (
            <div
              aria-live="polite"
              className="mx-auto mt-4 flex max-w-3xl items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/90 px-4 py-3 text-sm"
              data-testid="bestie-snooze-notice"
            >
              <span className="truncate">
                Snoozed “{lastSnoozedItem.subject}”
              </span>
              <Button
                onClick={() => {
                  setSnoozedUntilById((current) => {
                    const next = { ...current };
                    delete next[lastSnoozedItem.id];
                    return next;
                  });
                  setLastSnoozedId(null);
                }}
                size="xs"
                type="button"
                variant="ghost"
              >
                Undo
              </Button>
            </div>
          ) : null}

          <div
            className="mx-auto mt-4 flex max-w-3xl flex-col gap-4"
            data-testid="bestie-feed"
          >
            {!feed && isLoading ? (
              <FeedState title="Loading your Buzz feed…" />
            ) : !feed ? (
              <FeedState
                action={<Button onClick={onRefresh}>Try again</Button>}
                detail={errorMessage ?? "The Home feed is unavailable."}
                title="Couldn’t load live Buzz data"
              />
            ) : visibleItems.length > 0 ? (
              visibleItems.map((item) => (
                <BestieFeedCard
                  item={item}
                  key={item.id}
                  onChat={() =>
                    dispatchPanel({ itemId: item.id, type: "open-chat" })
                  }
                  onReply={() =>
                    dispatchPanel({ itemId: item.id, type: "open-reply" })
                  }
                  onSnooze={() => {
                    setSnoozedUntilById((current) => ({
                      ...current,
                      [item.id]: Date.now() + 4 * 60 * 60 * 1_000,
                    }));
                    setLastSnoozedId(item.id);
                  }}
                />
              ))
            ) : (
              <FeedState
                detail="Try another section, clear search, or refresh Home."
                title="No matching live feed items"
              />
            )}
          </div>
        </main>
      </div>

      <BestieFeedPanel
        item={panelItem}
        key={
          panelState.mode === "closed"
            ? "closed"
            : `${panelState.mode}:${panelState.itemId}`
        }
        onOpenChange={(open) => {
          if (!open && panelState.mode !== "closed") {
            const triggerTestId = `bestie-${panelState.mode}-${panelState.itemId}`;
            dispatchPanel({ type: "close" });
            window.requestAnimationFrame(() => {
              window.requestAnimationFrame(() => {
                document
                  .querySelector<HTMLButtonElement>(
                    `[data-testid="${triggerTestId}"]`,
                  )
                  ?.focus();
              });
            });
          }
        }}
        onOpenSource={openSource}
        state={panelState}
      />
    </div>
  );
}

function FeedState({
  action,
  detail,
  title,
}: {
  action?: React.ReactNode;
  detail?: string;
  title: string;
}) {
  return (
    <div className="rounded-[1.75rem] border border-dashed border-border/70 bg-background/60 px-6 py-16 text-center">
      <p className="font-medium">{title}</p>
      {detail ? (
        <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
