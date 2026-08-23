import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

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
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

function entry(id, createdAt) {
  return {
    index: 0,
    message: { id, createdAt },
    summary: null,
  };
}

async function renderReadState(initialProps) {
  const { renderHook } = await import("@testing-library/react");
  const { useVisibleThreadReadState } = await import(
    "./useVisibleThreadReadState.ts"
  );
  return renderHook((props) => useVisibleThreadReadState(props), {
    initialProps,
  });
}

test("live thread arrivals advance read state at bottom", async () => {
  const calls = [];
  const markMessageRead = (id, timestamp) => calls.push([id, timestamp]);
  const view = await renderReadState({
    isAtBottom: true,
    isMuted: false,
    markMessageRead,
    messages: [entry("reply-1", 100)],
    threadRootId: "root-1",
  });
  calls.length = 0;

  view.rerender({
    isAtBottom: true,
    isMuted: false,
    markMessageRead,
    messages: [entry("reply-1", 100), entry("reply-2", 120)],
    threadRootId: "root-1",
  });

  assert.deepEqual(calls, [
    ["reply-1", 100],
    ["reply-2", 120],
  ]);
});

test("scrolled-away thread arrivals remain unread until the reader returns to bottom", async () => {
  const calls = [];
  const markMessageRead = (id, timestamp) => calls.push([id, timestamp]);
  const props = {
    isAtBottom: false,
    isMuted: false,
    markMessageRead,
    messages: [entry("reply-1", 100)],
    threadRootId: "root-1",
  };
  const view = await renderReadState(props);

  view.rerender({
    ...props,
    messages: [entry("reply-1", 100), entry("reply-2", 120)],
  });
  assert.deepEqual(calls, []);

  view.rerender({
    ...props,
    isAtBottom: true,
    messages: [entry("reply-1", 100), entry("reply-2", 120)],
  });
  assert.deepEqual(calls, [
    ["reply-1", 100],
    ["reply-2", 120],
  ]);
});
