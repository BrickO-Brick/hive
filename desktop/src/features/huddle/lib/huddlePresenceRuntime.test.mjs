import assert from "node:assert/strict";
import test from "node:test";

import { startHuddlePresenceRuntime } from "./huddlePresenceRuntime.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const RELAY = "c".repeat(64);

function event({
  id,
  kind,
  pubkey = ALICE,
  tags = [],
  admissionId,
  rosterRevision,
  createdAt = Number(id),
}) {
  return {
    id,
    kind,
    pubkey,
    content: JSON.stringify({
      ephemeral_channel_id: "room",
      admission_id: admissionId,
      roster_revision: rosterRevision,
    }),
    tags,
    created_at: createdAt,
    sig: "",
  };
}

function participantEvent(options) {
  return event({ pubkey: RELAY, tags: [["p", BOB]], ...options });
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function runtimeHarness(initialHistory) {
  let history = initialHistory;
  let reconnect;
  let liveHandler;
  let liveDisposed = false;
  let reconnectDisposed = false;
  const snapshots = [];
  const filters = [];
  const runtime = startHuddlePresenceRuntime({
    relaySelfPubkey: RELAY,
    channelIds: ["general", "design"],
    subscribeLive: async (filter, handler) => {
      filters.push(filter);
      liveHandler = handler;
      return () => {
        liveDisposed = true;
      };
    },
    fetchEvents: async () => history,
    subscribeToReconnects: (listener) => {
      reconnect = listener;
      return () => {
        reconnectDisposed = true;
      };
    },
    onPresence: (participants) => snapshots.push(new Set(participants)),
    nowSeconds: () => 1_000,
  });

  return {
    dispose: runtime,
    emit: (next) => liveHandler(next),
    filters,
    reconnect: () => reconnect(),
    setHistory: (next) => {
      history = next;
    },
    snapshots,
    wasDisposed: () => liveDisposed && reconnectDisposed,
  };
}

test("hydrates lifecycle history in global phase and revision order", async () => {
  const harness = runtimeHarness([
    participantEvent({
      id: "join",
      kind: 48101,
      admissionId: "desktop",
      rosterRevision: 1,
      createdAt: 10,
    }),
    event({ id: "start", kind: 48100, createdAt: 10 }),
  ]);

  await settle();

  assert.equal(harness.snapshots.at(-1).has(ALICE), true);
  assert.equal(harness.snapshots.at(-1).has(BOB), true);
  assert.equal(harness.filters[0].limit > 0, true);
  assert.equal(harness.filters[0].since, 1_000);
  assert.deepEqual(harness.filters[0]["#h"], ["design", "general"]);
  harness.dispose();
});

test("reconciles joins, leaves, and ends missed during disconnect", async () => {
  const start = event({ id: "1", kind: 48100 });
  const join = participantEvent({
    id: "2",
    kind: 48101,
    admissionId: "desktop",
    rosterRevision: 1,
  });
  const left = participantEvent({
    id: "3",
    kind: 48102,
    admissionId: "desktop",
    rosterRevision: 2,
  });
  const ended = event({ id: "4", kind: 48103, pubkey: RELAY });
  const harness = runtimeHarness([start]);
  await settle();

  harness.setHistory([join, start]);
  harness.reconnect();
  await settle();
  assert.equal(harness.snapshots.at(-1).has(BOB), true);

  harness.setHistory([left, join, start]);
  harness.reconnect();
  await settle();
  assert.equal(harness.snapshots.at(-1).has(BOB), false);
  assert.equal(harness.snapshots.at(-1).has(ALICE), true);

  harness.setHistory([ended, left, join, start]);
  harness.reconnect();
  await settle();
  assert.deepEqual([...harness.snapshots.at(-1)], []);
  harness.dispose();
});

test("applies channel-scoped live joins, leaves, and ends without reconnecting", async () => {
  const start = event({
    id: "1",
    kind: 48100,
    tags: [["h", "general"]],
  });
  const harness = runtimeHarness([start]);
  await settle();

  harness.emit(
    participantEvent({
      id: "2",
      kind: 48101,
      admissionId: "desktop",
      rosterRevision: 1,
      tags: [
        ["h", "general"],
        ["p", BOB],
      ],
    }),
  );
  assert.equal(harness.snapshots.at(-1).has(BOB), true);

  harness.emit(
    participantEvent({
      id: "3",
      kind: 48102,
      admissionId: "desktop",
      rosterRevision: 2,
      tags: [
        ["h", "general"],
        ["p", BOB],
      ],
    }),
  );
  assert.equal(harness.snapshots.at(-1).has(BOB), false);
  assert.equal(harness.snapshots.at(-1).has(ALICE), true);

  harness.emit(
    event({
      id: "4",
      kind: 48103,
      pubkey: RELAY,
      tags: [["h", "general"]],
    }),
  );
  assert.deepEqual([...harness.snapshots.at(-1)], []);
  harness.dispose();
});

test("retries a failed hydration and tears down every recovery path", async () => {
  let attempts = 0;
  let retry;
  let reconnect;
  let liveDisposed = false;
  let reconnectDisposed = false;
  const snapshots = [];
  const dispose = startHuddlePresenceRuntime({
    relaySelfPubkey: RELAY,
    channelIds: ["general"],
    subscribeLive: async () => () => {
      liveDisposed = true;
    },
    fetchEvents: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary timeout");
      return [event({ id: "1", kind: 48100 })];
    },
    subscribeToReconnects: (listener) => {
      reconnect = listener;
      return () => {
        reconnectDisposed = true;
      };
    },
    onPresence: (participants) => snapshots.push(new Set(participants)),
    setRetryTimer: (callback) => {
      retry = callback;
      return callback;
    },
    clearRetryTimer: () => {
      retry = undefined;
    },
  });

  await settle();
  assert.deepEqual([...snapshots.at(-1)], []);
  assert.equal(typeof retry, "function");

  retry();
  await settle();
  assert.equal(snapshots.at(-1).has(ALICE), true);

  dispose();
  assert.equal(liveDisposed, true);
  assert.equal(reconnectDisposed, true);
  reconnect();
  await settle();
  assert.equal(attempts, 2);
});
