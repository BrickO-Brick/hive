import assert from "node:assert/strict";
import test from "node:test";

import {
  focusMountedEditorView,
  getMountedEditorDom,
} from "./composerEditorView.ts";

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

test("focus is synchronous while the TipTap view is mounted", () => {
  const calls = [];
  const editor = {
    commands: {
      focus() {
        calls.push("commands.focus");
      },
    },
    view: {
      focus() {
        calls.push("view.focus");
      },
    },
  };

  focusMountedEditorView(editor);
  calls.push("after focus");

  assert.deepEqual(calls, ["view.focus", "after focus"]);
});

test("focus does not throw while the TipTap view is unmounted", () => {
  assert.doesNotThrow(() => focusMountedEditorView(unmountedEditor()));
});
