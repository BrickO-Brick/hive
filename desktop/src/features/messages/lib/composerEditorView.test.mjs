import assert from "node:assert/strict";
import test from "node:test";

import { getMountedEditorDom } from "./composerEditorView.ts";

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

test("returns null while the TipTap editor view is not mounted", () => {
  assert.equal(getMountedEditorDom(unmountedEditor()), null);
});

test("returns the editor DOM after the TipTap view mounts", () => {
  const dom = {};
  assert.equal(getMountedEditorDom({ view: { dom } }), dom);
});
