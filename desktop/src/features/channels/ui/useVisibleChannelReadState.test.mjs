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

async function renderReadState(initialProps) {
  const { renderHook } = await import("@testing-library/react");
  const { useVisibleChannelReadState } = await import(
    "./useVisibleChannelReadState.ts"
  );
  return renderHook((props) => useVisibleChannelReadState(props), {
    initialProps,
  });
}

test("live channel arrivals advance read state at bottom", async () => {
  const calls = [];
  const markChannelRead = (id, readAt) => calls.push([id, readAt]);
  const props = {
    channelId: "channel-1",
    isAtBottom: true,
    isMember: true,
    markChannelRead,
    readAt: 100,
  };
  const view = await renderReadState(props);
  calls.length = 0;

  view.rerender({ ...props, readAt: 120 });

  assert.deepEqual(calls, [["channel-1", "1970-01-01T00:02:00.000Z"]]);
});

test("scrolled-away channel arrivals remain unread until the reader returns to bottom", async () => {
  const calls = [];
  const markChannelRead = (id, readAt) => calls.push([id, readAt]);
  const props = {
    channelId: "channel-1",
    isAtBottom: false,
    isMember: true,
    markChannelRead,
    readAt: 100,
  };
  const view = await renderReadState(props);

  view.rerender({ ...props, readAt: 120 });
  assert.deepEqual(calls, []);

  view.rerender({
    ...props,
    isAtBottom: true,
    readAt: 120,
  });
  assert.deepEqual(calls, [["channel-1", "1970-01-01T00:02:00.000Z"]]);
});
