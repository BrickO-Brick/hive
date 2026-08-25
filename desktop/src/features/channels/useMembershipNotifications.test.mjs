import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
});

after(() => dom.window.close());

test("DM visibility has a dedicated replay and refreshes only the channel list", async () => {
  const React = await import("react");
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { relayClient } = await import("@/shared/api/relayClient");
  const {
    KIND_DM_VISIBILITY,
    KIND_MEMBER_ADDED_NOTIFICATION,
    KIND_MEMBER_REMOVED_NOTIFICATION,
  } = await import("@/shared/constants/kinds");
  const { useMembershipNotifications } = await import(
    "./useMembershipNotifications.ts"
  );

  const originalSubscribeLive = relayClient.subscribeLive;
  const subscriptions = [];
  relayClient.subscribeLive = async (filter, listener) => {
    subscriptions.push({ filter, listener });
    return async () => {};
  };

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidations = [];
  queryClient.invalidateQueries = async ({ queryKey }) => {
    invalidations.push(queryKey);
  };
  // The channel-list invalidation is routed through an idle-aware trailing
  // debounce; report the query idle so a fired debounce invalidates rather than
  // re-arms. Detail/members keys are invalidated directly.
  queryClient.isFetching = () => 0;
  const wrapper = ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  try {
    const { unmount } = renderHook(
      () => useMembershipNotifications("Viewer-Pubkey"),
      { wrapper },
    );
    await act(async () => new Promise((resolve) => setImmediate(resolve)));

    assert.equal(subscriptions.length, 2);
    const membership = subscriptions.find((subscription) =>
      subscription.filter.kinds.includes(KIND_MEMBER_ADDED_NOTIFICATION),
    );
    const visibility = subscriptions.find(
      (subscription) =>
        subscription.filter.kinds.length === 1 &&
        subscription.filter.kinds[0] === KIND_DM_VISIBILITY,
    );
    assert.deepEqual(membership.filter.kinds, [
      KIND_MEMBER_ADDED_NOTIFICATION,
      KIND_MEMBER_REMOVED_NOTIFICATION,
    ]);
    assert.deepEqual(membership.filter["#p"], ["viewer-pubkey"]);
    assert.equal(membership.filter.limit, 50);
    assert.deepEqual(visibility.filter["#p"], ["viewer-pubkey"]);
    assert.equal(visibility.filter.limit, 1);
    assert.equal(visibility.filter.since, undefined);

    await act(async () => {
      visibility.listener({
        id: "visibility",
        pubkey: "relay",
        created_at: 1,
        kind: KIND_DM_VISIBILITY,
        tags: [
          ["p", "viewer-pubkey"],
          ["h", "still-hidden-dm"],
        ],
        content: "",
        sig: "sig",
      });
    });
    // The channel-list refresh is debounced (trailing). Let the timer fire.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    assert.deepEqual(invalidations, [["channels"]]);

    invalidations.length = 0;
    await act(async () => {
      membership.listener({
        id: "membership",
        pubkey: "relay",
        created_at: 2,
        kind: KIND_MEMBER_ADDED_NOTIFICATION,
        tags: [
          ["p", "viewer-pubkey"],
          ["h", "new-channel"],
        ],
        content: "",
        sig: "sig",
      });
    });
    // Detail/members invalidate synchronously; the channel-list refresh trails.
    assert.deepEqual(invalidations, [
      ["channels", "new-channel", "detail"],
      ["channels", "new-channel", "members"],
    ]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    assert.deepEqual(invalidations, [
      ["channels", "new-channel", "detail"],
      ["channels", "new-channel", "members"],
      ["channels"],
    ]);

    unmount();
  } finally {
    cleanup();
    queryClient.clear();
    relayClient.subscribeLive = originalSubscribeLive;
  }
});

test("channel-list refresh re-arms instead of dropping the signal mid-fetch", async () => {
  const React = await import("react");
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { relayClient } = await import("@/shared/api/relayClient");
  const { KIND_DM_VISIBILITY } = await import("@/shared/constants/kinds");
  const { useMembershipNotifications } = await import(
    "./useMembershipNotifications.ts"
  );

  const originalSubscribeLive = relayClient.subscribeLive;
  const subscriptions = [];
  relayClient.subscribeLive = async (filter, listener) => {
    subscriptions.push({ filter, listener });
    return async () => {};
  };

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidations = [];
  queryClient.invalidateQueries = async ({ queryKey }) => {
    invalidations.push(queryKey);
  };
  // Simulate get_channels in flight: a direct invalidate now would be silently
  // undone when the older (pre-event) response lands. The idle-aware routing
  // must re-arm instead, so no invalidation lands while fetching, and exactly
  // one lands once the query goes idle.
  let fetching = 1;
  queryClient.isFetching = () => fetching;
  const wrapper = ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  try {
    renderHook(() => useMembershipNotifications("viewer-pubkey"), { wrapper });
    await act(async () => new Promise((resolve) => setImmediate(resolve)));

    const visibility = subscriptions.find(
      (subscription) =>
        subscription.filter.kinds.length === 1 &&
        subscription.filter.kinds[0] === KIND_DM_VISIBILITY,
    );

    await act(async () => {
      visibility.listener({
        id: "visibility",
        pubkey: "relay",
        created_at: 1,
        kind: KIND_DM_VISIBILITY,
        tags: [["p", "viewer-pubkey"]],
        content: "",
        sig: "sig",
      });
    });
    // Debounce fires while a fetch is in flight -> must re-arm, not invalidate.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    assert.deepEqual(
      invalidations,
      [],
      "must not invalidate while get_channels is in flight",
    );

    // Query goes idle; the re-armed refresh now invalidates exactly once.
    fetching = 0;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    assert.deepEqual(invalidations, [["channels"]]);

    cleanup();
  } finally {
    cleanup();
    queryClient.clear();
    relayClient.subscribeLive = originalSubscribeLive;
  }
});
