import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConversationTurnMeta,
  formatThoughtDisclosureLabel,
} from "./agentSessionConversationMeta.ts";
import { EMPTY_TRANSCRIPT_TURN_META } from "./agentSessionTranscriptContext.ts";
import {
  formatPlanChecklistProgress,
  parsePlanChecklist,
} from "./agentSessionPlanChecklist.ts";
import { resolveAgentSessionTranscriptVariant } from "./agentSessionTranscriptVariantChoice.ts";

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

test("buildConversationTurnMeta times a thought against the turn's next item", () => {
  const meta = buildConversationTurnMeta(
    [
      turnBlock([
        {
          kind: "item",
          item: item({
            id: "thought:1",
            type: "thought",
            renderClass: "thought",
            title: "Thinking",
            text: "…",
            timestamp: "2026-06-14T19:00:02.000Z",
          }),
        },
        {
          kind: "item",
          item: item({
            id: "msg:1",
            type: "message",
            renderClass: "message",
            role: "assistant",
            title: "Agent",
            text: "done",
            timestamp: "2026-06-14T19:00:14.000Z",
          }),
        },
      ]),
    ],
    { isTurnLive: false, variant: "conversation" },
  );

  assert.deepEqual(meta.thoughtDurationSecondsById, { "thought:1": 12 });
  assert.equal(meta.streamingItemId, null);
});

test("buildConversationTurnMeta leaves a trailing thought untimed and marks it streaming when live", () => {
  const blocks = [
    turnBlock([
      {
        kind: "item",
        item: item({
          id: "thought:tail",
          type: "thought",
          renderClass: "thought",
          title: "Thinking",
          text: "…",
          timestamp: "2026-06-14T19:00:02.000Z",
        }),
      },
    ]),
  ];

  const live = buildConversationTurnMeta(blocks, {
    isTurnLive: true,
    variant: "conversation",
  });
  assert.deepEqual(live.thoughtDurationSecondsById, {});
  assert.equal(live.streamingItemId, "thought:tail");

  const idle = buildConversationTurnMeta(blocks, {
    isTurnLive: false,
    variant: "conversation",
  });
  assert.equal(idle.streamingItemId, null);
});

test("buildConversationTurnMeta counts a prompt as an item and skips setup segments", () => {
  const meta = buildConversationTurnMeta(
    [
      turnBlock([
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
        {
          kind: "item",
          item: item({
            id: "thought:1",
            type: "thought",
            renderClass: "thought",
            title: "Thinking",
            text: "…",
            timestamp: "2026-06-14T19:00:01.000Z",
          }),
        },
        {
          kind: "prompt",
          context: null,
          setup: [],
          user: item({
            id: "msg:steer",
            type: "message",
            renderClass: "message",
            role: "user",
            title: "Ada",
            text: "actually…",
            timestamp: "2026-06-14T19:00:04.000Z",
          }),
        },
      ]),
    ],
    { isTurnLive: true, variant: "conversation" },
  );

  // Setup contributes nothing, so the thought is timed against the steer prompt.
  assert.deepEqual(meta.thoughtDurationSecondsById, { "thought:1": 3 });
  assert.equal(meta.streamingItemId, "msg:steer");
});

// ---- formatThoughtDisclosureLabel ----

test("formatThoughtDisclosureLabel says Thinking while streaming", () => {
  assert.equal(
    formatThoughtDisclosureLabel({ durationSeconds: 4, isStreaming: true }),
    "Thinking…",
  );
});

test("formatThoughtDisclosureLabel reports a duration once the turn moved on", () => {
  assert.equal(
    formatThoughtDisclosureLabel({ durationSeconds: 9, isStreaming: false }),
    "Thought for 9s",
  );
});

test("formatThoughtDisclosureLabel avoids a misleading 0s", () => {
  assert.equal(
    formatThoughtDisclosureLabel({ durationSeconds: 0, isStreaming: false }),
    "Thought for a moment",
  );
  assert.equal(formatThoughtDisclosureLabel({ isStreaming: false }), "Thought");
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

// ---- resolveAgentSessionTranscriptVariant ----

test("resolveAgentSessionTranscriptVariant opts a wide panel into conversation", () => {
  assert.equal(
    resolveAgentSessionTranscriptVariant({
      isSinglePanelView: false,
      widthPx: 720,
    }),
    "conversation",
  );
});

test("resolveAgentSessionTranscriptVariant keeps narrow and single-panel layouts on default", () => {
  assert.equal(
    resolveAgentSessionTranscriptVariant({
      isSinglePanelView: false,
      widthPx: 380,
    }),
    "default",
  );
  assert.equal(
    resolveAgentSessionTranscriptVariant({
      isSinglePanelView: true,
      widthPx: 1200,
    }),
    "default",
  );
});
