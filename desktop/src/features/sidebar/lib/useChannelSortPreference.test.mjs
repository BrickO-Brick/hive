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
