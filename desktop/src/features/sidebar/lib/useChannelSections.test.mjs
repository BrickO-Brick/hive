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

test("assignChannel refreshes an existing assignment before the next eviction", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { MAX_CHANNEL_SECTION_ASSIGNMENTS, storageKey } = await import(
    "./channelSectionsStorage.ts"
  );
  const { useChannelSections } = await import("./useChannelSections.ts");

  const originalFetchEvents = relayClient.fetchEvents;
  const originalSubscribeLive = relayClient.subscribeLive;
  const originalSubscribeToReconnects = relayClient.subscribeToReconnects;
  relayClient.fetchEvents = async () => [];
  relayClient.subscribeLive = async () => async () => {};
  relayClient.subscribeToReconnects = () => () => {};

  const pubkey = "pk-at-capacity";
  const relayUrl = "wss://relay.example";
  const assignments = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_SECTION_ASSIGNMENTS }, (_, index) => [
      `chan-${String(index).padStart(4, "0")}`,
      "section-1",
    ]),
  );
  window.localStorage.setItem(
    storageKey(pubkey, relayUrl),
    JSON.stringify({
      version: 1,
      sections: [
        { id: "section-1", name: "One", order: 0 },
        { id: "section-2", name: "Two", order: 1 },
      ],
      assignments,
    }),
  );

  try {
    const { result, unmount } = renderHook(() =>
      useChannelSections(pubkey, relayUrl),
    );

    act(() => result.current.assignChannel("chan-0000", "section-2"));
    act(() => result.current.assignChannel("chan-new", "section-1"));

    assert.equal(result.current.assignments["chan-0000"], "section-2");
    assert.equal(result.current.assignments["chan-new"], "section-1");
    assert.equal(result.current.assignments["chan-0001"], undefined);
    assert.equal(
      Object.keys(result.current.assignments).length,
      MAX_CHANNEL_SECTION_ASSIGNMENTS,
    );
    unmount();
  } finally {
    cleanup();
    relayClient.fetchEvents = originalFetchEvents;
    relayClient.subscribeLive = originalSubscribeLive;
    relayClient.subscribeToReconnects = originalSubscribeToReconnects;
  }
});

