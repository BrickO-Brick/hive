import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

let nextAnimationFrameId = 0;
const animationFrames = new Map();

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
  dom.window.requestAnimationFrame = (callback) => {
    nextAnimationFrameId += 1;
    animationFrames.set(nextAnimationFrameId, callback);
    return nextAnimationFrameId;
  };
  dom.window.cancelAnimationFrame = (id) => animationFrames.delete(id);
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  animationFrames.clear();
  nextAnimationFrameId = 0;
});

function createEditorHarness() {
  const listeners = new Map();
  let editorDom;
  let viewReads = 0;
  const editor = {
    isEditable: true,
    isFocused: true,
    isInitialized: false,
    get view() {
      viewReads += 1;
      if (!editorDom) throw new Error("view is not mounted");
      return { dom: editorDom };
    },
    emit(event) {
      for (const handler of listeners.get(event) ?? []) handler();
    },
    create() {
      this.emit("create");
      this.isInitialized = true;
    },
    mount(domElement) {
      editorDom = domElement;
      this.emit("mount");
    },
    off(event, handler) {
      listeners.get(event)?.delete(handler);
    },
    on(event, handler) {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(handler);
      listeners.set(event, handlers);
    },
    unmount() {
      editorDom = undefined;
      this.isInitialized = false;
      this.emit("unmount");
    },
  };

  return {
    editor,
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
    viewReads: () => viewReads,
  };
}

test("binds editor DOM listeners only while the view is mounted", async () => {
  const harness = createEditorHarness();
  const firstDom = document.createElement("div");
  const secondDom = document.createElement("div");
  const { createElement, StrictMode } = await import("react");
  const { render } = await import("@testing-library/react");
  const { SelectionFormattingTray } = await import(
    "./SelectionFormattingTray.tsx"
  );

  // TipTap mounts EditorContent before this passive effect, then emits create and
  // marks isInitialized on a timer. The create listener must cover that gap.
  harness.editor.mount(firstDom);

  const result = render(
    createElement(
      StrictMode,
      null,
      createElement(SelectionFormattingTray, { editor: harness.editor }),
    ),
  );

  assert.equal(harness.viewReads(), 0, "must not access view before create");
  assert.equal(harness.listenerCount("create"), 1);
  assert.equal(harness.listenerCount("mount"), 1);
  assert.equal(harness.listenerCount("unmount"), 1);

  harness.editor.create();
  assert.equal(harness.viewReads(), 1);
  firstDom.dispatchEvent(new dom.window.Event("contextmenu"));
  firstDom.dispatchEvent(new dom.window.Event("keydown"));
  assert.equal(animationFrames.size, 1);

  harness.editor.unmount();
  assert.equal(animationFrames.size, 0, "unmount must cancel queued updates");
  assert.doesNotThrow(
    () => harness.editor.create(),
    "a delayed create from the unmounted view must be ignored",
  );
  assert.equal(
    harness.viewReads(),
    1,
    "delayed create must not read the unmounted view",
  );
  assert.doesNotThrow(() =>
    window.dispatchEvent(new dom.window.Event("resize")),
  );
  assert.equal(animationFrames.size, 1);
  const [[frameId, frame]] = animationFrames;
  animationFrames.delete(frameId);
  assert.doesNotThrow(() => frame(), "global updates must be safe unmounted");
  firstDom.dispatchEvent(new dom.window.Event("keydown"));
  assert.equal(
    animationFrames.size,
    0,
    "unmount must detach listeners from the old DOM",
  );

  harness.editor.mount(secondDom);
  assert.equal(harness.viewReads(), 2);
  secondDom.dispatchEvent(new dom.window.Event("contextmenu"));

  result.unmount();
  assert.equal(harness.listenerCount("create"), 0);
  assert.equal(harness.listenerCount("mount"), 0);
  assert.equal(harness.listenerCount("unmount"), 0);
  animationFrames.clear();
  secondDom.dispatchEvent(new dom.window.Event("keydown"));
  assert.equal(
    animationFrames.size,
    0,
    "React cleanup must detach listeners from the mounted view",
  );
});
