import assert from "node:assert/strict";
import test from "node:test";

import { formStateToYaml, yamlToFormState } from "./workflowFormTypes.ts";

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

test("presents saved delay durations nicely and serializes them for the backend", () => {
  const parsed = yamlToFormState(`name: delayed_workflow
trigger:
  on: message_posted
steps:
  - id: wait
    action: delay
    duration: 3602s
`);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.state.steps[0].duration, "1h 2s");
  assert.match(formStateToYaml(parsed.state), /duration: 3602s/);
});

test("presents UI timeouts nicely and serializes numeric seconds", () => {
  const parsed = yamlToFormState(`name: timeout_workflow
trigger:
  on: message_posted
steps:
  - id: notify
    action: send_message
    timeout_secs: 3602
    text: hello
  - id: approve
    action: request_approval
    from: manager
    message: Ship it?
    timeout: 2d
`);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.state.steps[0].timeoutSecs, "1h 2s");
  assert.equal(parsed.state.steps[1].timeout, "2d");

  const serialized = formStateToYaml(parsed.state);
  assert.match(serialized, /timeout_secs: 3602/);
  assert.match(serialized, /timeout: 172800s/);
});

test("clamps explicit zero delays and timeouts to the one-second UI minimum", () => {
  const parsed = yamlToFormState(`name: minimum_workflow
trigger:
  on: message_posted
steps:
  - id: wait
    action: delay
    timeout_secs: 0
    duration: 0s
`);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const serialized = formStateToYaml(parsed.state);
  assert.match(serialized, /timeout_secs: 1/);
  assert.match(serialized, /duration: 1s/);
});