// Carl P1.1 regression (sections): a peer-cache storage event arriving while a
// local whole-blob edit is pending must NOT clobber the optimistic edit or
// strand its outbox. The storage handler must defer to the pending edit just as
// `applyRemote` does for relay arrivals. The pending edit's debounced publish
// owns convergence and will publish-or-adopt against the relay.
//
// Scenario: window A creates section A1 (pending in outbox). Window B writes
// B1 (a different store) to the shared cache. A's storage handler fires. Before
// A's debounce fires, the user makes a second edit A2 inside the same debounce
// window. The resulting store must be derived from A1's state (A2 added on top
// of A1), and the outbox must still hold A's intent — not B1's shape.
//
// Mutation: removing the `hasPendingEdit()` guard in the storage handler causes
// setStore to apply B1, so A2 is derived from B1 instead. The outbox record
// still holds A's first edit shape, not the B1-derived A2 — an inconsistency
// the manager cannot resolve. The test detects the replacement: if B1 were
// applied, the final sections array would include B1's section id.
test("storage event while a local edit is pending is deferred, not applied", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSections } = await import("./useChannelSections.ts");
  const { storageKey } = await import("./channelSectionsStorage.ts");

  const origFetch = relayClient.fetchEvents;
  const origLive = relayClient.subscribeLive;
  const origReconnect = relayClient.subscribeToReconnects;
  const origPublish = relayClient.publishEvent;
  const origTauri = window.__TAURI_INTERNALS__;

  // Block all publishes so the debounce never fires during the test.
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
            pubkey: "pk-storage-guard",
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

  const pubkey = "pk-storage-guard";
  const relayUrl = "wss://r.storage-guard";
  let hook = null;
  try {
    await act(async () => {
      hook = renderHook(() => useChannelSections(pubkey, relayUrl));
      await Promise.resolve();
      await Promise.resolve();
    });

    // A1: window A creates a section — this becomes the pending edit.
    await act(async () => {
      hook.result.current.createSection("A1-Section");
    });
    const storeAfterA1 = hook.result.current.sections.map((s) => s.id);
    assert.ok(
      storeAfterA1.some((id) => id.length > 0),
      "A1 section created",
    );

    // Window B writes B1 to the shared scoped cache key (simulates a peer
    // window's edit landing in localStorage and firing the storage event).
    const b1Store = JSON.stringify({
      version: 1,
      sections: [{ id: "b1-section", name: "B1", order: 0 }],
      assignments: {},
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

    // B1 must NOT have replaced A1's optimistic state.
    const storeAfterStorageEvent = hook.result.current.sections.map(
      (s) => s.id,
    );
    assert.ok(
      !storeAfterStorageEvent.includes("b1-section"),
      "storage event while pending must not apply B1 to A's optimistic state",
    );
    assert.deepEqual(
      storeAfterStorageEvent,
      storeAfterA1,
      "optimistic state must be unchanged after the deferred storage event",
    );

    // A2: user makes a second edit inside the debounce window. It is derived
    // from A1's state (since B1 was deferred), so the result contains A1's
    // section plus A2's.
    await act(async () => {
      hook.result.current.createSection("A2-Section");
    });
    const finalIds = hook.result.current.sections.map((s) => s.id);
    assert.ok(
      !finalIds.includes("b1-section"),
      "A2 must be derived from A1 state, not B1 — b1-section must not appear",
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

// Fix 2 regression: a live remote arriving while a local edit is pending must
// NOT overwrite the optimistic edit or strand its durable outbox. The pending
// edit's own debounced publish owns convergence (publish-or-adopt). Reverting
// applyRemote's hasPendingEdit guard makes the live event clobber the UI and
// leave the outbox replay-eligible.
test("live remote while a local edit is pending defers to the pending edit", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSections } = await import("./useChannelSections.ts");
  const { readChannelSectionsOutbox } = await import(
    "./channelSectionsStorage.ts"
  );

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
            sections: [{ id: "remote", name: "Remote", order: 0 }],
            assignments: {},
          }),
        );
      if (cmd === "nip44_encrypt_to_self") return Promise.resolve("ct");
      if (cmd === "sign_event")
        return Promise.resolve(
          JSON.stringify({
            id: "signed",
            pubkey: "pk-live-pending",
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

  const pubkey = "pk-live-pending";
  const relayUrl = "wss://r.live";

  let hook = null;
  try {
    await act(async () => {
      hook = renderHook(() => useChannelSections(pubkey, relayUrl));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(live, "live subscription installed");

    // Make a local edit — it becomes the pending store and persists to outbox.
    await act(async () => {
      hook.result.current.createSection("Local");
    });
    assert.ok(
      readChannelSectionsOutbox(pubkey, relayUrl),
      "local edit persisted to outbox",
    );
    const localSectionIds = hook.result.current.sections.map((s) => s.id);

    // A remote live event arrives while the edit is still pending.
    await act(async () => {
      live({
        id: "remote-event",
        pubkey,
        created_at: 500,
        content: "cipher",
        kind: 30078,
        tags: [["d", "channel-sections"]],
        sig: "s",
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.deepEqual(
      hook.result.current.sections.map((s) => s.id),
      localSectionIds,
      "pending local edit must NOT be overwritten by the live remote",
    );
    assert.ok(
      readChannelSectionsOutbox(pubkey, relayUrl),
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

// Fix 3 regression: equal-timestamp tie-break must match the relay's canonical
// winner (`created_at DESC, id ASC` → LOWEST id wins). Deliver the larger id
// first, then the lower id at the same timestamp; the lower-id store must win.
// Reverting applyRemote's `>=` back to `<=` converges on the larger id instead.
test("equal-timestamp tie-break applies the lower event id (relay canonical winner)", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSections } = await import("./useChannelSections.ts");

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
  // delivered event yields a distinct store we can assert on.
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      if (cmd === "nip44_decrypt_from_self") {
        const id = args?.ciphertext ?? "";
        return Promise.resolve(
          JSON.stringify({
            version: 1,
            sections: [{ id, name: id, order: 0 }],
            assignments: {},
          }),
        );
      }
      return Promise.reject(new Error(`unmocked ${cmd}`));
    },
  };

  const pubkey = "pk-tie";
  const relayUrl = "wss://r.tie";
  let hook = null;
  try {
    await act(async () => {
      hook = renderHook(() => useChannelSections(pubkey, relayUrl));
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
          content: id, // decrypt echoes this into the section id
          kind: 30078,
          tags: [["d", "channel-sections"]],
          sig: "s",
        });
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    // Larger id first (would win under the old <= comparator)...
    await deliver("bbbb");
    // ...then the lower id at the same timestamp — the relay's canonical winner.
    await deliver("aaaa");

    assert.deepEqual(
      hook.result.current.sections.map((s) => s.id),
      ["aaaa"],
      "lower event id must win the equal-timestamp tie-break",
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

// Carl P1-sections regression: on reconnect the hook must wake the EXISTING
// pending edit (retryPendingPublish) rather than re-queue it via
// publishSections(). A re-queue bumps the generation and resets the frozen
// publishBaseline to the just-fetched head, so a remote that won whole-blob LWW
// while the edit was pending would be published over instead of adopted. Here
// the head advances (100 → 200) while a local edit is pending; on reconnect the
// advanced remote must be adopted (the losing local section dropped) and NOTHING
// published. Reverting the reconnect handler to publishSections(pending) resets
// the baseline and publishes the stale edit.
test("reconnect adopts a remote that advanced while the edit was pending, never publishing over it", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSections } = await import("./useChannelSections.ts");

  const origFetch = relayClient.fetchEvents;
  const origLive = relayClient.subscribeLive;
  const origReconnect = relayClient.subscribeToReconnects;
  const origPublish = relayClient.publishEvent;
  const origTauri = window.__TAURI_INTERNALS__;

  let reconnect = null;
  // A single mutable head; bumped to created_at 200 (a remote that won LWW)
  // right before the reconnect fires.
  let head = {
    pubkey: "pk-sec-recon",
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
      // The head decrypts to a remote store with a single "remote" section.
      if (cmd === "nip44_decrypt_from_self")
        return Promise.resolve(
          JSON.stringify({
            version: 1,
            sections: [{ id: "remote", name: "Remote", order: 0 }],
            assignments: {},
          }),
        );
      if (cmd === "nip44_encrypt_to_self") return Promise.resolve("ct");
      if (cmd === "sign_event")
        return Promise.resolve(
          JSON.stringify({
            id: "signed",
            pubkey: "pk-sec-recon",
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

  const pubkey = "pk-sec-recon";
  const relayUrl = "wss://r.recon";
  let hook = null;
  try {
    await act(async () => {
      hook = renderHook(() => useChannelSections(pubkey, relayUrl));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(reconnect, "reconnect handler installed");

    // Local edit while the head stands at created_at 100 — the baseline the
    // edit is frozen against.
    await act(async () => {
      hook.result.current.createSection("Local");
    });
    assert.ok(
      hook.result.current.sections.some((s) => s.name === "Local"),
      "optimistic local section applied",
    );

    // The remote advances to created_at 200 (a peer won LWW), then reconnect
    // fires: the hook re-fetches and wakes the existing generation.
    head = {
      pubkey: "pk-sec-recon",
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
    // On adopt the whole-blob store is replaced by the remote (only a "remote"
    // section), so the losing local edit is dropped. Under the mutation
    // (re-queue) the pending edit is never adopted away and "Local" survives.
    assert.deepEqual(
      hook.result.current.sections.map((s) => s.id),
      ["remote"],
      "the losing local edit must be adopted away by the advanced remote",
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

// Thufir pass-3 regression (sections lane): a legacy replay whose durability
// transfer into this window's own v2 key fails (quota) must NOT write the
// consumed marker. Otherwise the marker permanently suppresses the only copy of
// the legacy edit on every later boot — silent loss of exactly the durability
// this PR guarantees. The hook now gates markLegacyConsumed on the `durable`
// flag publishSections() returns; removing that guard writes the marker
// unconditionally and this test goes red.
test("legacy replay whose v2 transfer fails (quota) does not write the consumed marker", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSections } = await import("./useChannelSections.ts");
  const { readChannelSectionsOutbox } = await import(
    "./channelSectionsStorage.ts"
  );
  const { normalizeRelayUrl } = await import("@/shared/lib/normalizeRelayUrl");

  const origFetch = relayClient.fetchEvents;
  const origLive = relayClient.subscribeLive;
  const origReconnect = relayClient.subscribeToReconnects;
  const origPublish = relayClient.publishEvent;
  const origTauri = window.__TAURI_INTERNALS__;
  const origLocalStorage = window.localStorage;

  const pubkey = "pk-sec-quota";
  const relayUrl = "wss://r.sec-quota";
  const scope = `${pubkey}:${encodeURIComponent(normalizeRelayUrl(relayUrl))}`;
  const legacyKey = `buzz-channel-sections-outbox.v1:${scope}`;
  const v2Prefix = `buzz-channel-sections-outbox.v1:${scope}:`; // nonce/seq suffix
  const legacyRaw = JSON.stringify({
    store: {
      version: 1,
      sections: [{ id: "legacy", name: "Legacy", order: 0 }],
      assignments: {},
    },
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
      `buzz-sync-watermark.v1:channel-sections:${pubkey}:${encodeURIComponent(
        normalizeRelayUrl(relayUrl),
      )}`,
      "1700000000",
    );

    await act(async () => {
      hook = renderHook(() => useChannelSections(pubkey, relayUrl));
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
    const resumed = readChannelSectionsOutbox(pubkey, relayUrl);
    assert.ok(resumed !== null, "legacy blob must remain replayable");
    assert.equal(
      resumed.store.sections[0]?.id,
      "legacy",
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
