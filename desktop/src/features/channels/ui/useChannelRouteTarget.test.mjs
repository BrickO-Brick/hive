import assert from "node:assert/strict";
import test from "node:test";

import { getRouteTargetPanelAction } from "./useChannelRouteTarget.ts";

function makeMessage(overrides = {}) {
  return {
    id: "target",
    author: "alice",
    body: "hello",
    createdAt: 1,
    depth: 0,
    parentId: null,
    rootId: null,
    tags: [],
    time: "now",
    ...overrides,
  };
}

function byId(...messages) {
  return new Map(messages.map((message) => [message.id, message]));
}

test("top-level target without threadRootId stays in the main timeline", () => {
  const root = makeMessage();
  assert.deepEqual(getRouteTargetPanelAction(root, null, byId(root)), {
    kind: "main-timeline-only",
  });
});

test("top-level target with an explicit threadRootId opens its thread panel", () => {
  const root = makeMessage();
  assert.deepEqual(getRouteTargetPanelAction(root, root.id, byId(root)), {
    kind: "open-thread",
    expandedReplyIds: new Set(),
    replyTargetId: root.id,
    scrollTargetId: null,
    threadHeadId: root.id,
  });
});

test("reply target opens the thread scrolled to the reply", () => {
  const root = makeMessage({ id: "root" });
  const reply = makeMessage({
    id: "reply",
    parentId: "root",
    rootId: "root",
    depth: 1,
  });
  assert.deepEqual(getRouteTargetPanelAction(reply, null, byId(root, reply)), {
    kind: "open-thread",
    expandedReplyIds: new Set(),
    replyTargetId: "root",
    scrollTargetId: "reply",
    threadHeadId: "root",
  });
});

test("nested reply target expands its intermediate ancestors", () => {
  const root = makeMessage({ id: "root" });
  const mid = makeMessage({
    id: "mid",
    parentId: "root",
    rootId: "root",
    depth: 1,
  });
  const leaf = makeMessage({
    id: "leaf",
    parentId: "mid",
    rootId: "root",
    depth: 2,
  });
  assert.deepEqual(
    getRouteTargetPanelAction(leaf, null, byId(root, mid, leaf)),
    {
      kind: "open-thread",
      expandedReplyIds: new Set(["mid"]),
      replyTargetId: "root",
      scrollTargetId: "leaf",
      threadHeadId: "root",
    },
  );
});

test("broadcast reply target is not a panel action", () => {
  const root = makeMessage({ id: "root" });
  const broadcast = makeMessage({
    id: "broadcast",
    parentId: "root",
    rootId: "root",
    depth: 1,
    tags: [["broadcast", "1"]],
  });
  assert.deepEqual(
    getRouteTargetPanelAction(broadcast, null, byId(root, broadcast)),
    { kind: "none" },
  );
});

test("reply whose thread head is not loaded yet defers", () => {
  const reply = makeMessage({
    id: "reply",
    parentId: "missing-root",
    rootId: "missing-root",
    depth: 1,
  });
  assert.deepEqual(getRouteTargetPanelAction(reply, null, byId(reply)), {
    kind: "none",
  });
});
