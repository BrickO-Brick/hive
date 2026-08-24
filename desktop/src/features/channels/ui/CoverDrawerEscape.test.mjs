import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, {
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    cancelAnimationFrame: dom.window.cancelAnimationFrame,
    document: dom.window.document,
    requestAnimationFrame: dom.window.requestAnimationFrame,
    window: dom.window,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
    writable: true,
  });
  dom.window.matchMedia ??= () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

/**
 * Renders a drawer holding one focusable child, which stands in for the thread
 * composer that owns Escape while an edit is in progress.
 */
async function renderDrawer({ escapeYieldsToContent }) {
  const React = await import("react");
  const { render } = await import("@testing-library/react");
  const { CoverDrawer } = await import("./CoverDrawer.tsx");

  const closes = [];
  const view = render(
    React.createElement(
      CoverDrawer,
      {
        ariaLabel: "Thread",
        escapeYieldsToContent,
        onClose: () => closes.push("close"),
        scrimLabel: "Back to #general",
        testId: "cover-drawer",
      },
      React.createElement("input", { "data-testid": "thread-composer" }),
    ),
  );

  return { closes, view };
}

function pressEscapeOn(element) {
  element.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    }),
  );
}

function composer() {
  return dom.window.document.querySelector('[data-testid="thread-composer"]');
}

test("Escape inside the drawer yields to content while it owns the key", async () => {
  // The regression this guards (#6575): the drawer claims Escape in the capture
  // phase, which runs before the composer's own handler. Without the yield, one
  // press dismisses the entire drawer instead of cancelling the in-progress
  // edit, and the unsaved draft goes with it.
  const { closes } = await renderDrawer({ escapeYieldsToContent: true });

  pressEscapeOn(composer());

  assert.deepEqual(closes, []);
});

test("Escape inside the drawer closes it when content does not own the key", async () => {
  // The default: with no active edit the same press is a dismissal, so the yield
  // above must be conditional rather than a blanket exemption for the subtree.
  const { closes } = await renderDrawer({ escapeYieldsToContent: false });

  pressEscapeOn(composer());

  assert.deepEqual(closes, ["close"]);
});

test("Escape from outside the drawer closes it even while content owns the key", async () => {
  // The yield is scoped to the drawer's own subtree, so an active edit inside
  // cannot wedge the drawer open against a press from the channel behind it.
  const { closes } = await renderDrawer({ escapeYieldsToContent: true });

  pressEscapeOn(dom.window.document.body);

  assert.deepEqual(closes, ["close"]);
});
