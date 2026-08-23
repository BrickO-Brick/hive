import assert from "node:assert/strict";
import test from "node:test";

import {
  markConfirmedThreadReplyRead,
  sendThreadReplyWithReadBackstop,
} from "./threadReadTransitions.ts";

test("confirmed thread reply advances the thread frontier to the reply timestamp", () => {
  const calls = [];
  markConfirmedThreadReplyRead(
    "root-1",
    { created_at: 120 },
    (rootId, timestamp) => calls.push({ rootId, timestamp }),
  );
  assert.deepEqual(calls, [{ rootId: "root-1", timestamp: 120 }]);
});

test("REST reply result uses the confirmed server timestamp", () => {
  const calls = [];
  markConfirmedThreadReplyRead(
    "root-1",
    { createdAt: 120 },
    (rootId, timestamp) => calls.push({ rootId, timestamp }),
  );
  assert.deepEqual(calls, [{ rootId: "root-1", timestamp: 120 }]);
});

test("missing thread root does not advance a frontier", () => {
  let called = false;
  markConfirmedThreadReplyRead(null, { createdAt: 120 }, () => {
    called = true;
  });
  assert.equal(called, false);
});

test("confirmed send advances only through the self reply so a later reply stays unread", async () => {
  let readAt = 100;
  const reply = await sendThreadReplyWithReadBackstop(
    Promise.resolve({ created_at: 120 }),
    () => "root-1",
    (_rootId, timestamp) => {
      readAt = Math.max(readAt, timestamp);
    },
  );

  assert.equal(reply.created_at, 120);
  assert.equal(readAt, 120);
  assert.equal(121 > readAt, true);
});

test("failed send leaves the thread frontier unchanged", async () => {
  let readAt = 100;

  await assert.rejects(
    sendThreadReplyWithReadBackstop(
      Promise.reject(new Error("send failed")),
      () => "root-1",
      (_rootId, timestamp) => {
        readAt = timestamp;
      },
    ),
    /send failed/,
  );

  assert.equal(readAt, 100);
});

test("Inbox reply uses the root and timestamp returned by the server", async () => {
  const calls = [];
  await sendThreadReplyWithReadBackstop(
    Promise.resolve({ createdAt: 140, rootEventId: "canonical-root" }),
    (reply) => reply.rootEventId,
    (rootId, timestamp) => calls.push({ rootId, timestamp }),
  );

  assert.deepEqual(calls, [{ rootId: "canonical-root", timestamp: 140 }]);
});
