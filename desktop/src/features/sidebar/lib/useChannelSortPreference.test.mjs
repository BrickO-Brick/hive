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

// Carl P1.1 regression (sort): a peer-cache storage event arriving while a
// local whole-blob sort edit is pending must NOT clobber the optimistic edit.
// The storage handler must defer to the pending edit just as `applyRemote` does
// for relay arrivals. Peer writes arrive immediately when nothing is pending.
//
// Scenario: window A sets sort mode for "channels" (pending). Window B writes
// B1 (sort mode "recent" for "channels") to the shared cache. A's storage event
// fires. A2 is then set inside the debounce window. The resulting sort mode for
// A must reflect A2, not B1's value — B1's write was ignored while A1 was live.
//
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

  const origFetch = relayClient.fetchEvents;
  const origLive = relayClient.subscribeLive;
  const origReconnect = relayClient.subscribeToReconnects;
  const origPublish = relayClient.publishEvent;
  const origTauri = window.__TAURI_INTERNALS__;

  relayClient.fetchEvents = async () => [];
  relayClient.subscribeLive = async () => async () => {};
  relayClient.subscribeToReconnects = () => () => {};
  relayClient.publishEvent = async () => {};
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd) => {
      if (cmd === "nip44_encrypt_to_self") return Promise.resolve("ct");
      if (cmd === "sign_event")
        return Promise.resolve(
          JSON.stringify({
            id: "signed",
            pubkey: "pk-sort-sg",
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

    // Window B writes "recent" for "channels" to the shared cache and fires a
    // storage event.
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

    // B1's "recent" must NOT have replaced A1's "alpha".
    assert.equal(
      hook.result.current.sortModeFor("channels"),
      "alpha",
      "storage event while pending must not apply B1 (recent) over A1 (alpha)",
    );

    // A2: set "starred" to "recent" — derived from A1 state (channels stays alpha).
    await act(async () => {
      hook.result.current.setSortModeFor("starred", "recent");
    });
    // channels must still reflect A1 (alpha), not B1 (recent).
    assert.equal(
      hook.result.current.sortModeFor("channels"),
      "alpha",
      "A2 must be derived from A1 state — channels must remain alpha, not revert to B1 recent",
    );

    hook.unmount();
  } finally {
    cleanup();
    relayClient.fetchEvents = origFetch;
    relayClient.subscribeLive = origLive;
    relayClient.subscribeToReconnects = origReconnect;
    relayClient.publishEvent = origPublish;
    window.__TAURI_INTERNALS__ = origTauri;
  }
});

// Carl P1-sort regression: a live remote arriving while a local sort edit is
// still pending must NOT overwrite the optimistic edit or strand its durable
// outbox. Reverting applyRemote's `hasPendingEdit()` guard (or restoring the
// old `cancelPendingPublish()` on remote arrival) lets the remote clobber the
// pending edit and drop it.
test("live remote while a local edit is pending defers to the pending edit", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSortPreference } = await import(
    "./useChannelSortPreference.ts"
  );
  const { readChannelSortOutbox } = await import("./channelSortPreference.ts");

  const origFetch = relayClient.fetchEvents;
  const origLive = relayClient.subscribeLive;
  const origReconnect = relayClient.subscribeToReconnects;
  const origPublish = relayClient.publishEvent;
  const origTauri = window.__TAURI_INTERNALS__;

  let live = null;
  relayClient.fetchEvents = async () => [];
  relayClient.subscribeLive = async (_f, cb) => {
    live = cb;
    return async () => {};
  };
  relayClient.subscribeToReconnects = () => () => {};
  relayClient.publishEvent = async () => {};
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd) => {
      if (cmd === "nip44_decrypt_from_self")
        return Promise.resolve(
          JSON.stringify({
            version: 1,
            groups: { "remote-group": "recent" },
          }),
        );
      if (cmd === "nip44_encrypt_to_self") return Promise.resolve("ct");
      if (cmd === "sign_event")
        return Promise.resolve(
          JSON.stringify({
            id: "signed",
            pubkey: "pk-sort-pending",
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
    assert.ok(live, "live subscription installed");

    // Make a local edit — it becomes the pending store and persists to outbox.
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

    // A remote live event arrives while the edit is still pending.
    await act(async () => {
      live({
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
      "pending local edit must NOT be overwritten by the live remote",
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
    relayClient.fetchEvents = origFetch;
    relayClient.subscribeLive = origLive;
    relayClient.subscribeToReconnects = origReconnect;
    relayClient.publishEvent = origPublish;
    window.__TAURI_INTERNALS__ = origTauri;
  }
});

// Equal-timestamp tie-break must match the relay's canonical winner
// (`created_at DESC, id ASC` → LOWEST id wins). Deliver the larger id first,
// then the lower id at the same timestamp; the lower id is the stored winner
// and its whole-blob store must replace the applied state. Reverting
// applyRemote's `>=` back to `<=` wrongly ignores the lower id (the relay winner).
test("equal-timestamp tie-break applies the lower event id (relay canonical winner)", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSortPreference } = await import(
    "./useChannelSortPreference.ts"
  );

  const origFetch = relayClient.fetchEvents;
  const origLive = relayClient.subscribeLive;
  const origReconnect = relayClient.subscribeToReconnects;
  const origTauri = window.__TAURI_INTERNALS__;

  let live = null;
  relayClient.fetchEvents = async () => [];
  relayClient.subscribeLive = async (_f, cb) => {
    live = cb;
    return async () => {};
  };
  relayClient.subscribeToReconnects = () => () => {};
  // Decrypt payload keyed off the event id embedded in the ciphertext so each
  // delivered event yields a store setting a distinct group's mode to "recent".
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      if (cmd === "nip44_decrypt_from_self") {
        const id = args?.ciphertext ?? "";
        return Promise.resolve(
          JSON.stringify({ version: 1, groups: { [id]: "recent" } }),
        );
      }
      return Promise.reject(new Error(`unmocked ${cmd}`));
    },
  };

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
    assert.ok(live, "live subscription installed");

    const deliver = async (id) => {
      await act(async () => {
        live({
          id,
          pubkey,
          created_at: 1000,
          content: id, // decrypt echoes this into the group key
          kind: 30078,
          tags: [["d", "channel-sort"]],
          sig: "s",
        });
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    // Larger id first (applied), then the lower id at the same timestamp — the
    // relay's canonical winner, whose whole-blob store must replace the state.
    await deliver("bbbb");
    await deliver("aaaa");

    assert.equal(
      hook.result.current.sortModeFor("aaaa"),
      "recent",
      "lower event id (relay canonical winner) must be applied, not rejected",
    );
    assert.equal(
      hook.result.current.sortModeFor("bbbb"),
      "alpha",
      "larger id's store must be superseded by the lower-id whole-blob winner",
    );
    hook.unmount();
  } finally {
    cleanup();
    relayClient.fetchEvents = origFetch;
    relayClient.subscribeLive = origLive;
    relayClient.subscribeToReconnects = origReconnect;
    window.__TAURI_INTERNALS__ = origTauri;
  }
});

// Carl P1-sort regression: on reconnect the hook must wake the EXISTING pending
// edit (retryPendingPublish) rather than re-queue it via publishSortPrefs().
// A re-queue bumps the generation and resets the frozen publishBaseline to the
// just-fetched head, so a remote that won whole-blob LWW while the edit was
// pending would be published over instead of adopted. Here the head advances
// (100 → 200) while a local edit is pending; on reconnect the advanced remote
// must be adopted and NOTHING published. Reverting the reconnect handler to
// publishSortPrefs(pending) resets the baseline and publishes the stale edit.
test("reconnect adopts a remote that advanced while the edit was pending, never publishing over it", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSortPreference } = await import(
    "./useChannelSortPreference.ts"
  );

  const origFetch = relayClient.fetchEvents;
  const origLive = relayClient.subscribeLive;
  const origReconnect = relayClient.subscribeToReconnects;
  const origPublish = relayClient.publishEvent;
  const origTauri = window.__TAURI_INTERNALS__;

  let reconnect = null;
  // A single mutable head the fetch returns; bumped to created_at 200 (a remote
  // that won LWW) right before the reconnect fires.
  let head = {
    pubkey: "pk-sort-recon",
    content: "remote-cipher",
    created_at: 100,
    id: "evt-100",
  };
  const publishCalls = [];
  relayClient.fetchEvents = async () => [head];
  relayClient.subscribeLive = async () => async () => {};
  relayClient.subscribeToReconnects = (cb) => {
    reconnect = cb;
    return () => {};
  };
  relayClient.publishEvent = async (...args) => {
    publishCalls.push(args);
  };
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd) => {
      // The head decrypts to a remote store setting `remote-group`.
      if (cmd === "nip44_decrypt_from_self")
        return Promise.resolve(
          JSON.stringify({ version: 1, groups: { "remote-group": "recent" } }),
        );
      if (cmd === "nip44_encrypt_to_self") return Promise.resolve("ct");
      if (cmd === "sign_event")
        return Promise.resolve(
          JSON.stringify({
            id: "signed",
            pubkey: "pk-sort-recon",
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
    assert.ok(reconnect, "reconnect handler installed");

    // Local edit while the head stands at created_at 100 — the baseline the
    // edit is frozen against.
    await act(async () => {
      hook.result.current.setSortModeFor("channels", "recent");
    });

    // The remote advances to created_at 200 (a peer won LWW), then reconnect
    // fires: the hook re-fetches and wakes the existing generation.
    head = {
      pubkey: "pk-sort-recon",
      content: "remote-cipher",
      created_at: 200,
      id: "evt-200",
    };
    await act(async () => {
      reconnect();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(
      publishCalls.length,
      0,
      "must adopt the advanced remote on reconnect, never publish the stale edit over it",
    );
    // On adopt the whole-blob store is replaced by the remote (which has no
    // `channels` entry), so the losing local edit is dropped and `channels`
    // reverts to the default. Under the mutation (re-queue) the pending edit is
    // never adopted away and `channels` stays "recent".
    assert.equal(
      hook.result.current.sortModeFor("channels"),
      "alpha",
      "the losing local edit must be adopted away by the advanced remote",
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
    relayClient.subscribeLive = origLive;
    relayClient.subscribeToReconnects = origReconnect;
    relayClient.publishEvent = origPublish;
    window.__TAURI_INTERNALS__ = origTauri;
  }
});

// Thufir pass-3 blocker (Carl P1 durability): a legacy (old-build) blob is
// replayed by copying it into this window's own v2 outbox key, then writing a
// "consumed" marker. writeOwnOutbox swallows setItem failures; the hook must
// therefore write the marker ONLY when the v2 transfer actually succeeded.
// Here the v2 outbox setItem throws (quota), so the transfer failed: the marker
// must NOT be written, leaving the legacy blob replayable on a later boot rather
// than silently suppressed. Mutation: writing the marker unconditionally (the
// pre-fix code) consumes the legacy blob after a failed transfer and it is lost.
test("legacy replay whose v2 transfer fails (quota) does not write the consumed marker", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSortPreference } = await import(
    "./useChannelSortPreference.ts"
  );
  const { readChannelSortOutbox } = await import("./channelSortPreference.ts");
  const { normalizeRelayUrl } = await import("@/shared/lib/normalizeRelayUrl");

  const origFetch = relayClient.fetchEvents;
  const origLive = relayClient.subscribeLive;
  const origReconnect = relayClient.subscribeToReconnects;
  const origPublish = relayClient.publishEvent;
  const origTauri = window.__TAURI_INTERNALS__;
  const origLocalStorage = window.localStorage;

  const pubkey = "pk-quota";
  const relayUrl = "wss://r.quota";
  const scope = `${pubkey}:${encodeURIComponent(normalizeRelayUrl(relayUrl))}`;
  const legacyKey = `buzz-channel-sort-outbox.v1:${scope}`;
  const v2Prefix = `buzz-channel-sort-outbox.v1:${scope}:`; // nonce/seq suffix
  const legacyRaw = JSON.stringify({
    store: { version: 1, groups: { "legacy-group": "recent" } },
    queuedAt: 0,
  });

  // A backing localStorage that throws on any v2 outbox write (the quota
  // failure), while allowing the legacy read, the marker write, and applied
  // state through — so the ONLY failure is the durability transfer.
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

  const head = null;
  relayClient.fetchEvents = async () => (head ? [head] : []);
  relayClient.subscribeLive = async () => async () => {};
  relayClient.subscribeToReconnects = () => () => {};
  relayClient.publishEvent = async () => {};
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd) => {
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

  let hook = null;
  try {
    // Seed a prior watermark so bootstrap holds (no first-sync seed) and the
    // legacy blob is the sole outbox record resumed.
    Object.defineProperty(window, "localStorage", {
      value: throwingStorage,
      configurable: true,
    });
    window.localStorage.setItem(
      `buzz-sync-watermark.v1:channel-sort:${pubkey}:${encodeURIComponent(
        normalizeRelayUrl(relayUrl),
      )}`,
      "1700000000",
    );

    await act(async () => {
      hook = renderHook(() => useChannelSortPreference(pubkey, relayUrl));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The marker must NOT have been written: the v2 transfer threw.
    const markerWritten = [...map.keys()].some((k) =>
      k.includes("-legacy-consumed:"),
    );
    assert.equal(
      markerWritten,
      false,
      "consumed marker must not be written after a failed v2 transfer",
    );
    // The legacy blob is still enumerated as replayable — not silently lost.
    const resumed = readChannelSortOutbox(pubkey, relayUrl);
    assert.ok(resumed !== null, "legacy blob must remain replayable");
    assert.equal(
      resumed.store.groups["legacy-group"],
      "recent",
      "the exact legacy intent survives for a later boot",
    );
    assert.ok(
      resumed.legacyRawToConsume !== null,
      "legacy record still reports itself for consumption on a later boot",
    );
    hook.unmount();
  } finally {
    cleanup();
    Object.defineProperty(window, "localStorage", {
      value: origLocalStorage,
      configurable: true,
    });
    relayClient.fetchEvents = origFetch;
    relayClient.subscribeLive = origLive;
    relayClient.subscribeToReconnects = origReconnect;
    relayClient.publishEvent = origPublish;
    window.__TAURI_INTERNALS__ = origTauri;
  }
});
