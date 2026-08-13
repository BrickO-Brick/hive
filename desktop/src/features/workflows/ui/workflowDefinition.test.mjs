import assert from "node:assert/strict";
import test from "node:test";

import { getWorkflowCardLabel } from "./workflowDefinition.ts";

test("builds a plain-language workflow card label", () => {
  assert.equal(
    getWorkflowCardLabel({
      trigger: { on: "message_posted" },
      steps: [{ action: "send_message" }],
    }),
    "When a message is posted, send a channel message",
  );

  assert.equal(
    getWorkflowCardLabel({
      trigger: { on: "reaction_added", emoji: "🔥" },
      steps: [
        { action: "delay", duration: "5m" },
        { action: "add_reaction", emoji: "✅" },
      ],
    }),
    "When someone reacts with 🔥, wait 5m, then 1 more step",
  );
});

test("summarizes common and custom schedules", () => {
  assert.equal(
    getWorkflowCardLabel({
      trigger: { on: "schedule", interval: "15m" },
      steps: [{ action: "call_webhook" }],
    }),
    "Every 15 minutes, call a webhook",
  );
  assert.equal(
    getWorkflowCardLabel({
      trigger: { on: "schedule", cron: "30 9 * * *" },
      steps: [{ action: "request_approval" }],
    }),
    "Every day at 09:30 UTC, request approval",
  );
  assert.equal(
    getWorkflowCardLabel({
      trigger: { on: "schedule", cron: "*/5 8-17 * * 1-5" },
      steps: [],
    }),
    "On a custom schedule",
  );
});

test("gracefully labels definitions with future trigger and action types", () => {
  assert.equal(
    getWorkflowCardLabel({
      trigger: { on: "issue_closed" },
      steps: [{ action: "archive_issue" }],
    }),
    "When issue closed happens, archive issue",
  );
  assert.equal(getWorkflowCardLabel({}), "When this workflow starts");
});
