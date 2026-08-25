import * as React from "react";

import { useAppShell } from "@/app/AppShellContext";
import { BestieFeedView } from "@/features/bestie/ui/BestieFeedView";
import { useHomeFeedQuery } from "@/features/home/hooks";
import { HomeView } from "@/features/home/ui/HomeView";
import type { Channel, HomeFeedResponse } from "@/shared/api/types";
import {
  isRelayUnreachableError,
  RELAY_UNREACHABLE_MESSAGE,
} from "@/shared/lib/relayError";

type HomeScreenProps = {
  availableChannelIds: ReadonlySet<string>;
  channels: Channel[];
  currentPubkey?: string;
  onOpenInbox: () => void;
  onOpenContext: (
    channelId: string,
    messageId: string,
    threadRootId?: string | null,
  ) => void;
  view?: "bestie";
};

export function HomeScreen({
  availableChannelIds,
  channels,
  currentPubkey,
  onOpenInbox,
  onOpenContext,
  view,
}: HomeScreenProps) {
  const homeFeedQuery = useHomeFeedQuery();
  const { threadActivityFeedItems } = useAppShell();

  const augmentedFeed = React.useMemo((): HomeFeedResponse | undefined => {
    if (!homeFeedQuery.data) return undefined;
    if (threadActivityFeedItems.length === 0) {
      return homeFeedQuery.data;
    }

    return {
      ...homeFeedQuery.data,
      feed: {
        ...homeFeedQuery.data.feed,
        activity: [
          ...homeFeedQuery.data.feed.activity,
          ...threadActivityFeedItems,
        ],
      },
    };
  }, [homeFeedQuery.data, threadActivityFeedItems]);

  const errorMessage =
    homeFeedQuery.error !== null && homeFeedQuery.error !== undefined
      ? isRelayUnreachableError(homeFeedQuery.error)
        ? RELAY_UNREACHABLE_MESSAGE
        : homeFeedQuery.error instanceof Error
          ? homeFeedQuery.error.message
          : undefined
      : undefined;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {view === "bestie" ? (
        <BestieFeedView
          channels={channels}
          currentPubkey={currentPubkey}
          errorMessage={errorMessage}
          feed={augmentedFeed}
          isLoading={homeFeedQuery.isLoading}
          onOpenContext={onOpenContext}
          onOpenInbox={onOpenInbox}
          onRefresh={() => void homeFeedQuery.refetch()}
        />
      ) : (
        <HomeView
          availableChannelIds={availableChannelIds}
          currentPubkey={currentPubkey}
          errorMessage={errorMessage}
          feed={augmentedFeed}
          isLoading={homeFeedQuery.isLoading}
          onOpenContext={onOpenContext}
          onRefresh={() => {
            void homeFeedQuery.refetch();
          }}
        />
      )}
    </div>
  );
}
