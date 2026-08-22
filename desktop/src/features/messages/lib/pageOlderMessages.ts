import type { QueryClient } from "@tanstack/react-query";

import {
  appendOlderChannelWindow,
  type ChannelWindowCursor,
  type ChannelWindowPage,
  type ChannelWindowStore,
  stageOlderChannelWindow,
} from "@/features/messages/lib/channelWindowStore";
import { projectChannelWindowMessages } from "@/features/messages/lib/projectChannelWindow";
import { parseChannelWindowResponse } from "@/features/messages/lib/channelWindowResponse";
import { channelWindowKey } from "@/features/messages/lib/messageQueryKeys";
import { getChannelWindowEvents } from "@/shared/api/channelWindow";

const CHANNEL_WINDOW_PAGE_SIZE = 50;
export type PageOlderResult = { hasOlderMessages: boolean };
const inFlightPasses = new Map<string, Promise<PageOlderResult>>();
type FetchPage = (
  channelId: string,
  requestCursor: ChannelWindowCursor,
) => Promise<ChannelWindowPage>;

/** Append one older window, then stage its successor without projection. */
export function pageOlderMessagesUntilRowFloor(
  queryClient: QueryClient,
  channelId: string,
  shouldContinue: () => boolean,
  fetchPageFn: FetchPage = fetchPage,
): Promise<PageOlderResult> {
  const running = inFlightPasses.get(channelId);
  if (running) return running;
  const pass = runPage(
    queryClient,
    channelId,
    shouldContinue,
    fetchPageFn,
  ).finally(() => {
    inFlightPasses.delete(channelId);
  });
  inFlightPasses.set(channelId, pass);
  return pass;
}

async function fetchPage(
  channelId: string,
  requestCursor: ChannelWindowCursor,
) {
  const events = await getChannelWindowEvents(
    channelId,
    requestCursor,
    CHANNEL_WINDOW_PAGE_SIZE,
  );
  return parseChannelWindowResponse(events, channelId, requestCursor);
}

function cursorsEqual(left: ChannelWindowCursor, right: ChannelWindowCursor) {
  return left.createdAt === right.createdAt && left.eventId === right.eventId;
}

async function runPage(
  queryClient: QueryClient,
  channelId: string,
  shouldContinue: () => boolean,
  fetchPageFn: FetchPage,
): Promise<PageOlderResult> {
  const store = queryClient.getQueryData<ChannelWindowStore>(
    channelWindowKey(channelId),
  );
  const tail = store?.pages[store.pages.length - 1];
  if (!store || !tail?.hasMore || !tail.nextCursor || !shouldContinue()) {
    return { hasOlderMessages: false };
  }

  const requestCursor = tail.nextCursor;
  const matchingStagedPage = store.stagedPage;
  const page =
    matchingStagedPage?.startCursor &&
    cursorsEqual(matchingStagedPage.startCursor, requestCursor)
      ? matchingStagedPage
      : await fetchPageFn(channelId, requestCursor);
  if (!shouldContinue()) return { hasOlderMessages: true };
  const retained = queryClient.getQueryData<ChannelWindowStore>(
    channelWindowKey(channelId),
  );
  if (!retained) return { hasOlderMessages: true };
  const next = appendOlderChannelWindow(retained, page);
  queryClient.setQueryData(channelWindowKey(channelId), next);
  projectChannelWindowMessages(queryClient, channelId);

  if (!page.hasMore || !page.nextCursor || !shouldContinue()) {
    return { hasOlderMessages: false };
  }
  void fetchPageFn(channelId, page.nextCursor)
    .then((staged) => {
      if (!shouldContinue()) return;
      queryClient.setQueryData<ChannelWindowStore>(
        channelWindowKey(channelId),
        (current) =>
          current ? stageOlderChannelWindow(current, staged) : current,
      );
    })
    .catch((error) => {
      console.error("Failed to stage older messages", channelId, error);
    });
  return { hasOlderMessages: true };
}
