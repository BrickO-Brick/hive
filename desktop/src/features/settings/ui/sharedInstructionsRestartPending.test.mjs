import assert from "node:assert/strict";
import test from "node:test";

const values = new Map();
globalThis.window = {
  sessionStorage: {
    getItem(key) {
      return values.get(key) ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  },
};

const {
  clearSharedInstructionsRestartPending,
  isSharedInstructionsRestartPending,
  recordSharedInstructionsToggle,
} = await import("./sharedInstructionsRestartPending.ts");

test.beforeEach(() => values.clear());

test("pending state survives remount until restart", () => {
  assert.equal(recordSharedInstructionsToggle(true), true);
  assert.equal(isSharedInstructionsRestartPending(true), true);

  clearSharedInstructionsRestartPending();
  assert.equal(isSharedInstructionsRestartPending(true), false);
});

test("toggling back to the running value clears pending state", () => {
  assert.equal(recordSharedInstructionsToggle(true), true);
  assert.equal(recordSharedInstructionsToggle(false), false);
  assert.equal(isSharedInstructionsRestartPending(false), false);
});
