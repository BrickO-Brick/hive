import assert from "node:assert/strict";
import test from "node:test";

import {
  getEditorLinkRect,
  getEditorSelectionRect,
} from "./composerEditorGeometry.ts";

function unmountedEditor() {
  return {
    get view() {
      return new Proxy(
        {},
        {
          get(_target, key) {
            throw new Error(`editor view cannot access ${String(key)}`);
          },
        },
      );
    },
  };
}

test("selection geometry returns null instead of throwing after view teardown", () => {
  assert.equal(getEditorSelectionRect(unmountedEditor(), 1, 2), null);
});

test("link geometry returns null instead of throwing after view teardown", () => {
  assert.equal(getEditorLinkRect(unmountedEditor(), 1, 2), null);
});
