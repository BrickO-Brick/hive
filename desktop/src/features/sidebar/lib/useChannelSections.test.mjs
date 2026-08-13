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

test("legacy subscription resolving after workspace cutover is disposed and cannot update canonical state", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { finalizeEvent } = await import("nostr-tools/pure");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelSections } = await import("./useChannelSections.ts");

  const originalFetchEvents = relayClient.fetchEvents;
  const originalSubscribeLive = relayClient.subscribeLive;
  const originalSubscribeToReconnects = relayClient.subscribeToReconnects;
  const owner =
    "1111111111111111111111111111111111111111111111111111111111111111";
  const relaySelf =
    "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";
  const ownerBytes = new Uint8Array(32).fill(1);
  const projection = {
    version: 1,
    owner_pubkey: owner,
    revision: 1,
    layout_revision: 1,
    key_epoch: 1,
    migration: {
      source_event_id:
        "2222222222222222222222222222222222222222222222222222222222222222",
      source_hash:
        "3333333333333333333333333333333333333333333333333333333333333333",
    },
    reader_key_envelope: "workspace-key-envelope",
    sections: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        rank: 0,
        encrypted_label: "canonical-label",
        encrypted_icon: null,
      },
    ],
    assignments: [],
  };
  const projectionTemplate = {
    pubkey: owner,
    created_at: 1,
    kind: 30623,
    tags: [
      ["d", owner],
      ["p", owner],
    ],
    content: JSON.stringify(projection),
  };
  const projectionEvent = finalizeEvent(projectionTemplate, ownerBytes);
  const legacyStore = {
    version: 1,
    sections: [
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        name: "legacy-name",
        order: 0,
      },
    ],
    assignments: {},
  };
  const legacyEvent = {
    id: "4444444444444444444444444444444444444444444444444444444444444444",
    pubkey: owner,
    created_at: 2,
    kind: 30078,
    tags: [["d", "channel-sections"]],
    content: "legacy-ciphertext",
    sig: "legacy-signature",
  };
  let resolveLegacySubscription;
  let legacyLiveCallback;
  let disposerCalls = 0;
  relayClient.fetchEvents = async (filter) =>
    filter.kinds.includes(30623) ? [projectionEvent] : [];
  relayClient.subscribeLive = (filter, onEvent) => {
    if (filter.kinds.includes(30078)) {
      legacyLiveCallback = onEvent;
      return new Promise((resolve) => {
        resolveLegacySubscription = resolve;
      });
    }
    return Promise.resolve(async () => {});
  };
  relayClient.subscribeToReconnects = () => () => {};
  const previousInternals = window.__TAURI_INTERNALS__;
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      if (command === "get_relay_self") return relaySelf;
      if (command === "nip44_decrypt_from_self") {
        return args.ciphertext === "legacy-ciphertext"
          ? JSON.stringify(legacyStore)
          : "workspace-key";
      }
      if (command === "decrypt_workspace_metadata") return "canonical-name";
      throw new Error(`unexpected command ${command}`);
    },
  };

  try {
    const { result, unmount } = renderHook(() =>
      useChannelSections(owner, "wss://relay.example"),
    );
    const flush = async () => {
      for (let index = 0; index < 5; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    await act(flush);
    assert.deepEqual(result.current.sections, [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "canonical-name",
        order: 0,
      },
    ]);
    assert.equal(typeof resolveLegacySubscription, "function");
    assert.equal(typeof legacyLiveCallback, "function");

    resolveLegacySubscription(async () => {
      disposerCalls += 1;
    });
    await act(flush);
    assert.equal(disposerCalls, 1);

    legacyLiveCallback(legacyEvent);
    await act(flush);
    assert.deepEqual(result.current.sections, [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "canonical-name",
        order: 0,
      },
    ]);
    unmount();
  } finally {
    cleanup();
    window.__TAURI_INTERNALS__ = previousInternals;
    relayClient.fetchEvents = originalFetchEvents;
    relayClient.subscribeLive = originalSubscribeLive;
    relayClient.subscribeToReconnects = originalSubscribeToReconnects;
  }
});
