import assert from "node:assert/strict";
import test from "node:test";

import {
  getEditorLinkRect,
  getEditorSelectionRect,
} from "./composerEditorGeometry.ts";

function unmountedEditor(keysTouched) {
  return {
    get view() {
      return new Proxy(
        {},
        {
          get(_target, key) {
            keysTouched.push(key);
            throw new Error(`editor view cannot access ${String(key)}`);
          },
        },
      );
    },
  };
}

function withRangeStub(callback) {
  const previousDocument = globalThis.document;
  globalThis.document = { createRange: () => ({}) };
  try {
    callback();
  } finally {
    globalThis.document = previousDocument;
  }
}

test("selection geometry reaches the unmounted view and returns null", () => {
  withRangeStub(() => {
    const keysTouched = [];
    assert.equal(
      getEditorSelectionRect(unmountedEditor(keysTouched), 1, 2),
      null,
    );
    assert.deepEqual(keysTouched, ["domAtPos", "coordsAtPos"]);
  });
});

test("link geometry reaches the unmounted view and returns null", () => {
  withRangeStub(() => {
    const keysTouched = [];
    assert.equal(getEditorLinkRect(unmountedEditor(keysTouched), 1, 2), null);
    assert.deepEqual(keysTouched, ["domAtPos", "coordsAtPos"]);
  });
});

function mountedEditorWithCaretGeometry() {
  const coords = new Map([
    [1, { left: 10, right: 11, top: 20, bottom: 32 }],
    [2, { left: 30, right: 31, top: 20, bottom: 32 }],
  ]);
  return {
    view: {
      domAtPos() {
        return { node: {}, offset: 99 };
      },
      coordsAtPos(pos) {
        return coords.get(pos);
      },
    },
  };
}

function withThrowingRange(callback) {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createRange() {
      throw new DOMException("stale DOM offset", "IndexSizeError");
    },
  };
  try {
    callback();
  } finally {
    globalThis.document = previousDocument;
  }
}

test("selection geometry keeps the caret fallback when Range construction fails", () => {
  withThrowingRange(() => {
    assert.deepEqual(
      getEditorSelectionRect(mountedEditorWithCaretGeometry(), 1, 2),
      {
        left: 10,
        top: 20,
        width: 21,
        height: 12,
        right: 31,
        bottom: 32,
      },
    );
  });
});

test("link geometry keeps the caret fallback when Range construction fails", () => {
  withThrowingRange(() => {
    assert.deepEqual(
      getEditorLinkRect(mountedEditorWithCaretGeometry(), 1, 2),
      {
        left: 10,
        top: 20,
        width: 1,
        height: 12,
        right: 11,
        bottom: 32,
      },
    );
  });
});
