/**
 * Rendering contract for the `conversation` transcript variant (focus mode).
 *
 * Mounts the shipping AgentSessionTranscriptList so the variant plumbing
 * (variant context + derived turn meta) is exercised end to end rather than
 * asserting against re-implemented render classes.
 *
 * The last test is the important one: `conversation` is purely additive, so the
 * `default` and `compactPreview` markup for the same transcript must be
 * byte-identical to the markup captured before the variant existed. That
 * snapshot lives in AgentSessionTranscriptList.conversation.baseline.json and
 * was produced by mounting this same transcript on the pre-change commit
 * (f79421673) — regenerate it only when a deliberate change to the other
 * variants is being made.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const BASELINE_MARKUP = JSON.parse(
  readFileSync(
    new URL(
      "./AgentSessionTranscriptList.conversation.baseline.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

class NoopObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

Object.assign(globalThis, {
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  IntersectionObserver: NoopObserver,
  MutationObserver: dom.window.MutationObserver,
  ResizeObserver: NoopObserver,
  document: dom.window.document,
  getComputedStyle: (...args) => dom.window.getComputedStyle(...args),
  localStorage: dom.window.localStorage,
  self: dom.window,
  window: dom.window,
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
  writable: true,
});
dom.window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});
dom.window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame;
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame;

let cleanup;
let render;
let createElement;
let createMemoryHistory;
let createRootRoute;
let createRouter;
let RouterProvider;
let AgentSessionTranscriptList;
let resetActiveAgentTurnsStore;
let syncAgentTurnsFromEvents;

const AGENT = {
  agentAvatarUrl: null,
  agentName: "Test Agent",
  agentPubkey: "f".repeat(64),
};
const AUTHOR = "a".repeat(64);

function items() {
  const shared = { channelId: "chan-1", sessionId: "sess-1", turnId: "turn-1" };
  return [
    {
      ...shared,
      id: "msg:user",
      type: "message",
      renderClass: "message",
      role: "user",
      title: "Ada",
      text: "please summarize the plan",
      timestamp: "2026-06-14T19:00:00.000Z",
      messageId: "event-1",
      authorPubkey: AUTHOR,
    },
    {
      ...shared,
      id: "thought:1",
      type: "thought",
      renderClass: "thought",
      title: "Thinking",
      text: "weighing the options",
      timestamp: "2026-06-14T19:00:02.000Z",
    },
    {
      ...shared,
      id: "plan:1",
      type: "plan",
      renderClass: "plan",
      title: "Plan",
      text: "- [x] read the transcript\n- [ ] write the summary (in progress)\n- [ ] ship it",
      timestamp: "2026-06-14T19:00:07.000Z",
    },
    {
      ...shared,
      id: "msg:assistant",
      type: "message",
      renderClass: "message",
      role: "assistant",
      title: "Test Agent",
      text: "Here is the summary with `code`.",
      timestamp: "2026-06-14T19:00:09.000Z",
    },
  ];
}

async function renderTranscript(variant, overrides = {}) {
  const rootRoute = createRootRoute({
    component: () =>
      createElement(AgentSessionTranscriptList, {
        ...AGENT,
        emptyDescription: "nothing yet",
        items: items(),
        variant,
        ...overrides,
      }),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute,
  });
  await router.load();
  return render(createElement(RouterProvider, { router }));
}

before(async () => {
  ({ cleanup, render } = await import("@testing-library/react"));
  ({ createElement } = await import("react"));
  ({ createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
    await import("@tanstack/react-router"));
  ({ AgentSessionTranscriptList } = await import(
    "./AgentSessionTranscriptList.tsx"
  ));
  ({ resetActiveAgentTurnsStore, syncAgentTurnsFromEvents } = await import(
    "../activeAgentTurnsStore.ts"
  ));
});

afterEach(() => {
  cleanup?.();
  resetActiveAgentTurnsStore?.();
});
after(() => dom.window.close());

test("conversation marks the transcript container and centers a reading column", async () => {
  const { container } = await renderTranscript("conversation");
  const log = container.querySelector("[data-transcript-variant]");
  assert.ok(log, "conversation should tag its container for variant styling");
  assert.equal(log.getAttribute("data-transcript-variant"), "conversation");
  assert.match(log.className, /max-w-3xl/);
  assert.match(log.className, /gap-8/);
});

test("conversation renders the prompt as a filled right-aligned bubble with an author label", async () => {
  const { container } = await renderTranscript("conversation");
  const author = container.querySelector(
    '[data-testid="transcript-user-message-author"]',
  );
  assert.ok(author, "conversation should label the prompt author");
  assert.equal(author.textContent, "Ada");

  const row = container.querySelector(
    '[data-testid="transcript-user-message"]',
  );
  assert.match(row.className, /justify-end/);
  const bubble = row.querySelector(".rounded-2xl");
  assert.match(bubble.className, /bg-muted\/60/);
  // Focus mode shows the whole prompt rather than clamping it.
  assert.doesNotMatch(bubble.className, /max-h-36/);
});

test("conversation renders agent messages as unboxed prose at full fidelity", async () => {
  const { container } = await renderTranscript("conversation");
  const message = container.querySelector(
    '[data-testid="transcript-assistant-message"]',
  );
  assert.ok(message, "assistant message should render");
  assert.doesNotMatch(message.innerHTML, /rounded-2xl/);
  // The shared markdown renderer is reused, so inline code still renders as code.
  assert.ok(message.querySelector("code"), "markdown/code fidelity preserved");
});

test("conversation collapses a finished thought into a Thought for Ns disclosure", async () => {
  const { container } = await renderTranscript("conversation");
  const disclosure = container.querySelector(
    '[data-testid="transcript-thought-item"]',
  );
  assert.ok(disclosure, "thought should render");
  assert.equal(disclosure.tagName, "DETAILS");
  assert.equal(disclosure.open, false, "finished thoughts start collapsed");
  // thought at :02, next turn item (plan) at :07 → 5s.
  assert.equal(
    disclosure
      .querySelector('[data-testid="transcript-thought-disclosure"]')
      .textContent.trim(),
    "Thought for 5s",
  );
});

test("conversation auto-opens the thought disclosure while it is streaming", async () => {
  // A live turn on this channel makes the trailing item the streaming one, which
  // is exactly the condition the disclosure auto-opens for.
  syncAgentTurnsFromEvents(AGENT.agentPubkey, [
    {
      seq: 1,
      timestamp: "2026-06-14T19:00:02.000Z",
      kind: "turn_started",
      agentIndex: 0,
      channelId: "chan-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      payload: null,
    },
  ]);
  const streamingThought = items().slice(0, 2);
  const { container } = await renderTranscript("conversation", {
    channelId: "chan-1",
    items: streamingThought,
  });

  const disclosure = container.querySelector(
    '[data-testid="transcript-thought-item"]',
  );
  assert.equal(disclosure.open, true, "streaming thought should be open");
  const summary = disclosure.querySelector(
    '[data-testid="transcript-thought-disclosure"]',
  );
  // Shimmer paints a visual-only aria-hidden duplicate of the label, so match a
  // prefix rather than the whole text node.
  assert.match(summary.textContent, /^Thinking…/);
  assert.doesNotMatch(summary.textContent, /Thought for/);
});

test("conversation renders the plan as a checklist card with in-place progress", async () => {
  const { container } = await renderTranscript("conversation");
  const card = container.querySelector('[data-testid="transcript-plan-item"]');
  assert.ok(card, "plan should render");
  assert.equal(card.getAttribute("data-variant"), "conversation-plan-card");
  assert.equal(
    card.querySelector('[data-testid="transcript-plan-progress"]').textContent,
    "1/3 complete",
  );
  const statuses = [...card.querySelectorAll("[data-plan-entry-status]")].map(
    (entry) => entry.getAttribute("data-plan-entry-status"),
  );
  assert.deepEqual(statuses, ["completed", "in_progress", "pending"]);
});

test("conversation quiets session boundaries and status rows into centered dividers", async () => {
  const shared = { channelId: "chan-1", sessionId: "sess-2", turnId: "turn-2" };
  const { container } = await renderTranscript("conversation", {
    items: [
      ...items(),
      {
        ...shared,
        id: "msg:user2",
        type: "message",
        renderClass: "message",
        role: "user",
        title: "Ada",
        text: "next task",
        timestamp: "2026-06-14T19:05:01.000Z",
        messageId: "event-2",
        authorPubkey: AUTHOR,
      },
      {
        ...shared,
        id: "life:status",
        type: "lifecycle",
        renderClass: "status",
        title: "Context compacted",
        text: "",
        timestamp: "2026-06-14T19:05:02.000Z",
      },
    ],
  });

  // A second session id draws the boundary rule between the two runs.
  const boundary = container.querySelector(
    '[data-testid="session-boundary-divider"]',
  );
  assert.ok(boundary, "a second session should draw a boundary");
  assert.equal(boundary.getAttribute("data-variant"), "conversation-divider");

  const status = container.querySelector(
    '[data-testid="transcript-lifecycle-item"]',
  );
  assert.ok(status, "status lifecycle row should render");
  assert.equal(status.getAttribute("data-variant"), "conversation-divider");
  assert.match(status.textContent, /Context compacted/);
});

test("conversation keeps errors and permission gates loud", async () => {
  const shared = { channelId: "chan-1", sessionId: "sess-1", turnId: "turn-1" };
  const { container } = await renderTranscript("conversation", {
    items: [
      ...items(),
      {
        ...shared,
        id: "life:permission",
        type: "lifecycle",
        renderClass: "permission",
        title: "Permission requested",
        text: "write src/main.rs\nOptions: Allow, Deny",
        outcome: "Approved (once)",
        timestamp: "2026-06-14T19:00:11.000Z",
      },
      {
        ...shared,
        id: "life:error",
        type: "lifecycle",
        renderClass: "error",
        title: "Turn failed",
        text: "the harness exited",
        timestamp: "2026-06-14T19:00:12.000Z",
      },
    ],
  });

  const permission = container.querySelector(
    '[data-testid="transcript-permission-item"]',
  );
  assert.ok(permission, "permission item should render");
  assert.match(permission.className, /amber/);
  assert.equal(
    permission.getAttribute("data-variant"),
    null,
    "permission gates never route through the quiet divider",
  );
  assert.equal(
    permission
      .querySelector('[data-testid="transcript-permission-outcome"]')
      .textContent.trim(),
    "Approved (once)",
  );

  // The error shares the lifecycle testid, so pick it out by its copy.
  const error = [
    ...container.querySelectorAll('[data-testid="transcript-lifecycle-item"]'),
  ].find((node) => node.textContent.includes("Turn failed"));
  assert.ok(error, "error lifecycle item should still render");
  assert.match(error.className, /destructive/);
  assert.equal(
    error.getAttribute("data-variant"),
    null,
    "errors never route through the quiet divider",
  );
});

test("default and compactPreview markup is unchanged by the conversation variant", async () => {
  for (const variant of ["default", "compactPreview"]) {
    const { container } = await renderTranscript(variant);
    assert.equal(
      container.innerHTML,
      BASELINE_MARKUP[variant],
      `${variant} transcript markup drifted`,
    );
    cleanup();
  }
});
