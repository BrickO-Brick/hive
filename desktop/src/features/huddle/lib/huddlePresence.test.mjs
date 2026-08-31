import assert from "node:assert/strict";
import test from "node:test";

import { reconstructHuddlePresence } from "./huddlePresence.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function event({ id, kind, pubkey = ALICE, session = "room", tags = [] }) {
  return {
    id,
    kind,
    pubkey,
    content: JSON.stringify({ ephemeral_channel_id: session }),
    tags,
    created_at: Number(id),
    sig: "",
  };
}

test("reconstructs active huddle participants and removes leavers", () => {
  const result = reconstructHuddlePresence([
    event({ id: "1", kind: 48100 }),
    event({ id: "2", kind: 48101, tags: [["p", BOB]] }),
    event({ id: "3", kind: 48102, tags: [["p", ALICE]] }),
  ]);

  assert.deepEqual([...result], [BOB]);
});

test("tracks simultaneous sessions and clears only the ended huddle", () => {
  const result = reconstructHuddlePresence([
    event({ id: "1", kind: 48100, session: "first" }),
    event({ id: "2", kind: 48100, pubkey: BOB, session: "second" }),
    event({ id: "3", kind: 48103, session: "first" }),
  ]);

  assert.deepEqual([...result], [BOB]);
});

test("sorts replayed lifecycle events before deriving presence", () => {
  const result = reconstructHuddlePresence([
    event({ id: "3", kind: 48103 }),
    event({ id: "1", kind: 48100 }),
    event({ id: "2", kind: 48101, tags: [["p", BOB]] }),
  ]);

  assert.deepEqual([...result], []);
});
