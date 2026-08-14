import assert from "node:assert/strict";
import test from "node:test";

import { workflowTriggerDescription } from "./workflowTriggerDescription.ts";

test("describes selected trigger conditions on the workflow canvas", () => {
  assert.equal(
    workflowTriggerDescription(
      {
        on: "message_posted",
        filter: `trigger_author == "${"a".repeat(64)}"`,
      },
      { authorLabel: "Carl" },
    ),
    "Message posted by Carl",
  );

  assert.equal(
    workflowTriggerDescription({
      on: "message_posted",
      filter: 'str_contains(trigger_text, "deploy")',
    }),
    "Message posted containing “deploy”",
  );

  assert.equal(
    workflowTriggerDescription({
      on: "message_posted",
      filter: 'trigger_text == "deploy"',
    }),
    "Message posted is “deploy”",
  );

  assert.equal(
    workflowTriggerDescription({
      on: "message_posted",
      filter: 'trigger_text != "deploy"',
    }),
    "Message posted is not “deploy”",
  );

  assert.equal(
    workflowTriggerDescription({
      on: "message_posted",
      filter: "str_len(trigger_text) == 0",
    }),
    "Message posted without text",
  );

  assert.equal(
    workflowTriggerDescription({
      on: "message_posted",
      filter: "str_len(trigger_text) > 0",
    }),
    "Text message posted",
  );

  assert.equal(
    workflowTriggerDescription({
      on: "reaction_added",
      filter: 'trigger_emoji == "🔥"',
    }),
    "Reaction added",
  );

  assert.equal(
    workflowTriggerDescription(
      {
        on: "reaction_added",
        filter: `trigger_message_id == "${"b".repeat(64)}"`,
      },
      { messageLoading: true },
    ),
    "Reaction added to loading message",
  );

  assert.equal(
    workflowTriggerDescription(
      {
        on: "reaction_added",
        filter: `trigger_emoji == "👾" && trigger_author == "${"a".repeat(64)}" && trigger_message_id == "${"b".repeat(64)}"`,
      },
      { authorLabel: "Carl", messageLabel: "hey yourself" },
    ),
    "Reaction added by Carl to “hey yourself”",
  );
});

test("keeps the base label for unfiltered and custom triggers", () => {
  assert.equal(
    workflowTriggerDescription({ on: "message_posted" }),
    "Message posted",
  );
  assert.equal(
    workflowTriggerDescription({
      on: "message_posted",
      filter: "custom_variable == 1",
    }),
    "Message posted",
  );
});
