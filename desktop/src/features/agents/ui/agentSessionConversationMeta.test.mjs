import assert from "node:assert/strict";
import test from "node:test";

import { buildConversationTurnMeta } from "./agentSessionConversationMeta.ts";
import { EMPTY_TRANSCRIPT_TURN_META } from "./agentSessionTranscriptContext.ts";
import {
  formatPlanChecklistProgress,
  parsePlanChecklist,
} from "./agentSessionPlanChecklist.ts";

function item(overrides) {
  return {
    channelId: "chan-1",
    sessionId: "sess-1",
    turnId: "turn-1",
    ...overrides,
  };
}

function turnBlock(segments) {
  return { kind: "turn", turnId: "turn-1", segments };
}

function itemSegment(id, overrides) {
  return {
    kind: "item",
    item: item({
      id,
      timestamp: "2026-06-14T19:00:02.000Z",
      ...overrides,
    }),
  };
}

const thoughtSegment = (id, timestamp) =>
  itemSegment(id, {
    type: "thought",
    renderClass: "thought",
    title: "Thinking",
    text: "…",
    timestamp,
  });

const messageSegment = (id, timestamp, role = "assistant") =>
  itemSegment(id, {
    type: "message",
    renderClass: "message",
    role,
    title: role === "user" ? "Ada" : "Agent",
    text: "done",
    timestamp,
  });

const toolSegment = (id, timestamp) =>
  itemSegment(id, {
    type: "tool",
    renderClass: "shell",
    title: "Ran a command",
    text: "",
    descriptor: { label: "Ran a command", preview: "cargo test" },
    timestamp,
  });

// ---- buildConversationTurnMeta ----

test("buildConversationTurnMeta returns the shared empty value for other variants", () => {
  for (const variant of ["default", "compactPreview"]) {
    assert.equal(
      buildConversationTurnMeta([turnBlock([])], {
        isTurnLive: true,
        variant,
      }),
      EMPTY_TRANSCRIPT_TURN_META,
      `${variant} must allocate nothing so its render output is untouched`,
    );
  }
});

test("buildConversationTurnMeta reports nothing streaming when the turn is idle", () => {
  // The hint exists to tell the work block it is still working. A finished turn
  // has no tail, and reporting one would pin the block open forever.
  assert.equal(
    buildConversationTurnMeta(
      [
        turnBlock([
          thoughtSegment("thought:1", "2026-06-14T19:00:02.000Z"),
          messageSegment("msg:1", "2026-06-14T19:00:14.000Z"),
        ]),
      ],
      { isTurnLive: false, variant: "conversation" },
    ),
    EMPTY_TRANSCRIPT_TURN_META,
  );
});

test("buildConversationTurnMeta names the trailing item of a live turn", () => {
  const blocks = [
    turnBlock([thoughtSegment("thought:tail", "2026-06-14T19:00:02.000Z")]),
  ];

  assert.equal(
    buildConversationTurnMeta(blocks, {
      isTurnLive: true,
      variant: "conversation",
    }).streamingItemId,
    "thought:tail",
    "a thought carries no status of its own, so the hint is how the block knows it is live",
  );
});

test("buildConversationTurnMeta skips setup segments when finding the tail", () => {
  // Setup renders as a quiet divider, not as work, so it must never be reported
  // as the streaming item — a lifecycle row would hold the block open.
  const meta = buildConversationTurnMeta(
    [
      turnBlock([
        thoughtSegment("thought:1", "2026-06-14T19:00:01.000Z"),
        {
          kind: "setup",
          items: [
            item({
              id: "life:1",
              type: "lifecycle",
              renderClass: "status",
              title: "Turn started",
              text: "",
              timestamp: "2026-06-14T19:00:00.000Z",
            }),
          ],
        },
      ]),
    ],
    { isTurnLive: true, variant: "conversation" },
  );

  assert.equal(meta.streamingItemId, "thought:1");
});

test("buildConversationTurnMeta counts a mid-turn steer prompt as the tail", () => {
  const meta = buildConversationTurnMeta(
    [
      turnBlock([
        thoughtSegment("thought:1", "2026-06-14T19:00:01.000Z"),
        messageSegment("msg:steer", "2026-06-14T19:00:04.000Z", "user"),
      ]),
    ],
    { isTurnLive: true, variant: "conversation" },
  );

  assert.equal(meta.streamingItemId, "msg:steer");
});

test("buildConversationTurnMeta expands a summary segment to reach its last tool", () => {
  // A summary segment holds several leaf items; the tail is the last of them,
  // not the summary itself, which has no item id the work block could match.
  const meta = buildConversationTurnMeta(
    [
      turnBlock([
        {
          kind: "summary",
          summary: {
            id: "summary:shell:tool:1",
            label: "Ran 2 commands",
            count: 2,
            items: [
              toolSegment("tool:1", "2026-06-14T19:00:04.000Z").item,
              toolSegment("tool:2", "2026-06-14T19:00:05.000Z").item,
            ],
            renderClass: "shell",
            variant: "same-kind",
            timestamp: "2026-06-14T19:00:04.000Z",
          },
        },
      ]),
    ],
    { isTurnLive: true, variant: "conversation" },
  );

  assert.equal(meta.streamingItemId, "tool:2");
});

test("buildConversationTurnMeta reads a trailing single block directly", () => {
  const meta = buildConversationTurnMeta(
    [
      turnBlock([thoughtSegment("thought:1", "2026-06-14T19:00:01.000Z")]),
      {
        kind: "single",
        item: item({
          id: "life:orphan",
          type: "lifecycle",
          renderClass: "status",
          title: "Context compacted",
          text: "",
          timestamp: "2026-06-14T19:00:20.000Z",
        }),
      },
    ],
    { isTurnLive: true, variant: "conversation" },
  );

  assert.equal(meta.streamingItemId, "life:orphan");
});

// ---- parsePlanChecklist ----

test("parsePlanChecklist reads the checkbox markdown the transcript builds", () => {
  const checklist = parsePlanChecklist(
    [
      "- [x] read the transcript",
      "- [ ] write the summary (in progress)",
      "- [ ] ship it",
    ].join("\n"),
  );

  assert.deepEqual(checklist.entries, [
    { label: "read the transcript", status: "completed" },
    { label: "write the summary", status: "in_progress" },
    { label: "ship it", status: "pending" },
  ]);
  assert.equal(checklist.completedCount, 1);
  assert.equal(formatPlanChecklistProgress(checklist), "1/3 complete");
});

test("parsePlanChecklist yields nothing for free-form plan text", () => {
  const checklist = parsePlanChecklist("We will read, then write, then ship.");
  assert.deepEqual(checklist.entries, []);
  assert.equal(formatPlanChecklistProgress(checklist), null);
});
