import assert from "node:assert/strict";
import test from "node:test";

import {
  parseWorkflowEditorPane,
  serializeWorkflowEditorPane,
} from "./workflowEditorPane.ts";

test("parses trigger and step panes", () => {
  assert.deepEqual(parseWorkflowEditorPane("trigger"), { type: "trigger" });
  assert.deepEqual(parseWorkflowEditorPane("step-0"), {
    type: "step",
    index: 0,
  });
  assert.deepEqual(parseWorkflowEditorPane("step-12"), {
    type: "step",
    index: 12,
  });
});

test("rejects malformed pane parameters", () => {
  for (const value of [undefined, null, "", "step", "step--1", "step-01"]) {
    assert.equal(parseWorkflowEditorPane(value), null);
  }
});

test("serializes panes for route search", () => {
  assert.equal(serializeWorkflowEditorPane({ type: "trigger" }), "trigger");
  assert.equal(
    serializeWorkflowEditorPane({ type: "step", index: 3 }),
    "step-3",
  );
  assert.equal(serializeWorkflowEditorPane(null), undefined);
});
