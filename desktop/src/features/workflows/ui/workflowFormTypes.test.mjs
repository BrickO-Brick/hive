import assert from "node:assert/strict";
import test from "node:test";

import { yamlToFormState } from "./workflowFormTypes.ts";

test("keeps workflows with step conditions in the YAML editor", () => {
  const result = yamlToFormState(`name: conditional_step
trigger:
  on: message_posted
steps:
  - id: notify
    action: send_message
    if: trigger_author == "abc"
    text: hello
`);

  assert.deepEqual(result, {
    ok: false,
    error: "Step conditions are only available in the YAML editor",
  });
});
