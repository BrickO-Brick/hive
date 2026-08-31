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

test("assignChannel refreshes an existing assignment before the next eviction", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { MAX_CHANNEL_SECTION_ASSIGNMENTS, storageKey } = await import(
    "./channelSectionsStorage.ts"
  );
  const { useChannelSections } = await import("./useChannelSections.ts");

  const restoreRelay = stubRelay(relayClient);
  const pubkey = "pk-at-capacity";
  const relayUrl = "wss://relay.example";
  const assignments = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_SECTION_ASSIGNMENTS }, (_, i) => [
      `chan-${String(i).padStart(4, "0")}`,
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
    restoreRelay();
  }
});

// Carl P1.1 regression: storage event while a local edit is pending must NOT
// clobber the optimistic edit.
// Mutation: removing `hasPendingEdit()` guard in the storage handler causes setStore to apply B1.
test("storage event while a local edit is pending is deferred, not applied", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSections } = await import("./useChannelSections.ts");
  const { storageKey } = await import("./channelSectionsStorage.ts");

  const restoreRelay = stubRelay(relayClient);
  const restoreTauri = stubTauri("pk-storage-guard", null);
  const pubkey = "pk-storage-guard";
  const relayUrl = "wss://r.storage-guard";
  let hook = null;
  try {
    await act(async () => {
      hook = renderHook(() => useChannelSections(pubkey, relayUrl));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      hook.result.current.createSection("A1-Section");
    });
    const storeAfterA1 = hook.result.current.sections.map((s) => s.id);
    assert.ok(
      storeAfterA1.some((id) => id.length > 0),
      "A1 section created",
    );
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
    assert.ok(
      !hook.result.current.sections.map((s) => s.id).includes("b1-section"),
      "storage event while pending must not apply B1",
    );
    assert.deepEqual(
      hook.result.current.sections.map((s) => s.id),
      storeAfterA1,
      "optimistic state unchanged after deferred storage event",
    );
    await act(async () => {
      hook.result.current.createSection("A2-Section");
    });
    assert.ok(
      !hook.result.current.sections.map((s) => s.id).includes("b1-section"),
      "A2 derived from A1 state — b1-section must not appear",
    );
    hook.unmount();
  } finally {
    cleanup();
    restoreRelay();
    restoreTauri();
  }
});

// Fix 2 regression: live remote while a local edit is pending must NOT overwrite
// the optimistic edit or strand its durable outbox.
// Mutation: reverting applyRemote's hasPendingEdit guard clobbers the UI.
test("live remote while a local edit is pending defers to the pending edit", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSections } = await import("./useChannelSections.ts");
  const { readChannelSectionsOutbox } = await import(
    "./channelSectionsStorage.ts"
  );

  const live = {};
  const restoreRelay = stubRelay(relayClient, { live });
  const restoreTauri = stubTauri("pk-live-pending", () =>
    JSON.stringify({
      version: 1,
      sections: [{ id: "remote", name: "Remote", order: 0 }],
      assignments: {},
    }),
  );
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
    assert.ok(live.cb, "live subscription installed");
    await act(async () => {
      hook.result.current.createSection("Local");
    });
    assert.ok(
      readChannelSectionsOutbox(pubkey, relayUrl),
      "local edit persisted to outbox",
    );
    const localSectionIds = hook.result.current.sections.map((s) => s.id);
    await act(async () => {
      live.cb({
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
      "pending local edit NOT overwritten by live remote",
    );
    assert.ok(
      readChannelSectionsOutbox(pubkey, relayUrl),
      "outbox for pending edit survives live remote",
    );
    hook.unmount();
  } finally {
    cleanup();
    restoreRelay();
    restoreTauri();
  }
});

