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
 * Run the full merge-lane hook invariant suite for a single lane.
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

  test(`${label}: persisted-local first click mints seen+1 on both dimensions`, async () => {
    const { act, cleanup, renderHook } = await import("@testing-library/react");
    const { relayClient } = await import("@/shared/api/relayClient");

    const restore = stubRelay(relayClient);
    const origDateNow = Date.now;
    Date.now = () => 100 * 1_000;
    const pubkey = `pk-${label}-persist`;
    window.localStorage.setItem(
      storageKey(pubkey, "wss://r"),
      makePayload({
        shared: { [entryValueField]: true, updatedAt: 500, rev: 4 },
      }),
    );
    try {
      const { result, unmount } = renderHook(() => useHook(pubkey, "wss://r"));
      act(() => result.current[falseAction]("shared"));
      const persisted = readStore(pubkey, "wss://r");
      assert.equal(
        persisted.channels.shared[entryValueField],
        false,
        `${falseLabel} applied`,
      );
      assert.equal(
        persisted.channels.shared.updatedAt,
        500,
        "updatedAt held at persisted-local high-water (max(100,500,seen))",
      );
      assert.equal(
        persisted.channels.shared.rev,
        5,
        "rev minted as persisted-local rev + 1",
      );
      unmount();
    } finally {
      cleanup();
      Date.now = origDateNow;
      restore();
    }
  });

  test(`${label}: fast-clock veto fix: click after observing a future-stamped head wins`, async () => {
    const { act, cleanup, renderHook } = await import("@testing-library/react");
    const { relayClient } = await import("@/shared/api/relayClient");

    const live = {};
    const restore = stubRelay(relayClient, { live });
    const origTauri = window.__TAURI_INTERNALS__;
    const origDateNow = Date.now;
    Date.now = () => 100 * 1_000;
    window.__TAURI_INTERNALS__ = {
      invoke: (cmd) => {
        if (cmd === "nip44_decrypt_from_self")
          return Promise.resolve(
            makePayload({
              shared: { [entryValueField]: false, updatedAt: 400, rev: 7 },
            }),
          );
        return Promise.reject(new Error(`unmocked ${cmd}`));
      },
    };
    const pubkey = `pk-${label}-fastclock`;
    let hook = null;
    try {
      await act(async () => {
        hook = renderHook(() => useHook(pubkey, "wss://r"));
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
      await act(async () => {
        live.cb({
          id: "future-head",
          pubkey,
          created_at: 400,
          content: "cipher",
          kind: 30078,
          tags: [["d", dTag]],
          sig: "s",
        });
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
      assert.equal(
        hook.result.current[idsField].has("shared"),
        false,
        "future head applied → false",
      );
      await act(async () => hook.result.current[trueAction]("shared"));
      assert.equal(
        hook.result.current[idsField].has("shared"),
        true,
        "click must win despite the observed future timestamp",
      );
      const persisted = readStore(pubkey, "wss://r");
      assert.equal(
        persisted.channels.shared.updatedAt,
        400,
        "mint lifted to t+300",
      );
      assert.equal(persisted.channels.shared.rev, 8, "rev = maxRevSeen+1");
      hook.unmount();
    } finally {
      cleanup();
      Date.now = origDateNow;
      window.__TAURI_INTERNALS__ = origTauri;
      restore();
    }
  });

  test(`${label}: far-future observation: timestamp stays fixed, rev advances, latest click wins`, async () => {
    const { act, cleanup, renderHook } = await import("@testing-library/react");
    const { relayClient } = await import("@/shared/api/relayClient");

    const live = {};
    const restore = stubRelay(relayClient, { live });
    const origTauri = window.__TAURI_INTERNALS__;
    const origDateNow = Date.now;
    Date.now = () => 100 * 1_000;
    const FUTURE = 100 + 31_536_000;
    window.__TAURI_INTERNALS__ = {
      invoke: (cmd) => {
        if (cmd === "nip44_decrypt_from_self")
          return Promise.resolve(
            makePayload({
              shared: { [entryValueField]: true, updatedAt: FUTURE, rev: 1 },
            }),
          );
        return Promise.reject(new Error(`unmocked ${cmd}`));
      },
    };
    const pubkey = `pk-${label}-future`;
    let hook = null;
    try {
      await act(async () => {
        hook = renderHook(() => useHook(pubkey, "wss://r"));
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
      await act(async () => {
        live.cb({
          id: "far-future",
          pubkey,
          created_at: FUTURE,
          content: "cipher",
          kind: 30078,
          tags: [["d", dTag]],
          sig: "s",
        });
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
      await act(async () => hook.result.current[falseAction]("shared"));
      let p = readStore(pubkey, "wss://r");
      assert.equal(
        p.channels.shared[entryValueField],
        false,
        "first click applied",
      );
      assert.equal(
        p.channels.shared.updatedAt,
        FUTURE,
        "timestamp stays fixed",
      );
      assert.equal(p.channels.shared.rev, 2, "rev advanced 1→2");
      await act(async () => hook.result.current[trueAction]("shared"));
      p = readStore(pubkey, "wss://r");
      assert.equal(
        p.channels.shared[entryValueField],
        true,
        "latest click wins",
      );
      assert.equal(
        p.channels.shared.updatedAt,
        FUTURE,
        "timestamp still fixed",
      );
      assert.equal(p.channels.shared.rev, 3, "rev advanced 2→3");
      hook.unmount();
    } finally {
      cleanup();
      Date.now = origDateNow;
      window.__TAURI_INTERNALS__ = origTauri;
      restore();
    }
  });

  test(`${label}: empty-store click survives a later higher-rev head with an older updatedAt`, async () => {
    const { act, cleanup, renderHook } = await import("@testing-library/react");
    const { relayClient } = await import("@/shared/api/relayClient");

    const live = {};
    const restore = stubRelay(relayClient, { live });
    const origTauri = window.__TAURI_INTERNALS__;
    const origDateNow = Date.now;
    Date.now = () => 1000 * 1_000;
    window.__TAURI_INTERNALS__ = {
      invoke: (cmd) => {
        if (cmd === "nip44_decrypt_from_self")
          return Promise.resolve(
            makePayload({
              shared: { [entryValueField]: false, updatedAt: 500, rev: 99 },
            }),
          );
        return Promise.reject(new Error(`unmocked ${cmd}`));
      },
    };
    const pubkey = `pk-${label}-empty`;
    let hook = null;
    try {
      await act(async () => {
        hook = renderHook(() => useHook(pubkey, "wss://r"));
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
      await act(async () => hook.result.current[trueAction]("shared"));
      await act(async () => {
        live.cb({
          id: "older-higher-rev",
          pubkey,
          created_at: 500,
          content: "cipher",
          kind: 30078,
          tags: [["d", dTag]],
          sig: "s",
        });
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
      assert.equal(
        hook.result.current[idsField].has("shared"),
        true,
        "click at newer updatedAt survives an older higher-rev head",
      );
      hook.unmount();
    } finally {
      cleanup();
      Date.now = origDateNow;
      window.__TAURI_INTERNALS__ = origTauri;
      restore();
    }
  });

  test(`${label}: unobserved future head wins over an empty-high-water click on primary updatedAt`, async () => {
    const { act, cleanup, renderHook } = await import("@testing-library/react");
    const { relayClient } = await import("@/shared/api/relayClient");

    const live = {};
    const restore = stubRelay(relayClient, { live });
    const origTauri = window.__TAURI_INTERNALS__;
    const origDateNow = Date.now;
    Date.now = () => 1000 * 1_000;
    window.__TAURI_INTERNALS__ = {
      invoke: (cmd) => {
        if (cmd === "nip44_decrypt_from_self")
          return Promise.resolve(
            makePayload({
              shared: { [entryValueField]: false, updatedAt: 1300, rev: 1 },
            }),
          );
        return Promise.reject(new Error(`unmocked ${cmd}`));
      },
    };
    const pubkey = `pk-${label}-unobserved-future`;
    let hook = null;
    try {
      await act(async () => {
        hook = renderHook(() => useHook(pubkey, "wss://r"));
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
      await act(async () => hook.result.current[trueAction]("shared"));
      await act(async () => {
        live.cb({
          id: "unobserved-future",
          pubkey,
          created_at: 1300,
          content: "cipher",
          kind: 30078,
          tags: [["d", dTag]],
          sig: "s",
        });
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
      assert.equal(
        hook.result.current[idsField].has("shared"),
        false,
        "unobserved future head wins on primary updatedAt (accepted residual)",
      );
      hook.unmount();
    } finally {
      cleanup();
      Date.now = origDateNow;
      window.__TAURI_INTERNALS__ = origTauri;
      restore();
    }
  });

  test(`${label}: cross-window storage event is observed and max-merged`, async () => {
    const { act, cleanup, renderHook } = await import("@testing-library/react");
    const { relayClient } = await import("@/shared/api/relayClient");

    const restore = stubRelay(relayClient);
    const origDateNow = Date.now;
    Date.now = () => 100 * 1_000;
    const pubkey = `pk-${label}-xwin`;
    let hook = null;
    try {
      await act(async () => {
        hook = renderHook(() => useHook(pubkey, "wss://r"));
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
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

  test(`${label}: bootstrap resumes a persisted outbox edit`, async () => {
    const { act, cleanup, renderHook } = await import("@testing-library/react");
    const { relayClient } = await import("@/shared/api/relayClient");

    const restore = stubRelay(relayClient);
    const origDateNow = Date.now;
    Date.now = () => 100 * 1_000;
    const pubkey = `pk-${label}-outbox`;
    const relayUrl = `wss://r.${label}-outbox`;
    const outboxKey = `${outboxKeyPrefix}:${pubkey}:${encodeURIComponent(relayUrl)}`;
    window.localStorage.setItem(
      outboxKey,
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
      assert.ok(
        window.localStorage.getItem(outboxKey) !== null,
        "outbox retained until the resumed publish completes",
      );
      hook.unmount();
    } finally {
      cleanup();
      Date.now = origDateNow;
      restore();
    }
  });
}
