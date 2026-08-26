import assert from "node:assert/strict";
import test from "node:test";

import { buildIndependentThreadPanel } from "./independentThreadPanel.ts";

const ROOT_ID = "6".repeat(64);
const EDIT_ID = "9".repeat(64);
const REPLY_ID = "a".repeat(64);
const DELETION_ID = "d".repeat(64);
const AUTHOR = "f".repeat(64);
const CHANNEL = "chan-uuid";

function contentEvent(id, content, extraTags = []) {
  return {
    id,
    pubkey: AUTHOR,
    kind: 9,
    created_at: 1000,
    content,
    tags: [["h", CHANNEL], ...extraTags],
    sig: "s",
  };
}

function editEvent(id, targetId, content, createdAt) {
  return {
    id,
    pubkey: AUTHOR,
    kind: 40003,
    created_at: createdAt,
    content,
    tags: [
      ["h", CHANNEL],
      ["e", targetId],
    ],
    sig: "s",
  };
}

function deletionEvent(id, targetId) {
  return {
    id,
    pubkey: AUTHOR,
    kind: 5,
    created_at: 3000,
    content: "",
    tags: [
      ["h", CHANNEL],
      ["e", targetId],
    ],
    sig: "s",
  };
}

function head(channelEvents, replyEvents) {
  return buildIndependentThreadPanel(
    channelEvents,
    replyEvents,
    ROOT_ID,
    ROOT_ID,
    new Set(),
    null,
    AUTHOR,
    null,
    undefined,
    undefined,
    new Map(),
    new Map(),
    null,
    undefined,
  ).threadHead;
}

// Regression: the reported bug. The head's edit is in the channel window (so the
// main timeline shows it) but has NOT yet been pulled into the thread-reply aux
// cache. Before the fix the thread head rendered the un-edited original.
test("applies the head edit carried only in the channel window", () => {
  const root = contentEvent(ROOT_ID, "two PRs");
  const edit = editEvent(EDIT_ID, ROOT_ID, "these PRs (3)", 2000);
  const result = head([root, edit], []);
  assert.equal(result?.body, "these PRs (3)");
  assert.equal(result?.edited, true);
});

// The thread-aux backfill path must keep working when it is the only source.
test("applies the head edit carried only in reply-aux events", () => {
  const root = contentEvent(ROOT_ID, "two PRs");
  const edit = editEvent(EDIT_ID, ROOT_ID, "these PRs (3)", 2000);
  const result = head([root], [edit]);
  assert.equal(result?.body, "these PRs (3)");
  assert.equal(result?.edited, true);
});

// Same edit in both sources must not double-apply or drop; latest content wins.
test("dedups the same edit present in both sources", () => {
  const root = contentEvent(ROOT_ID, "two PRs");
  const edit = editEvent(EDIT_ID, ROOT_ID, "these PRs (3)", 2000);
  const result = head([root, edit], [edit]);
  assert.equal(result?.body, "these PRs (3)");
  assert.equal(result?.edited, true);
});

// No edit anywhere: head stays original, unedited.
test("leaves an unedited head untouched", () => {
  const root = contentEvent(ROOT_ID, "two PRs");
  const result = head([root], []);
  assert.equal(result?.body, "two PRs");
  assert.equal(result?.edited, false);
});

// A reply content event also `#e`-references the head as its parent. It must NOT
// be pulled in as head aux — replies flow through `replyEvents` only.
test("does not treat a channel-window reply as head aux", () => {
  const root = contentEvent(ROOT_ID, "two PRs");
  const reply = contentEvent(REPLY_ID, "a reply", [
    ["e", ROOT_ID, "", "reply"],
  ]);
  const panel = buildIndependentThreadPanel(
    [root, reply],
    [],
    ROOT_ID,
    ROOT_ID,
    new Set(),
    null,
    AUTHOR,
    null,
    undefined,
    undefined,
    new Map(),
    new Map(),
    null,
    undefined,
  );
  // The reply is not in replyEvents, so it should not surface in the panel.
  assert.equal(panel.threadHead?.body, "two PRs");
  assert.deepEqual(panel.visibleReplies, []);
});

// A channel-window deletion of the head must hide it, matching the main timeline.
test("applies a head deletion carried in the channel window", () => {
  const root = contentEvent(ROOT_ID, "two PRs");
  const deletion = deletionEvent(DELETION_ID, ROOT_ID);
  const result = head([root, deletion], []);
  assert.equal(result, null);
});
