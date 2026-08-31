// Shared parameterized test suite for merge-lane React hooks
// (useChannelStars.ts, useChannelMutes.ts).
//
// Usage:
//   import { runMergeLaneHookSuite } from "./mergeLaneHook.shared.test.mjs";
//   runMergeLaneHookSuite({ label: "stars", ... });

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

// Shared harness: stub the relay so no network/live/reconnect fires unless a
// test installs its own live callback.
function stubRelay(relayClient, { live } = {}) {
  const orig = {
    fetchEvents: relayClient.fetchEvents,
    subscribeLive: relayClient.subscribeLive,
    subscribeToReconnects: relayClient.subscribeToReconnects,
  };
  relayClient.fetchEvents = async () => [];
  relayClient.subscribeLive = async (_f, cb) => {
    if (live) live.cb = cb;
    return async () => {};
  };
  relayClient.subscribeToReconnects = () => () => {};
  return () => Object.assign(relayClient, orig);
}

/**
 * Run the merge-lane hook invariant suite for a single lane.
 *
 * @param {object} cfg
 * @param {string}   cfg.label              - Human-readable lane name for test titles.
 * @param {string}   cfg.entryValueField    - "starred" or "muted"
 * @param {string}   cfg.idsField           - "starredChannelIds" or "mutedChannelIds"
 * @param {string}   cfg.trueAction         - "starChannel" or "muteChannel"
 * @param {string}   cfg.falseAction        - "unstarChannel" or "unmuteChannel"
 * @param {string}   cfg.dTag               - relay event d-tag ("channel-stars" or "channel-mutes")
 * @param {string}   cfg.outboxKeyPrefix    - localStorage outbox key prefix
 * @param {number}   cfg.MAX_ENTRIES        - capacity cap
 * @param {Function} cfg.readStore          - readChannel{Stars|Mutes}Store(pubkey, relay?)
 * @param {Function} cfg.storageKey         - storageKey(pubkey, relay?)
 * @param {Function} cfg.useHook            - the hook function
 * @param {Function} cfg.makePayload        - (channels) => JSON string for tauri decrypt
 */
