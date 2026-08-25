import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: dom.window.Node,
    window: dom.window,
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

test("does not read the TipTap view while the editor is unmounted", async () => {
  const React = await import("react");
  const { render } = await import("@testing-library/react");
  const { SelectionFormattingTray } = await import(
    "./SelectionFormattingTray.tsx"
  );
  let viewReads = 0;
  const unmountedEditor = {
    get isDestroyed() {
      return true;
    },
    get view() {
      viewReads += 1;
      throw new Error("TipTap view is not mounted");
    },
  };

  render(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(SelectionFormattingTray, {
        editor: unmountedEditor,
      }),
    ),
  );

  assert.equal(viewReads, 0);
});
