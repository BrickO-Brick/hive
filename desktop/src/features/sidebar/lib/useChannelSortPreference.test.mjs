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

const { stubRelay, stubTauri } = makeHookStubs();

// Carl P1.1 regression: storage event while a local sort edit is pending must
// NOT clobber the optimistic edit.
// Mutation: removing `hasPendingEdit()` guard lets B1 apply, so A2 derives from B1.
test("storage event while a local sort edit is pending is deferred, not applied", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSortPreference } = await import(
    "./useChannelSortPreference.ts"
  );
  const { storageKey } = await import("./channelSortPreference.ts");

  const restoreRelay = stubRelay(relayClient);
  const restoreTauri = stubTauri("pk-sort-sg", null);
  const pubkey = "pk-sort-sg";
  const relayUrl = "wss://r.sort-sg";
  let hook = null;
  try {
    await act(async () => {
      hook = renderHook(() => useChannelSortPreference(pubkey, relayUrl));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      hook.result.current.setSortModeFor("channels", "alpha");
    });
    assert.equal(
      hook.result.current.sortModeFor("channels"),
      "alpha",
      "A1: channels sort set to alpha",
    );
    const b1Store = JSON.stringify({
      version: 1,
      groups: { channels: "recent" },
    });
    await act(async () => {
      window.localStorage.setItem(storageKey(pubkey, relayUrl), b1Store);
      window.dispatchEvent(
        new window.StorageEvent("storage", {
          key: storageKey(pubkey, relayUrl),
          newValue: b1Store,
          storageArea: window.localStorage,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      hook.result.current.sortModeFor("channels"),
      "alpha",
      "storage event while pending must not apply B1",
    );
    await act(async () => {
      hook.result.current.setSortModeFor("starred", "recent");
    });
    assert.equal(
      hook.result.current.sortModeFor("channels"),
      "alpha",
      "A2 derived from A1 — channels remains alpha",
    );
    hook.unmount();
  } finally {
    cleanup();
    restoreRelay();
    restoreTauri();
  }
});

// Carl P1-sort: live remote while a local sort edit is pending must NOT overwrite
// the optimistic edit or strand its durable outbox.
// Mutation: reverting applyRemote's hasPendingEdit() guard lets the remote clobber.
test("live remote while a local edit is pending defers to the pending edit", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSortPreference } = await import(
    "./useChannelSortPreference.ts"
  );
  const { readChannelSortOutbox } = await import("./channelSortPreference.ts");

  const live = {};
  const restoreRelay = stubRelay(relayClient, { live });
  const restoreTauri = stubTauri("pk-sort-pending", () =>
    JSON.stringify({ version: 1, groups: { "remote-group": "recent" } }),
  );
  const pubkey = "pk-sort-pending";
  const relayUrl = "wss://r.live";
  let hook = null;
  try {
    await act(async () => {
      hook = renderHook(() => useChannelSortPreference(pubkey, relayUrl));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(live.cb, "live subscription installed");
    await act(async () => {
      hook.result.current.setSortModeFor("channels", "recent");
    });
    assert.ok(
      readChannelSortOutbox(pubkey, relayUrl),
      "local edit persisted to outbox",
    );
    assert.equal(
      hook.result.current.sortModeFor("channels"),
      "recent",
      "optimistic local edit applied",
    );
    await act(async () => {
      live.cb({
        id: "remote-event",
        pubkey,
        created_at: 500,
        content: "cipher",
        kind: 30078,
        tags: [["d", "channel-sort"]],
        sig: "s",
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      hook.result.current.sortModeFor("channels"),
      "recent",
      "pending local edit NOT overwritten",
    );
    assert.equal(
      hook.result.current.sortModeFor("remote-group"),
      "alpha",
      "remote store not applied over pending edit",
    );
    assert.ok(
      readChannelSortOutbox(pubkey, relayUrl),
      "outbox survives live remote",
    );
    hook.unmount();
  } finally {
    cleanup();
    restoreRelay();
    restoreTauri();
  }
});

// Equal-timestamp tie-break must match the relay's canonical winner (lowest id wins).
// Mutation: reverting applyRemote's `>=` back to `<=` ignores the lower id.
test("equal-timestamp tie-break applies the lower event id (relay canonical winner)", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSortPreference } = await import(
    "./useChannelSortPreference.ts"
  );

  const live = {};
  const restoreRelay = stubRelay(relayClient, { live });
  const restoreTauri = stubTauri("pk-sort-tie", (args) => {
    const id = args?.ciphertext ?? "";
    return JSON.stringify({ version: 1, groups: { [id]: "recent" } });
  });
  const pubkey = "pk-sort-tie";
  const relayUrl = "wss://r.tie";
  let hook = null;
  try {
    await act(async () => {
      hook = renderHook(() => useChannelSortPreference(pubkey, relayUrl));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(live.cb, "live subscription installed");
    const deliver = async (id) => {
      await act(async () => {
        live.cb({
          id,
          pubkey,
          created_at: 1000,
          content: id,
          kind: 30078,
          tags: [["d", "channel-sort"]],
          sig: "s",
        });
        await Promise.resolve();
        await Promise.resolve();
      });
    };
    await deliver("bbbb");
    await deliver("aaaa");
    assert.equal(
      hook.result.current.sortModeFor("aaaa"),
      "recent",
      "lower event id (relay canonical winner) applied",
    );
    assert.equal(
      hook.result.current.sortModeFor("bbbb"),
      "alpha",
      "larger id's store superseded",
    );
    hook.unmount();
  } finally {
    cleanup();
    restoreRelay();
    restoreTauri();
  }
});

// Carl P1-sort: on reconnect the hook must wake the EXISTING pending edit
// (retryPendingPublish) rather than re-queue it via publishSortPrefs().
// Mutation: reverting to publishSortPrefs(pending) resets the baseline.
test("reconnect adopts a remote that advanced while the edit was pending, never publishing over it", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSortPreference } = await import(
    "./useChannelSortPreference.ts"
  );

  const reconnect = {};
  const publishCalls = [];
  let head = {
    pubkey: "pk-sort-recon",
    content: "remote-cipher",
    created_at: 100,
    id: "evt-100",
  };
  const origFetch = relayClient.fetchEvents;
  relayClient.fetchEvents = async () => [head];
  const restoreRelay = stubRelay(relayClient, { reconnect, publishCalls });
  relayClient.fetchEvents = async () => [head];
  const restoreTauri = stubTauri("pk-sort-recon", () =>
    JSON.stringify({ version: 1, groups: { "remote-group": "recent" } }),
  );
  const pubkey = "pk-sort-recon";
  const relayUrl = "wss://r.recon";
  let hook = null;
  try {
    await act(async () => {
      hook = renderHook(() => useChannelSortPreference(pubkey, relayUrl));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(reconnect.cb, "reconnect handler installed");
    await act(async () => {
      hook.result.current.setSortModeFor("channels", "recent");
    });
    head = {
      pubkey: "pk-sort-recon",
      content: "remote-cipher",
      created_at: 200,
      id: "evt-200",
    };
    await act(async () => {
      reconnect.cb();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      publishCalls.length,
      0,
      "must adopt advanced remote on reconnect, never publish",
    );
    assert.equal(
      hook.result.current.sortModeFor("channels"),
      "alpha",
      "losing local edit adopted away",
    );
    assert.equal(
      hook.result.current.sortModeFor("remote-group"),
      "recent",
      "advanced remote store adopted",
    );
    hook.unmount();
  } finally {
    cleanup();
    relayClient.fetchEvents = origFetch;
    restoreRelay();
    restoreTauri();
  }
});

// Thufir pass-3: legacy blob whose v2 transfer fails (quota) must NOT write the
// consumed marker.
// Mutation: writing the marker unconditionally loses the legacy blob.
test("legacy replay whose v2 transfer fails (quota) does not write the consumed marker", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSortPreference } = await import(
    "./useChannelSortPreference.ts"
  );
  const { readChannelSortOutbox } = await import("./channelSortPreference.ts");
  const { normalizeRelayUrl } = await import("@/shared/lib/normalizeRelayUrl");

  const origLocalStorage = window.localStorage;
  const pubkey = "pk-quota";
  const relayUrl = "wss://r.quota";
  const scope = `${pubkey}:${encodeURIComponent(normalizeRelayUrl(relayUrl))}`;
  const legacyKey = `buzz-channel-sort-outbox.v1:${scope}`;
  const v2Prefix = `buzz-channel-sort-outbox.v1:${scope}:`;
  const legacyRaw = JSON.stringify({
    store: { version: 1, groups: { "legacy-group": "recent" } },
    queuedAt: 0,
  });
  const map = new Map([[legacyKey, legacyRaw]]);
  const throwingStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (k.startsWith(v2Prefix)) throw new Error("QuotaExceededError");
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
  };
  const restoreRelay = stubRelay(relayClient);
  const restoreTauri = stubTauri(pubkey, null);
  let hook = null;
  try {
    Object.defineProperty(window, "localStorage", {
      value: throwingStorage,
      configurable: true,
    });
    window.localStorage.setItem(
      `buzz-sync-watermark.v1:channel-sort:${pubkey}:${encodeURIComponent(normalizeRelayUrl(relayUrl))}`,
      "1700000000",
    );
    await act(async () => {
      hook = renderHook(() => useChannelSortPreference(pubkey, relayUrl));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      [...map.keys()].some((k) => k.includes("-legacy-consumed:")),
      false,
      "consumed marker must not be written after failed v2 transfer",
    );
    const resumed = readChannelSortOutbox(pubkey, relayUrl);
    assert.ok(resumed !== null, "legacy blob must remain replayable");
    assert.equal(
      resumed.store.groups["legacy-group"],
      "recent",
      "exact legacy intent survives",
    );
    assert.ok(
      resumed.legacyRawToConsume !== null,
      "legacy record reports itself for consumption",
    );
    hook.unmount();
  } finally {
    cleanup();
    Object.defineProperty(window, "localStorage", {
      value: origLocalStorage,
      configurable: true,
    });
    restoreRelay();
    restoreTauri();
  }
});