export function runMergeLaneHookSuite({
  label,
  entryValueField,
  idsField,
  trueAction,
  falseAction,
  dTag,
  outboxKeyPrefix,
  MAX_ENTRIES,
  readStore,
  storageKey,
  useHook,
  makePayload,
}) {
  const trueLabel = trueAction.replace("Channel", "").toLowerCase();
  const falseLabel = falseAction.replace("Channel", "").toLowerCase();

  test(`${label}: same-second ${trueLabel} and ${falseLabel} mutations survive at capacity`, async () => {
    const { act, cleanup, renderHook } = await import("@testing-library/react");
    const { relayClient } = await import("@/shared/api/relayClient");

    const restore = stubRelay(relayClient);
    const originalDateNow = Date.now;
    const updatedAt = 1_234_567;
    Date.now = () => updatedAt * 1_000;

    const relayUrl = "wss://relay.example";
    const channels = Object.fromEntries(
      Array.from({ length: MAX_ENTRIES }, (_, index) => [
        `z-channel-${String(index).padStart(3, "0")}`,
        { [entryValueField]: true, updatedAt, rev: 0 },
      ]),
    );

    try {
      for (const [pubkey, action, expectedValue] of [
        [`pk-${trueLabel}`, trueAction, true],
        [`pk-${falseLabel}`, falseAction, false],
      ]) {
        window.localStorage.setItem(
          storageKey(pubkey, relayUrl),
          JSON.stringify({ version: 1, channels }),
        );
        const { result, unmount } = renderHook(() => useHook(pubkey, relayUrl));
        act(() => result.current[action]("a-target"));
        const persisted = readStore(pubkey, relayUrl);
        assert.equal(Object.keys(persisted.channels).length, MAX_ENTRIES);
        assert.equal(
          persisted.channels["a-target"][entryValueField],
          expectedValue,
        );
        unmount();
      }
    } finally {
      cleanup();
      Date.now = originalDateNow;
      restore();
    }
  });

  // Monotonic mint: combines persisted-local high-water, far-future observation,
  // and same-second click sequence into one scenario. After observing a remote
  // with high updatedAt and rev, local clicks must advance both dimensions.
  // Mutation: dropping maxUpdatedAtSeen or maxRevSeen tracking makes later
  // clicks mint below the observed high-water and lose on merge.
  test(`${label}: monotonic mint — persisted high-water + far-future live event + same-second clicks advance rev`, async () => {
    const { act, cleanup, renderHook } = await import("@testing-library/react");
    const { relayClient } = await import("@/shared/api/relayClient");

    const live = {};
    const restore = stubRelay(relayClient, { live });
    const origTauri = window.__TAURI_INTERNALS__;
    const origDateNow = Date.now;
    // Local clock: 100s. Persisted head has updatedAt 500, rev 4.
    Date.now = () => 100 * 1_000;
    const FUTURE = 500;
    window.__TAURI_INTERNALS__ = {
      invoke: (cmd) => {
        if (cmd === "nip44_decrypt_from_self")
          return Promise.resolve(
            makePayload({
              shared: { [entryValueField]: false, updatedAt: FUTURE, rev: 7 },
            }),
          );
        return Promise.reject(new Error(`unmocked ${cmd}`));
      },
    };
    const pubkey = `pk-${label}-mono`;
    // Seed a persisted store at rev 4, updatedAt 500.
    window.localStorage.setItem(
      storageKey(pubkey, "wss://r"),
      makePayload({
        shared: { [entryValueField]: true, updatedAt: FUTURE, rev: 4 },
      }),
    );
    let hook = null;
    try {
      await act(async () => {
        hook = renderHook(() => useHook(pubkey, "wss://r"));
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
      // Deliver a live event with rev 7 (higher than persisted 4).
      await act(async () => {
        live.cb({
          id: "future-head",
          pubkey,
          created_at: FUTURE,
          content: "cipher",
          kind: 30078,
          tags: [["d", dTag]],
          sig: "s",
        });
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
      // First click: must mint above max(FUTURE, rev 7).
      await act(async () => hook.result.current[trueAction]("shared"));
      let p = readStore(pubkey, "wss://r");
      assert.equal(
        p.channels.shared[entryValueField],
        true,
        "first click applied",
      );
      assert.equal(
        p.channels.shared.updatedAt,
        FUTURE,
        "updatedAt held at observed high-water",
      );
      assert.equal(p.channels.shared.rev, 8, "rev = maxRevSeen(7) + 1");
      // Second same-second click: rev must strictly advance.
      await act(async () => hook.result.current[falseAction]("shared"));
      p = readStore(pubkey, "wss://r");
      assert.equal(
        p.channels.shared[entryValueField],
        false,
        "second click applied",
      );
      assert.equal(
        p.channels.shared.updatedAt,
        FUTURE,
        "updatedAt still fixed",
      );
      assert.equal(p.channels.shared.rev, 9, "rev advanced 8→9");
      hook.unmount();
    } finally {
      cleanup();
      Date.now = origDateNow;
      window.__TAURI_INTERNALS__ = origTauri;
      restore();
    }
  });

  // Cross-window storage merge + outbox resume in one compact scenario.
  // (a) A cross-window storage event is observed and max-merged into this window.
  // (b) A click after the merge mints above the observed peer high-water.
  // (c) A persisted outbox record is retained until the publish completes.
  // Mutations: (a) removing the storageEvent listener; (b) not tracking peer
  // maxRevSeen; (c) dropping writeOwnOutbox in the bootstrap path.
  test(`${label}: cross-window merge, subsequent click mints above peer high-water, outbox retained`, async () => {
    const { act, cleanup, renderHook } = await import("@testing-library/react");
    const { relayClient } = await import("@/shared/api/relayClient");

    const restore = stubRelay(relayClient);
    const origDateNow = Date.now;
    Date.now = () => 100 * 1_000;
    const pubkey = `pk-${label}-xwin`;
    const outboxKey = `${outboxKeyPrefix}:${pubkey}:${encodeURIComponent("wss://r")}`;
    // Pre-seed a persisted outbox record (simulates resumed intent).
    window.localStorage.setItem(
      outboxKey,
      makePayload({
        resumed: { [entryValueField]: true, updatedAt: 90, rev: 2 },
      }),
    );
    let hook = null;
    try {
      await act(async () => {
        hook = renderHook(() => useHook(pubkey, "wss://r"));
        for (let i = 0; i < 40; i++) await Promise.resolve();
      });
      // (c) Outbox retained until publish completes.
      assert.ok(
        window.localStorage.getItem(outboxKey) !== null,
        "outbox retained during bootstrap",
      );

      // (a) Peer window writes a store with rev 12 and fires a storage event.
      window.localStorage.setItem(
        storageKey(pubkey, "wss://r"),
        makePayload({
          shared: { [entryValueField]: true, updatedAt: 900, rev: 12 },
        }),
      );
      await act(async () => {
        window.dispatchEvent(
          new dom.window.StorageEvent("storage", {
            key: storageKey(pubkey, "wss://r"),
          }),
        );
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
      assert.equal(
        hook.result.current[idsField].has("shared"),
        true,
        "peer write merged into this window",
      );

      // (b) Click after merge mints above peer high-water (updatedAt 900, rev 12).
      await act(async () => hook.result.current[falseAction]("shared"));
      const p = readStore(pubkey, "wss://r");
      assert.equal(p.channels.shared[entryValueField], false, "click applied");
      assert.equal(p.channels.shared.updatedAt, 900, "held at peer high-water");
      assert.equal(p.channels.shared.rev, 13, "rev = peer rev + 1");
      hook.unmount();
    } finally {
      cleanup();
      Date.now = origDateNow;
      restore();
    }
  });
}
