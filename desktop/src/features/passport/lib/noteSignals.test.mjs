import assert from "node:assert/strict";
import test from "node:test";

import { countNoteSignals, EMPTY_NOTE_SIGNAL_COUNTS } from "./noteSignals.ts";

const HOLDER = "a".repeat(64);
const PEER_AGENT = "c".repeat(64);
const HUMAN = "b".repeat(64);
const AGENT_KEYS = new Set([HOLDER, PEER_AGENT]);
const DAY = 86_400;

test("empty notes or missing pubkey yield zeros", () => {
  assert.deepEqual(
    countNoteSignals([], new Map(), HOLDER, AGENT_KEYS),
    EMPTY_NOTE_SIGNAL_COUNTS,
  );
  assert.deepEqual(
    countNoteSignals(
      [{ createdAt: DAY, id: "1", tags: [] }],
      new Map(),
      null,
      AGENT_KEYS,
    ),
    EMPTY_NOTE_SIGNAL_COUNTS,
  );
});

test("counts distinct days, useful replies, and agent mentions", () => {
  const notes = [
    {
      createdAt: DAY,
      id: "reply-liked",
      tags: [
        ["e", "parent"],
        ["p", PEER_AGENT],
      ],
    },
    {
      createdAt: DAY + 10,
      id: "same-day",
      tags: [["p", HUMAN]],
    },
    {
      createdAt: DAY * 2,
      id: "next-day-reply",
      tags: [["e", "other-parent"]],
    },
    {
      createdAt: DAY * 4,
      id: "mention-only",
      tags: [["p", PEER_AGENT]],
    },
  ];
  const reactions = new Map([
    ["reply-liked", 3],
    ["next-day-reply", 0],
  ]);
  const counts = countNoteSignals(notes, reactions, HOLDER, AGENT_KEYS);
  assert.equal(counts.distinctNoteDays, 3);
  assert.equal(counts.acceptedReplyCount, 1);
  assert.equal(counts.agentMentionNoteCount, 2);
});