// Fix 3 regression: equal-timestamp tie-break must match the relay's canonical
// winner (lowest id wins).
// Mutation: reverting applyRemote's `>=` back to `<=` converges on the larger id.
test("equal-timestamp tie-break applies the lower event id (relay canonical winner)", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSections } = await import("./useChannelSections.ts");

  const live = {};
  const restoreRelay = stubRelay(relayClient, { live });
  const restoreTauri = stubTauri("pk-tie", (args) => {
    const id = args?.ciphertext ?? "";
    return JSON.stringify({
      version: 1,
      sections: [{ id, name: id, order: 0 }],
      assignments: {},
    });
  });
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
    assert.ok(live.cb, "live subscription installed");
    const deliver = async (id) => {
      await act(async () => {
        live.cb({
          id,
          pubkey,
          created_at: 1000,
          content: id,
          kind: 30078,
          tags: [["d", "channel-sections"]],
          sig: "s",
        });
        await Promise.resolve();
        await Promise.resolve();
      });
    };
    await deliver("bbbb");
    await deliver("aaaa");
    assert.deepEqual(
      hook.result.current.sections.map((s) => s.id),
      ["aaaa"],
      "lower event id wins tie-break",
    );
    hook.unmount();
  } finally {
    cleanup();
    restoreRelay();
    restoreTauri();
  }
});

// Carl P1-sections: on reconnect the hook must wake the EXISTING pending edit
// (retryPendingPublish) rather than re-queue it via publishSections().
// Mutation: reverting reconnect handler to publishSortPrefs(pending) resets baseline.
test("reconnect adopts a remote that advanced while the edit was pending, never publishing over it", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSections } = await import("./useChannelSections.ts");

  const reconnect = {};
  const publishCalls = [];
  let head = {
    pubkey: "pk-sec-recon",
    content: "remote-cipher",
    created_at: 100,
    id: "evt-100",
  };
  const origFetch = relayClient.fetchEvents;
  relayClient.fetchEvents = async () => [head];
  const restoreRelay = stubRelay(relayClient, { reconnect, publishCalls });
  relayClient.fetchEvents = async () => [head];
  const restoreTauri = stubTauri("pk-sec-recon", () =>
    JSON.stringify({
      version: 1,
      sections: [{ id: "remote", name: "Remote", order: 0 }],
      assignments: {},
    }),
  );
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
    assert.ok(reconnect.cb, "reconnect handler installed");
    await act(async () => {
      hook.result.current.createSection("Local");
    });
    assert.ok(
      hook.result.current.sections.some((s) => s.name === "Local"),
      "optimistic local section applied",
    );
    head = {
      pubkey: "pk-sec-recon",
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
    assert.deepEqual(
      hook.result.current.sections.map((s) => s.id),
      ["remote"],
      "losing local edit adopted away",
    );
    hook.unmount();
  } finally {
    cleanup();
    relayClient.fetchEvents = origFetch;
    restoreRelay();
    restoreTauri();
  }
});

// Thufir pass-3: a legacy replay whose v2 transfer fails (quota) must NOT write
// the consumed marker.
// Mutation: writing the marker unconditionally loses the legacy blob.
test("legacy replay whose v2 transfer fails (quota) does not write the consumed marker", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSections } = await import("./useChannelSections.ts");
  const { readChannelSectionsOutbox } = await import(
    "./channelSectionsStorage.ts"
  );
  const { normalizeRelayUrl } = await import("@/shared/lib/normalizeRelayUrl");

  const origLocalStorage = window.localStorage;
  const pubkey = "pk-sec-quota";
  const relayUrl = "wss://r.sec-quota";
  const scope = `${pubkey}:${encodeURIComponent(normalizeRelayUrl(relayUrl))}`;
  const legacyKey = `buzz-channel-sections-outbox.v1:${scope}`;
  const v2Prefix = `buzz-channel-sections-outbox.v1:${scope}:`;
  const legacyRaw = JSON.stringify({
    store: {
      version: 1,
      sections: [{ id: "legacy", name: "Legacy", order: 0 }],
      assignments: {},
    },
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
      `buzz-sync-watermark.v1:channel-sections:${pubkey}:${encodeURIComponent(normalizeRelayUrl(relayUrl))}`,
      "1700000000",
    );
    await act(async () => {
      hook = renderHook(() => useChannelSections(pubkey, relayUrl));
      for (let i = 0; i < 4; i++) await Promise.resolve();
    });
    assert.equal(
      [...map.keys()].some((k) => k.includes("-legacy-consumed:")),
      false,
      "consumed marker must not be written after failed v2 transfer",
    );
    const resumed = readChannelSectionsOutbox(pubkey, relayUrl);
    assert.ok(resumed !== null, "legacy blob must remain replayable");
    assert.equal(
      resumed.store.sections[0]?.id,
      "legacy",
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
