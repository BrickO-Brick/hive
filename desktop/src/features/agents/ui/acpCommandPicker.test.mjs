import assert from "node:assert/strict";
import test from "node:test";

import {
  CUSTOM_ACP_COMMAND_VALUE,
  acpCommandPickerState,
  acpCommandSelectionToValue,
} from "./acpCommandPicker.ts";

const candidate = {
  command: "buzz-janet-acp",
  binaryPath: "/bin/buzz-janet-acp",
};

test("stock and discovered commands select presets", () => {
  assert.equal(
    acpCommandPickerState("buzz-acp", [candidate]).selectValue,
    "buzz-acp",
  );
  assert.equal(
    acpCommandPickerState("buzz-janet-acp", [candidate]).selectValue,
    "buzz-janet-acp",
  );
});

test("arbitrary commands remain custom before discovery and on query failure", () => {
  const state = acpCommandPickerState("my-acp", []);
  assert.equal(state.isPreset, false);
  assert.equal(state.selectValue, CUSTOM_ACP_COMMAND_VALUE);
});

test("late candidate arrival promotes the matching command without changing it", () => {
  assert.equal(acpCommandPickerState("buzz-janet-acp", []).isPreset, false);
  assert.equal(
    acpCommandPickerState("buzz-janet-acp", [candidate]).isPreset,
    true,
  );
});

test("a custom command equal to the UI sentinel remains editable custom state", () => {
  const state = acpCommandPickerState(CUSTOM_ACP_COMMAND_VALUE, [candidate]);
  assert.equal(state.isPreset, false);
  assert.equal(state.selectValue, CUSTOM_ACP_COMMAND_VALUE);
});

test("choosing Custom clears a preset but preserves an existing custom command", () => {
  assert.equal(
    acpCommandSelectionToValue({
      currentCommand: "buzz-janet-acp",
      isPreset: true,
      selection: CUSTOM_ACP_COMMAND_VALUE,
    }),
    "",
  );
  assert.equal(
    acpCommandSelectionToValue({
      currentCommand: "my-acp",
      isPreset: false,
      selection: CUSTOM_ACP_COMMAND_VALUE,
    }),
    "my-acp",
  );
});

test("choosing a concrete command persists it", () => {
  assert.equal(
    acpCommandSelectionToValue({
      currentCommand: "my-acp",
      isPreset: false,
      selection: "buzz-acp",
    }),
    "buzz-acp",
  );
});
