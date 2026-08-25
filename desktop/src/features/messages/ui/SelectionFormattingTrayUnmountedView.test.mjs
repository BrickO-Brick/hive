/**
 * Regression guard for the "[tiptap error]: The editor view is not available"
 * crash that made clicking into a channel appear to do nothing.
 *
 * Tiptap v3 (`@tiptap/core` 3.x) does not return `undefined` from
 * `editor.view` before the ProseMirror view is mounted — it returns a Proxy
 * whose `get` trap *throws* for any key it does not carry, including `dom`:
 *
 *   throw new Error(`[tiptap error]: The editor view is not available.
 *                    Cannot access view['dom']. The editor may not be mounted yet.`)
 *
 * `SelectionFormattingTray` subscribes to composer DOM events in a
 * `React.useEffect`, which runs on the same commit that mounts
 * `EditorContent`. On a freshly mounted composer the view can still be absent,
 * so an unguarded `editor.view.dom` throws out of the effect and React tears
 * down the surrounding subtree — the channel pane never appears.
 *
 * These tests use a fake editor whose `view` getter reproduces the throwing
 * Proxy, then flips to a real DOM node on a later frame, mirroring the real
 * mount sequence.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

// jsdom does not implement rAF. Back it with a real macrotask queue so the
// component's retry loop and the tests' frame waits use the same clock.
const rafCallbacks = new Map();
let nextRafHandle = 1;

before(() => {
  dom.window.requestAnimationFrame = (cb) => {
    const handle = nextRafHandle++;
    rafCallbacks.set(
      handle,
      setTimeout(() => {
        rafCallbacks.delete(handle);
        cb(Date.now());
      }, 0),
    );
    return handle;
  };
  dom.window.cancelAnimationFrame = (handle) => {
    const timer = rafCallbacks.get(handle);
    if (timer !== undefined) clearTimeout(timer);
    rafCallbacks.delete(handle);
  };

  Object.assign(globalThis, {
    cancelAnimationFrame: dom.window.cancelAnimationFrame,
    requestAnimationFrame: dom.window.requestAnimationFrame,
    CustomEvent: dom.window.CustomEvent,
    document: dom.window.document,
    DOMRect: dom.window.DOMRect,
    Element: dom.window.Element,
    Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: dom.window.Node,
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
    window: dom.window,
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

/**
 * Build a fake Tiptap editor whose `view` throws exactly like the real
 * unmounted-view Proxy until `mount()` is called.
 */
function createFakeEditor() {
  const listeners = new Map();
  let mountedDom = null;

  // A real Tiptap `Editor` exposes `view` as a *prototype* getter, so React's
  // dev-mode effect logging (which enumerates own enumerable properties) never
  // touches it. Defining it on a prototype here keeps the fake faithful; an own
  // getter would throw during React's introspection rather than in the effect
  // under test.
  const proto = {};
  Object.defineProperty(proto, "view", {
    get() {
      if (mountedDom) {
        return {
          coordsAtPos: () => ({ bottom: 10, left: 0, right: 5, top: 0 }),
          dom: mountedDom,
          domAtPos: () => ({ node: mountedDom, offset: 0 }),
        };
      }
      // Mirror `@tiptap/core`'s `get view()`: a Proxy over a small target that
      // throws only for keys absent from it — so `dom` throws, but the keys
      // Tiptap itself provides behave normally.
      const target = {
        composing: false,
        dispatch: () => {},
        dragging: null,
        editable: true,
        isDestroyed: false,
        state: { selection: { from: 0, to: 0 } },
        updateState: () => {},
      };
      return new Proxy(target, {
        get(obj, key) {
          if (key in obj) return Reflect.get(obj, key);
          throw new Error(
            `[tiptap error]: The editor view is not available. Cannot access view['${String(key)}']. The editor may not be mounted yet.`,
          );
        },
      });
    },
  });

  const editor = Object.assign(Object.create(proto), {
    isEditable: true,
    isFocused: false,
    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    state: { selection: { from: 0, to: 0 } },
  });

  return {
    editor,
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
    mount() {
      mountedDom = dom.window.document.createElement("div");
      dom.window.document.body.append(mountedDom);
    },
  };
}

test("tray mounts without throwing when the editor view is not yet available", async () => {
  const React = await import("react");
  const { act, render } = await import("@testing-library/react");
  const { SelectionFormattingTray } = await import(
    "./SelectionFormattingTray.tsx"
  );

  const fake = createFakeEditor();

  // Before the fix this render threw the tiptap error out of the effect.
  let thrown;
  try {
    await act(async () => {
      render(
        React.createElement(SelectionFormattingTray, { editor: fake.editor }),
      );
    });
  } catch (error) {
    thrown = error;
  }
  assert.equal(
    thrown,
    undefined,
    `mounting with an unmounted view must not throw: ${thrown?.message}`,
  );
});

test("tray subscribes to editor events once the view becomes available", async () => {
  const React = await import("react");
  const { act, render } = await import("@testing-library/react");
  const { SelectionFormattingTray } = await import(
    "./SelectionFormattingTray.tsx"
  );

  const fake = createFakeEditor();

  await act(async () => {
    render(
      React.createElement(SelectionFormattingTray, { editor: fake.editor }),
    );
  });

  // The view was absent on mount, so no subscription can exist yet.
  assert.equal(fake.listenerCount("selectionUpdate"), 0);

  // The ProseMirror view mounts on a later frame; the retry must pick it up.
  fake.mount();
  await act(async () => {
    await new Promise((resolve) => dom.window.requestAnimationFrame(resolve));
    await new Promise((resolve) => dom.window.requestAnimationFrame(resolve));
  });

  assert.equal(
    fake.listenerCount("selectionUpdate"),
    1,
    "tray must attach its selection listener once the view exists",
  );
});

test("tray detaches its editor listeners on unmount", async () => {
  const React = await import("react");
  const { act, render } = await import("@testing-library/react");
  const { SelectionFormattingTray } = await import(
    "./SelectionFormattingTray.tsx"
  );

  const fake = createFakeEditor();
  fake.mount();

  let unmount;
  await act(async () => {
    ({ unmount } = render(
      React.createElement(SelectionFormattingTray, { editor: fake.editor }),
    ));
  });

  assert.equal(fake.listenerCount("selectionUpdate"), 1);

  await act(async () => {
    unmount();
  });

  assert.equal(
    fake.listenerCount("selectionUpdate"),
    0,
    "unmount must remove every editor subscription",
  );
});
