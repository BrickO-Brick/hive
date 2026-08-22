import assert from "node:assert/strict";
import test from "node:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import React from "react";

import { relayClient } from "../../shared/api/relayClient.ts";
import {
  collectThreadAuxMessageIds,
  useThreadRepliesForRoots,
} from "./useThreadReplies.ts";

const ROOT_ID = "1".repeat(64);
const REPLY_ID = "2".repeat(64);

function reply(id = REPLY_ID) {
  return {
    id,
    pubkey: "a".repeat(64),
    kind: 9,
    created_at: 1_700_000_000,
    content: "reply",
    tags: [["e", ROOT_ID]],
    sig: "sig",
  };
}

test("thread aux hydration includes the root when there are no replies", () => {
  assert.deepEqual(collectThreadAuxMessageIds(ROOT_ID, []), [ROOT_ID]);
});

test("thread aux hydration includes and deduplicates root and reply ids", () => {
  assert.deepEqual(
    collectThreadAuxMessageIds(ROOT_ID, [reply(), reply(ROOT_ID)]),
    [ROOT_ID, REPLY_ID],
  );
});

async function withHookEnvironment(run) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    tauri: globalThis.__TAURI_INTERNALS__,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  const pendingRequests = new Map();
  const tauriInternals = {
    invoke: (command, args) => {
      assert.equal(command, "get_thread_replies");
      return new Promise((resolve) => {
        pendingRequests.set(args.rootEventId, resolve);
      });
    },
    transformCallback: () => 1,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    __TAURI_INTERNALS__: tauriInternals,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  dom.window.__TAURI_INTERNALS__ = tauriInternals;

  try {
    const { act, renderHook } = await import("@testing-library/react");
    await run({ act, pendingRequests, renderHook });
  } finally {
    dom.window.close();
    Object.assign(globalThis, {
      window: previousGlobals.window,
      document: previousGlobals.document,
      __TAURI_INTERNALS__: previousGlobals.tauri,
      IS_REACT_ACT_ENVIRONMENT: previousGlobals.act,
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: previousGlobals.navigator,
    });
  }
}

function hookWrapper(client) {
  return ({ children }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

const channel = { id: "huddle", channelType: "stream" };

test("window-seeded huddle roots fetch and settle without a visible gap", async () => {
  const auxCalls = [];
  const fetchAuxEventsByReference = relayClient.fetchAuxEventsByReference;
  relayClient.fetchAuxEventsByReference = async (
    channelId,
    referencedEventIds,
    buildFilter,
  ) => {
    auxCalls.push({
      channelId,
      referencedEventIds,
      filter: buildFilter(channelId, referencedEventIds),
    });
    return [];
  };

  try {
    await withHookEnvironment(async ({ act, pendingRequests, renderHook }) => {
      const seededRootId = "3".repeat(64);
      const seededReply = reply("4".repeat(64));
      seededReply.tags = [["e", seededRootId, "", "reply"]];
      const authoritativeReply = reply("5".repeat(64));
      authoritativeReply.tags = [["e", seededRootId, "", "reply"]];
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const placeholderDataByRoot = new Map([[seededRootId, [seededReply]]]);
      const view = renderHook(
        () =>
          useThreadRepliesForRoots(channel, [seededRootId], {
            placeholderDataByRoot,
          }),
        { wrapper: hookWrapper(client) },
      );

      try {
        assert.deepEqual(view.result.current.events, [seededReply]);
        assert.equal(pendingRequests.has(seededRootId), true);
        await act(async () => {
          pendingRequests.get(seededRootId)({
            events: [authoritativeReply],
            nextCursor: null,
          });
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        assert.deepEqual(view.result.current.events, [authoritativeReply]);
        assert.equal(auxCalls.length, 2);
        for (const call of auxCalls) {
          assert.equal(call.channelId, channel.id);
          assert.deepEqual(call.referencedEventIds, [
            seededRootId,
            authoritativeReply.id,
          ]);
          assert.deepEqual(call.filter["#e"], [
            seededRootId,
            authoritativeReply.id,
          ]);
        }
      } finally {
        view.unmount();
        await client.cancelQueries();
        client.clear();
        client.unmount();
      }
    });
  } finally {
    relayClient.fetchAuxEventsByReference = fetchAuxEventsByReference;
  }
});
