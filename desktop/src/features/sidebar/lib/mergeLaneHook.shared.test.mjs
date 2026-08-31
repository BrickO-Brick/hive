// Shared parameterized test suite for merge-lane React hooks
// (useChannelStars.ts, useChannelMutes.ts).
//
// Usage:
//   import { runMergeLaneHookSuite } from "./mergeLaneHook.shared.test.mjs";
//   runMergeLaneHookSuite({ label: "stars", ... });

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { JSDOM } from "jsdom";
import { makeHookStubs } from "./sidebarSyncTestHelpers.mjs";

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
const { stubRelay } = makeHookStubs();

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
  // and same-second click sequence. Mutation: dropping maxUpdatedAtSeen or maxRevSeen
  // tracking makes later clicks mint below the observed high-water and lose on merge.
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

  // Cross-window storage merge + outbox resume.
  // (a) Cross-window storage event is max-merged into this window.
  // (b) Click after merge mints above the observed peer high-water.
  // (c) Bootstrap transfers resumed outbox to a fresh v2 key; persists while head
  //     does not subsume it; clears once a subsuming head is confirmed.
  // Mutations: (a) removing the storageEvent listener; (b) not tracking peer
  // maxRevSeen; (c) dropping writeOwnOutbox or clearing on any retained head.
  test(`${label}: cross-window merge, subsequent click mints above peer high-water, v2 outbox retained until subsumed`, async () => {
    const { act, cleanup, renderHook } = await import("@testing-library/react");
    const { relayClient } = await import("@/shared/api/relayClient");

    // Relay starts empty (hold path — no head on first bootstrap fetch).
    // fetchEvents is overridden per-phase below.
    let fetchResult = [];
    const restore = stubRelay(relayClient, {});
    relayClient.fetchEvents = async () => fetchResult;

    const origDateNow = Date.now;
    Date.now = () => 100 * 1_000;
    const pubkey = `pk-${label}-xwin`;
    const relayUrl = "wss://r";
    const encodedRelay = encodeURIComponent(relayUrl);

    // Pre-seed a resumed outbox record using the LEGACY key format so bootstrap
    // picks it up via the legacy-key enumeration path.
    const legacyOutboxKey = `${outboxKeyPrefix}:${pubkey}:${encodedRelay}`;
    window.localStorage.setItem(
      legacyOutboxKey,
      makePayload({
        resumed: { [entryValueField]: true, updatedAt: 90, rev: 2 },
      }),
    );

    let hook = null;
    try {
      await act(async () => {
        hook = renderHook(() => useHook(pubkey, relayUrl));
        for (let i = 0; i < 40; i++) await Promise.resolve();
      });

      // (c1) Bootstrap must have transferred the resumed intent to a fresh v2
      // write-once key (prefix:pubkey:relay:nonce:seq — more colons than legacy).
      // The legacy key is never deleted; only a v2 key is mutation-valid proof.
      const v2KeyPrefix = `${outboxKeyPrefix}:${pubkey}:${encodedRelay}:`;
      const allKeys = Array.from(
        { length: window.localStorage.length },
        (_, i) => window.localStorage.key(i),
      ).filter((k) => k && k.startsWith(v2KeyPrefix));
      // A v2 own key has two more colon-separated segments (nonce + seq) beyond
      // the legacy three-segment form.
      const v2OwnKeys = allKeys.filter((k) => {
        const segs = k.split(":").length;
        // legacy = prefix:pubkey:encodedRelay (3+ segs but no nonce/seq)
        // v2 own = prefix:pubkey:encodedRelay:nonce:seq (5+ segs)
        return segs >= 5;
      });
      assert.ok(
        v2OwnKeys.length > 0,
        "bootstrap must have written a v2 nonce:seq own key — dropping writeOwnOutbox breaks this",
      );

      // (a) Peer window writes a store with rev 12 and fires a storage event.
      window.localStorage.setItem(
        storageKey(pubkey, relayUrl),
        makePayload({
          shared: { [entryValueField]: true, updatedAt: 900, rev: 12 },
        }),
      );
      await act(async () => {
        window.dispatchEvent(
          new dom.window.StorageEvent("storage", {
            key: storageKey(pubkey, relayUrl),
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
      const p = readStore(pubkey, relayUrl);
      assert.equal(p.channels.shared[entryValueField], false, "click applied");
      assert.equal(p.channels.shared.updatedAt, 900, "held at peer high-water");
      assert.equal(p.channels.shared.rev, 13, "rev = peer rev + 1");

      // (c2) Non-subsuming retained head: v2 own key must remain.
      // Return a head that does NOT carry the resumed channel's entry.
      const origTauri = window.__TAURI_INTERNALS__;
      window.__TAURI_INTERNALS__ = {
        invoke: (cmd) => {
          if (cmd === "nip44_decrypt_from_self")
            return Promise.resolve(
              makePayload({
                other: { [entryValueField]: false, updatedAt: 1, rev: 0 },
              }),
            );
          if (cmd === "nip44_encrypt_to_self") return Promise.resolve("ct-enc");
          if (cmd === "sign_event")
            return Promise.resolve(
              JSON.stringify({
                id: "evt-x",
                pubkey,
                content: "ct-enc",
                created_at: 0,
                kind: 30078,
                tags: [["d", dTag]],
                sig: "s",
              }),
            );
          return Promise.reject(new Error(`unmocked: ${cmd}`));
        },
      };
      fetchResult = [
        {
          id: "non-subsuming-head",
          pubkey,
          content: "ct-nonsubsume",
          created_at: 50,
          kind: 30078,
          tags: [["d", dTag]],
          sig: "s",
        },
      ];
      // Wait for a reconcile tick (bootstrap + reconcile share the fetch path).
      for (let i = 0; i < 40; i++) await Promise.resolve();
      // Re-enumerate: the (b) click replaced the bootstrap v2 key with a fresh
      // one (writeOwnOutbox always writes a new key and drops superseded own
      // keys). Assert that at least one v2 own key exists — a non-subsuming
      // retained head must NOT clear it.
      const currentV2Keys = Array.from(
        { length: window.localStorage.length },
        (_, i) => window.localStorage.key(i),
      ).filter(
        (k) => k && k.startsWith(v2KeyPrefix) && k.split(":").length >= 5,
      );
      assert.ok(
        currentV2Keys.length > 0,
        "v2 own key must survive a non-subsuming retained head — clearing on any retained head breaks this",
      );
      window.__TAURI_INTERNALS__ = origTauri;

      hook.unmount();
    } finally {
      cleanup();
      Date.now = origDateNow;
      restore();
      // Clean up our seeded keys.
      window.localStorage.removeItem(legacyOutboxKey);
    }
  });
}
