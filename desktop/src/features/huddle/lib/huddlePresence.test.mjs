import assert from "node:assert/strict";
import test from "node:test";

import {
  HuddlePresenceTracker,
  HUDDLE_ACTIVE_LOOKBACK_SECONDS,
  HUDDLE_LIFECYCLE_PAGE_LIMIT,
  fetchActiveHuddleLifecycle,
  reconstructHuddlePresence,
} from "./huddlePresence.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const RELAY = "c".repeat(64);
const ATTACKER = "d".repeat(64);

function event({
  id,
  kind,
  pubkey = ALICE,
  session = "room",
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
      ephemeral_channel_id: session,
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

test("reconstructs authenticated huddle participants and removes leavers", () => {
  const result = reconstructHuddlePresence(
    [
      event({ id: "1", kind: 48100 }),
      participantEvent({ id: "2", kind: 48101 }),
      participantEvent({ id: "3", kind: 48102, tags: [["p", ALICE]] }),
    ],
    RELAY,
  );

  assert.deepEqual([...result], [BOB]);
});

test("fails closed without a verified relay identity", () => {
  const result = reconstructHuddlePresence(
    [
      event({ id: "1", kind: 48100 }),
      participantEvent({ id: "2", kind: 48101 }),
    ],
    null,
  );

  assert.deepEqual([...result], []);
});

test("ignores forged participant lifecycle events", () => {
  const result = reconstructHuddlePresence(
    [
      event({ id: "1", kind: 48100 }),
      event({
        id: "2",
        kind: 48101,
        pubkey: ATTACKER,
        tags: [["p", BOB]],
      }),
      event({
        id: "3",
        kind: 48102,
        pubkey: ATTACKER,
        tags: [["p", ALICE]],
      }),
    ],
    RELAY,
  );

  assert.deepEqual([...result], [ALICE]);
});

test("keeps a participant until their final admission leaves", () => {
  const result = reconstructHuddlePresence(
    [
      event({ id: "1", kind: 48100 }),
      participantEvent({
        id: "2",
        kind: 48101,
        admissionId: "desktop",
        rosterRevision: 1,
      }),
      participantEvent({
        id: "3",
        kind: 48101,
        admissionId: "mobile",
        rosterRevision: 2,
      }),
      participantEvent({
        id: "4",
        kind: 48102,
        admissionId: "desktop",
        rosterRevision: 3,
      }),
    ],
    RELAY,
  );

  assert.equal(result.has(BOB), true);
});

test("orders same-second reconnect events by roster revision", () => {
  const result = reconstructHuddlePresence(
    [
      event({ id: "1", kind: 48100, createdAt: 1 }),
      participantEvent({
        id: "z",
        kind: 48101,
        admissionId: "new",
        rosterRevision: 3,
        createdAt: 2,
      }),
      participantEvent({
        id: "a",
        kind: 48102,
        admissionId: "old",
        rosterRevision: 2,
        createdAt: 2,
      }),
    ],
    RELAY,
  );

  assert.equal(result.has(BOB), true);
});

test("ignores an older replay for the same admission", () => {
  const tracker = new HuddlePresenceTracker(RELAY);
  tracker.apply(event({ id: "1", kind: 48100 }));
  tracker.apply(
    participantEvent({
      id: "3",
      kind: 48102,
      admissionId: "desktop",
      rosterRevision: 3,
    }),
  );
  tracker.apply(
    participantEvent({
      id: "2",
      kind: 48101,
      admissionId: "desktop",
      rosterRevision: 2,
    }),
  );

  assert.equal(tracker.snapshot().has(BOB), false);
});

test("retains a legacy leave tombstone across snapshots", () => {
  const tracker = new HuddlePresenceTracker(RELAY);
  tracker.apply(event({ id: "1", kind: 48100, createdAt: 1 }));
  tracker.apply(participantEvent({ id: "2", kind: 48101, createdAt: 2 }));
  assert.equal(tracker.snapshot().has(BOB), true);

  tracker.apply(participantEvent({ id: "3", kind: 48102, createdAt: 3 }));
  assert.equal(tracker.snapshot().has(BOB), false);

  assert.equal(
    tracker.apply(participantEvent({ id: "2", kind: 48101, createdAt: 2 })),
    false,
  );
  assert.equal(tracker.snapshot().has(BOB), false);
});

test("ignores an older revision from a different admission", () => {
  const tracker = new HuddlePresenceTracker(RELAY);
  tracker.apply(event({ id: "1", kind: 48100 }));
  tracker.apply(
    participantEvent({
      id: "3",
      kind: 48102,
      admissionId: "new",
      rosterRevision: 3,
    }),
  );

  assert.equal(
    tracker.apply(
      participantEvent({
        id: "2",
        kind: 48101,
        admissionId: "old",
        rosterRevision: 2,
      }),
    ),
    false,
  );
  assert.equal(tracker.snapshot().has(BOB), false);
});

test("rejects an unauthorized end signer", () => {
  const result = reconstructHuddlePresence(
    [
      event({ id: "1", kind: 48100 }),
      event({ id: "2", kind: 48103, pubkey: ATTACKER }),
    ],
    RELAY,
  );

  assert.deepEqual([...result], [ALICE]);
});

test("accepts either creator-signed or relay-signed end events", () => {
  for (const pubkey of [ALICE, RELAY]) {
    const result = reconstructHuddlePresence(
      [
        event({ id: "1", kind: 48100 }),
        event({ id: "2", kind: 48103, pubkey }),
      ],
      RELAY,
    );
    assert.deepEqual([...result], []);
  }
});

test("requires a canonical start before participant events", () => {
  const result = reconstructHuddlePresence(
    [participantEvent({ id: "2", kind: 48101 })],
    RELAY,
  );

  assert.deepEqual([...result], []);
});

test("tracks simultaneous sessions and clears only the ended huddle", () => {
  const result = reconstructHuddlePresence(
    [
      event({ id: "1", kind: 48100, session: "first" }),
      event({ id: "2", kind: 48100, pubkey: BOB, session: "second" }),
      event({ id: "3", kind: 48103, session: "first" }),
    ],
    RELAY,
  );

  assert.deepEqual([...result], [BOB]);
});

test("pages the complete bounded active-huddle window", async () => {
  const firstPage = Array.from(
    { length: HUDDLE_LIFECYCLE_PAGE_LIMIT },
    (_, index) =>
      event({
        id: `first-${index}`,
        kind: 48101,
        createdAt: 9_500 - index,
      }),
  );
  const boundary = firstPage.at(-1).created_at;
  const secondPage = [
    firstPage.at(-1),
    event({ id: "older-start", kind: 48100, createdAt: boundary - 1 }),
  ];
  const filters = [];

  const result = await fetchActiveHuddleLifecycle(async (filter) => {
    filters.push(filter);
    return filters.length === 1 ? firstPage : secondPage;
  }, 10_000);

  assert.equal(result.length, HUDDLE_LIFECYCLE_PAGE_LIMIT + 1);
  assert.equal(filters[0].since, 10_000 - HUDDLE_ACTIVE_LOOKBACK_SECONDS);
  assert.equal(filters[0].until, undefined);
  assert.equal(filters[1].until, boundary);
});

test("refuses to claim exhaustive history at a dense timestamp", async () => {
  const page = Array.from({ length: HUDDLE_LIFECYCLE_PAGE_LIMIT }, (_, index) =>
    event({ id: `dense-${index}`, kind: 48101, createdAt: 9_000 }),
  );

  await assert.rejects(
    fetchActiveHuddleLifecycle(async () => page, 10_000),
    /timestamp exceeds one relay page/,
  );
});

test("incremental state retains an end tombstone and ignores late events", () => {
  const tracker = new HuddlePresenceTracker(RELAY);
  tracker.apply(event({ id: "1", kind: 48100 }));
  tracker.apply(event({ id: "2", kind: 48103, pubkey: RELAY }));

  assert.equal(
    tracker.apply(participantEvent({ id: "3", kind: 48101 })),
    false,
  );
  assert.deepEqual([...tracker.snapshot()], []);
});

test("incremental state ignores an older start replayed after an active session", () => {
  const tracker = new HuddlePresenceTracker(RELAY);
  tracker.apply(event({ id: "new", kind: 48100, createdAt: 10 }));
  tracker.apply(
    participantEvent({
      id: "join",
      kind: 48101,
      admissionId: "desktop",
      rosterRevision: 1,
      createdAt: 11,
    }),
  );

  assert.equal(
    tracker.apply(
      event({ id: "old", kind: 48100, pubkey: ATTACKER, createdAt: 9 }),
    ),
    false,
  );
  assert.equal(tracker.snapshot().has(BOB), true);
});

test("removes the creator after their final admission leaves", () => {
  const tracker = new HuddlePresenceTracker(RELAY);
  tracker.apply(event({ id: "1", kind: 48100 }));
  tracker.apply(
    participantEvent({
      id: "2",
      kind: 48101,
      tags: [["p", ALICE]],
      admissionId: "creator-device",
      rosterRevision: 1,
    }),
  );
  tracker.apply(
    participantEvent({
      id: "3",
      kind: 48102,
      tags: [["p", ALICE]],
      admissionId: "creator-device",
      rosterRevision: 2,
    }),
  );

  assert.equal(tracker.snapshot().has(ALICE), false);
});
