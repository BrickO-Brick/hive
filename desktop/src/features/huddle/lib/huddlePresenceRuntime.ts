import {
  applyHuddleLifecycleHistory,
  fetchHuddleLifecycleHistory,
  HuddlePresenceTracker,
  HUDDLE_LIFECYCLE_PAGE_LIMIT,
} from "@/features/huddle/lib/huddlePresence";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";
import { MAX_EXPLICIT_CHANNEL_VALUES } from "@/shared/api/relayClientShared";
import {
  KIND_HUDDLE_ENDED,
  KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT,
  KIND_HUDDLE_STARTED,
} from "@/shared/constants/kinds";

const LIFECYCLE_KINDS = [
  KIND_HUDDLE_STARTED,
  KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT,
  KIND_HUDDLE_ENDED,
] as const;
const MAX_PENDING_LIVE_EVENTS = 1_000;
const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

type Dispose = () => void | Promise<void>;

export type HuddlePresenceRuntimeDependencies = {
  relaySelfPubkey: string;
  channelIds: readonly string[];
  subscribeLive: (
    filter: RelaySubscriptionFilter,
    onEvent: (event: RelayEvent) => void,
  ) => Promise<Dispose>;
  fetchEvents: (filter: RelaySubscriptionFilter) => Promise<RelayEvent[]>;
  subscribeToReconnects: (listener: () => void) => () => void;
  onPresence: (participants: ReadonlySet<string>) => void;
  onError?: (message: string, error: unknown) => void;
  setRetryTimer?: (callback: () => void, delayMs: number) => unknown;
  clearRetryTimer?: (handle: unknown) => void;
  nowSeconds?: () => number;
};

/**
 * Keeps community-wide huddle presence convergent across hydration failures,
 * disconnect gaps, and live/history overlap. The runtime fails closed while a
 * complete history rebuild is unavailable and retries without remounting.
 */
export function startHuddlePresenceRuntime(
  dependencies: HuddlePresenceRuntimeDependencies,
): () => void {
  const setRetryTimer =
    dependencies.setRetryTimer ??
    ((callback: () => void, delayMs: number) =>
      window.setTimeout(callback, delayMs));
  const clearRetryTimer =
    dependencies.clearRetryTimer ??
    ((handle: unknown) => window.clearTimeout(handle as number));
  const nowSeconds =
    dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));

  let disposed = false;
  let liveDispose: Dispose | null = null;
  let connecting = false;
  let reconciling = false;
  let reconcileAgain = false;
  let hydrated = false;
  let tracker = new HuddlePresenceTracker(dependencies.relaySelfPubkey);
  let pendingLiveEvents: RelayEvent[] = [];
  let pendingOverflowed = false;
  let retryHandle: unknown = null;
  let retryDelayMs = INITIAL_RETRY_DELAY_MS;

  const channelChunks: string[][] = [];
  const normalizedChannelIds = [...new Set(dependencies.channelIds)].sort();
  for (
    let index = 0;
    index < normalizedChannelIds.length;
    index += MAX_EXPLICIT_CHANNEL_VALUES
  ) {
    channelChunks.push(
      normalizedChannelIds.slice(index, index + MAX_EXPLICIT_CHANNEL_VALUES),
    );
  }

  if (channelChunks.length === 0) {
    dependencies.onPresence(new Set());
    return () => {};
  }

  const clearScheduledRetry = () => {
    if (retryHandle === null) return;
    clearRetryTimer(retryHandle);
    retryHandle = null;
  };

  const scheduleRecovery = (recover: () => void) => {
    if (disposed || retryHandle !== null) return;
    const delay = retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
    retryHandle = setRetryTimer(() => {
      retryHandle = null;
      recover();
    }, delay);
  };

  const applyLiveEvent = (event: RelayEvent) => {
    if (disposed) return;
    if (!hydrated || reconciling) {
      if (pendingLiveEvents.length >= MAX_PENDING_LIVE_EVENTS) {
        hydrated = false;
        pendingOverflowed = true;
        pendingLiveEvents = [];
        dependencies.onPresence(new Set());
        return;
      }
      pendingLiveEvents.push(event);
      return;
    }
    if (tracker.apply(event)) {
      dependencies.onPresence(tracker.snapshot());
    }
  };

  const reconcile = async () => {
    if (disposed) return;
    if (reconciling) {
      reconcileAgain = true;
      return;
    }
    reconciling = true;
    try {
      const historyPages = await Promise.all(
        channelChunks.map((channelIds) =>
          fetchHuddleLifecycleHistory(dependencies.fetchEvents, channelIds),
        ),
      );
      const history = [
        ...new Map(
          historyPages.flat().map((event) => [event.id, event]),
        ).values(),
      ];
      if (disposed) return;
      const nextTracker = new HuddlePresenceTracker(
        dependencies.relaySelfPubkey,
      );
      if (pendingOverflowed) {
        pendingOverflowed = false;
        pendingLiveEvents = [];
        hydrated = false;
        dependencies.onPresence(new Set());
        reconcileAgain = true;
        return;
      }
      applyHuddleLifecycleHistory(nextTracker, [
        ...history,
        ...pendingLiveEvents,
      ]);
      pendingLiveEvents = [];
      tracker = nextTracker;
      hydrated = true;
      retryDelayMs = INITIAL_RETRY_DELAY_MS;
      clearScheduledRetry();
      dependencies.onPresence(tracker.snapshot());
    } catch (error) {
      if (disposed) return;
      hydrated = false;
      pendingLiveEvents = [];
      dependencies.onPresence(new Set());
      dependencies.onError?.("Huddle presence hydration failed", error);
      scheduleRecovery(recover);
    } finally {
      reconciling = false;
      if (reconcileAgain && !disposed) {
        reconcileAgain = false;
        void reconcile();
      }
    }
  };

  const ensureSubscribed = async () => {
    if (disposed || liveDispose || connecting) return;
    connecting = true;
    try {
      const unsubscribes: Dispose[] = [];
      try {
        for (const channelIds of channelChunks) {
          unsubscribes.push(
            await dependencies.subscribeLive(
              {
                kinds: [...LIFECYCLE_KINDS],
                "#h": channelIds,
                since: nowSeconds(),
                limit: HUDDLE_LIFECYCLE_PAGE_LIMIT,
              },
              applyLiveEvent,
            ),
          );
        }
      } catch (error) {
        await Promise.all(unsubscribes.map((unsubscribe) => unsubscribe()));
        throw error;
      }
      const unsubscribe = () =>
        Promise.all(unsubscribes.map((dispose) => dispose())).then(() => {});
      if (disposed) {
        void unsubscribe();
        return;
      }
      liveDispose = unsubscribe;
      retryDelayMs = INITIAL_RETRY_DELAY_MS;
      await reconcile();
    } catch (error) {
      if (disposed) return;
      dependencies.onPresence(new Set());
      dependencies.onError?.("Huddle presence subscription failed", error);
      scheduleRecovery(recover);
    } finally {
      connecting = false;
    }
  };

  function recover() {
    if (disposed) return;
    if (liveDispose) {
      void reconcile();
    } else {
      void ensureSubscribed();
    }
  }

  const unsubscribeReconnect = dependencies.subscribeToReconnects(recover);
  void ensureSubscribed();

  return () => {
    disposed = true;
    clearScheduledRetry();
    unsubscribeReconnect();
    if (liveDispose) void liveDispose();
    liveDispose = null;
    pendingLiveEvents = [];
    pendingOverflowed = false;
  };
}
