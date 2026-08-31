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

// ── Shared test helpers ───────────────────────────────────────────────────────

/** Install relay no-ops and return a restore function. */
function stubRelay(relayClient, { live, reconnect, publishCalls } = {}) {
  const orig = {
    fetchEvents: relayClient.fetchEvents,
    subscribeLive: relayClient.subscribeLive,
    subscribeToReconnects: relayClient.subscribeToReconnects,
    publishEvent: relayClient.publishEvent,
  };
  relayClient.fetchEvents = async () => [];
  relayClient.subscribeLive = async (_f, cb) => {
    if (live) live.cb = cb;
    return async () => {};
  };
  relayClient.subscribeToReconnects = (cb) => {
    if (reconnect) reconnect.cb = cb;
    return () => {};
  };
  relayClient.publishEvent = async (...args) => {
    if (publishCalls) publishCalls.push(args);
  };
  return () => Object.assign(relayClient, orig);
}

/**
 * Install a Tauri mock for sort tests.
 *  - encrypt returns "ct" / sign returns a minimal event
 *  - decrypt returns `decryptPayload` (JSON string or callback)
 */
function stubTauri(pubkey, decryptPayload) {
  const orig = window.__TAURI_INTERNALS__;
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      if (cmd === "nip44_decrypt_from_self") {
        const payload =
          typeof decryptPayload === "function"
            ? decryptPayload(args)
            : decryptPayload;
        return Promise.resolve(payload);
      }
      if (cmd === "nip44_encrypt_to_self") return Promise.resolve("ct");
      if (cmd === "sign_event")
        return Promise.resolve(
          JSON.stringify({
            id: "signed",
            pubkey,
            content: "ct",
            created_at: 0,
            kind: 30078,
            tags: [],
            sig: "s",
          }),
        );
      return Promise.reject(new Error(`unmocked ${cmd}`));
    },
  };
  return () => {
    window.__TAURI_INTERNALS__ = orig;
  };
}

// Carl P1.1 regression (sort): a peer-cache storage event arriving while a
// local whole-blob sort edit is pending must NOT clobber the optimistic edit.
// Mutation: removing the `hasPendingEdit()` guard in the storage handler lets
// B1 apply, so A2's `setStore` updater derives from B1, and the visible mode
// reverts to B1's value.
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

    // A1: set "channels" to "alpha" — becomes the pending edit.
    await act(async () => {
      hook.result.current.setSortModeFor("channels", "alpha");
    });
    assert.equal(
      hook.result.current.sortModeFor("channels"),
      "alpha",
      "A1: channels sort set to alpha",
    );

    // Window B writes "recent" for "channels" to the shared cache.
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
      "storage event while pending must not apply B1 (recent) over A1 (alpha)",
    );

    // A2: derived from A1 state (channels stays alpha).
    await act(async () => {
      hook.result.current.setSortModeFor("starred", "recent");
    });
    assert.equal(
      hook.result.current.sortModeFor("channels"),
      "alpha",
      "A2 must be derived from A1 state — channels must remain alpha",
    );

    hook.unmount();
  } finally {
    cleanup();
    restoreRelay();
    restoreTauri();
  }
});

// Carl P1-sort regression: a live remote while a local sort edit is pending
// must NOT overwrite the optimistic edit or strand its durable outbox.
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
      "pending local edit must NOT be overwritten",
    );
    assert.equal(
      hook.result.current.sortModeFor("remote-group"),
      "alpha",
      "remote store must not have been applied over the pending edit",
    );
    assert.ok(
      readChannelSortOutbox(pubkey, relayUrl),
      "outbox for the pending edit must survive the live remote",
    );
    hook.unmount();
  } finally {
    cleanup();
    restoreRelay();
    restoreTauri();
  }
});

// Equal-timestamp tie-break must match the relay's canonical winner (lowest id wins).
// Mutation: reverting applyRemote's `>=` back to `<=` wrongly ignores the lower id.
test("equal-timestamp tie-break applies the lower event id (relay canonical winner)", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSortPreference } = await import(
    "./useChannelSortPreference.ts"
  );

  const live = {};
  const restoreRelay = stubRelay(relayClient, { live });
  // Decrypt echoes ciphertext as the group key so each event yields a distinct store.
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
      "lower event id (relay canonical winner) must be applied",
    );
    assert.equal(
      hook.result.current.sortModeFor("bbbb"),
      "alpha",
      "larger id's store must be superseded by the lower-id whole-blob winner",
    );
    hook.unmount();
  } finally {
    cleanup();
    restoreRelay();
    restoreTauri();
  }
});

// Carl P1-sort regression: on reconnect the hook must wake the EXISTING pending
// edit (retryPendingPublish) rather than re-queue it via publishSortPrefs().
// Mutation: reverting the reconnect handler to publishSortPrefs(pending) resets
// the baseline and publishes the stale edit over the advanced remote.
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
  relayClient.fetchEvents = async () => [head]; // override stubRelay's fetchEvents
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
      "must adopt the advanced remote on reconnect, never publish",
    );
    assert.equal(
      hook.result.current.sortModeFor("channels"),
      "alpha",
      "the losing local edit must be adopted away",
    );
    assert.equal(
      hook.result.current.sortModeFor("remote-group"),
      "recent",
      "the advanced remote store must be adopted",
    );
    hook.unmount();
  } finally {
    cleanup();
    relayClient.fetchEvents = origFetch;
    restoreRelay();
    restoreTauri();
  }
});

// Thufir pass-3 blocker: a legacy blob whose v2 transfer fails (quota) must NOT
// write the consumed marker. Mutation: writing the marker unconditionally
// consumes the legacy blob after a failed transfer and it is lost.
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

    const markerWritten = [...map.keys()].some((k) =>
      k.includes("-legacy-consumed:"),
    );
    assert.equal(
      markerWritten,
      false,
      "consumed marker must not be written after a failed v2 transfer",
    );
    const resumed = readChannelSortOutbox(pubkey, relayUrl);
    assert.ok(resumed !== null, "legacy blob must remain replayable");
    assert.equal(
      resumed.store.groups["legacy-group"],
      "recent",
      "the exact legacy intent survives",
    );
    assert.ok(
      resumed.legacyRawToConsume !== null,
      "legacy record still reports itself for consumption",
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
