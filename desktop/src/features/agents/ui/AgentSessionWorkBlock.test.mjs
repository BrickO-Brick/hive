/**
 * Work-block rendering: the live rail, the finished fold, the rail glyphs, and
 * the two costs a streaming block must not pay (re-rendering settled steps, and
 * losing the reader's disclosure choice to a programmatic toggle echo).
 */

import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

class NoopObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

let prefersReducedMotion = false;

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    IntersectionObserver: NoopObserver,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    ResizeObserver: NoopObserver,
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
  // `motion`'s useReducedMotion reads this query, so the reduced-motion test
  // drives it through the same surface the component does.
  dom.window.matchMedia = (query) => ({
    matches:
      prefersReducedMotion && String(query).includes("prefers-reduced-motion"),
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  globalThis.matchMedia = dom.window.matchMedia;
  dom.window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame;
});

afterEach(async () => {
  prefersReducedMotion = false;
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

const START = "2026-06-18T00:00:00.000Z";
const SHARED = { channelId: "chan-1", sessionId: "sess-1", turnId: "turn-1" };

function step(id, overrides = {}) {
  return {
    ...SHARED,
    id,
    type: "tool",
    renderClass: "shell",
    descriptor: {
      renderClass: "shell",
      label: "Ran command",
      preview: id,
      source: "shell",
      groupKey: "shell:command",
    },
    title: id,
    toolName: "shell",
    buzzToolName: null,
    status: "completed",
    args: {},
    result: "ok",
    isError: false,
    timestamp: START,
    startedAt: START,
    completedAt: "2026-06-18T00:00:01.000Z",
    ...overrides,
  };
}

function thoughtStep(id) {
  return {
    ...SHARED,
    id,
    type: "thought",
    renderClass: "thought",
    title: "Thinking",
    text: "weighing the options",
    timestamp: START,
  };
}

function noteStep(id, text = "posted the summary to the channel") {
  return {
    ...SHARED,
    id,
    type: "message",
    renderClass: "message",
    role: "assistant",
    title: "Agent",
    text,
    timestamp: START,
  };
}

/**
 * A relay post the agent made mid-turn.
 *
 * The distinguishing property is `descriptor.renderClass: "message"`, which is
 * what `buildCompactToolSummary` turns into `presentation: "message"` and what
 * routes the item to the avatar + speech-bubble presenter outside a block. The
 * result carries an `event_id` so `getSentMessageLink` resolves too — that is
 * the fully-featured shape (bubble, timestamp, delivery receipt), i.e. the one
 * that goes most wrong on a muted rail.
 */
function relayStep(id, overrides = {}) {
  return step(id, {
    renderClass: "message",
    descriptor: {
      renderClass: "message",
      label: "Send Message",
      preview: "posted the findings to the channel",
      action: { verb: "Sent", object: "posted the findings to the channel" },
      source: "shell",
      groupKey: "buzz-cli:messages.send",
      operation: "messages.send",
    },
    title: "Send Message",
    toolName: "buzz_dev_mcp__shell",
    args: {
      command:
        "buzz messages send --channel chan-1 --content 'posted the findings to the channel'",
    },
    result: '{"event_id":"ev-1","accepted":true}',
    ...overrides,
  });
}

/**
 * Let every pending animation finish and the DOM settle.
 *
 * A collapsing block keeps its rail mounted until the height animation's exit
 * completes, which is the point of the fold — so "has it closed yet?" can only
 * be asked after the exit runs, not on the commit that started it. Polling to a
 * stable answer keeps these assertions about the end state the reader sees
 * rather than about motion's internal frame schedule.
 */
async function settle(read, expected, { timeout = 2000 } = {}) {
  const { act } = await import("@testing-library/react");
  const deadline = Date.now() + timeout;
  let last = read();
  while (Date.now() < deadline) {
    if (last === expected) return last;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    last = read();
  }
  return last;
}

/**
 * Mount a work block under a router.
 *
 * Rail rows render agent content through `Markdown`, which resolves in-app links
 * via `useAppNavigation` and therefore needs router context — the same reason
 * `AgentSessionTranscriptList.conversation.test.mjs` mounts through a memory
 * router. Without it a thought row throws while a tool row happens not to.
 */
async function renderBlock(items, { streamingItemId = null } = {}) {
  const { createElement, useState } = await import("react");
  const { render } = await import("@testing-library/react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
    await import("@tanstack/react-router");
  const { AgentSessionTranscriptTurnMetaProvider } = await import(
    "./agentSessionTranscriptContext.ts"
  );
  const { AgentSessionWorkBlockSegment } = await import(
    "./AgentSessionWorkBlock.tsx"
  );

  const element = (blockItems, streaming) =>
    createElement(
      AgentSessionTranscriptTurnMetaProvider,
      {
        value: {
          streamingItemId: streaming,
        },
      },
      createElement(AgentSessionWorkBlockSegment, {
        agentAvatarUrl: null,
        agentName: "Agent",
        agentPubkey: "pk",
        block: {
          id: `work-block:${blockItems[0].id}`,
          items: blockItems,
          timestamp: blockItems[0].timestamp,
        },
      }),
    );

  let applyState;
  const Harness = () => {
    const [state, setState] = useState({ items, streamingItemId });
    applyState = setState;
    return element(state.items, state.streamingItemId);
  };
  // The bubble presenter reads the posted message through `useQuery`. Provided
  // unconditionally so that if a rail step ever DID reach that presenter, the
  // relay test below would fail on its bubble assertion rather than on a
  // missing provider — a test must fail for the reason it claims.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Harness),
      ),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute,
  });
  await router.load();

  const view = render(createElement(RouterProvider, { router }));
  const q = (selector) => view.container.querySelector(selector);
  const qa = (selector) => [...view.container.querySelectorAll(selector)];
  const stepCount = () =>
    qa('[data-testid="transcript-work-block-step"]').length;
  return {
    ...view,
    // Re-render the SAME block id, exactly as the transcript does as work
    // streams and then finishes.
    stream: (nextItems, streaming = null) =>
      applyState({ items: nextItems, streamingItemId: streaming }),
    summary: () => q('[data-testid="transcript-work-block-summary"]'),
    previousSteps: () =>
      q('[data-testid="transcript-work-block-previous-steps"]'),
    stepCount,
    // A finished block renders folded, so any assertion about what is ON the
    // rail has to open it first — exactly as a reader would.
    expand: async () => {
      const { act } = await import("@testing-library/react");
      await act(async () => {
        q('[data-testid="transcript-work-block-summary"]').click();
      });
    },
    // Wait for the rail to reach `expected` rows once animations have run.
    settleToStepCount: (expected) => settle(stepCount, expected),
    glyphStates: () =>
      qa("[data-step-state]").map((node) =>
        node.getAttribute("data-step-state"),
      ),
    q,
    qa,
  };
}

// ── Live ─────────────────────────────────────────────────────────────────────

test("a live block shows no header line — the rail is the status", async () => {
  const view = await renderBlock([
    step("a"),
    step("b", { status: "executing", completedAt: null }),
  ]);
  assert.equal(
    view.summary(),
    null,
    "a header while live would only restate what the arriving steps show",
  );
  assert.equal(view.stepCount(), 2);
});

test("a live block windows to the last three steps with the rest behind a disclosure", async () => {
  const items = ["a", "b", "c", "d", "e"].map((id) => step(id));
  items[4] = step("e", { status: "executing", completedAt: null });
  const view = await renderBlock(items, { streamingItemId: "e" });

  assert.equal(view.stepCount(), 3, "only the live window renders on the rail");
  const disclosure = view.previousSteps();
  assert.ok(disclosure, "older steps sit behind a disclosure");
  assert.match(disclosure.textContent, /2 previous steps/);
});

test("expanding previous steps reveals the older steps in place", async () => {
  const { act } = await import("@testing-library/react");
  const items = ["a", "b", "c", "d", "e"].map((id) => step(id));
  items[4] = step("e", { status: "executing", completedAt: null });
  const view = await renderBlock(items, { streamingItemId: "e" });

  assert.equal(view.stepCount(), 3);
  await act(async () => {
    view.previousSteps().click();
  });
  assert.equal(
    await view.settleToStepCount(5),
    5,
    "all five steps are now on the rail",
  );
});

// ── Finished ─────────────────────────────────────────────────────────────────

test("a block that was already finished on mount folds to an N steps line", async () => {
  const view = await renderBlock([step("a"), step("b"), step("c")]);
  const summary = view.summary();
  assert.ok(summary, "a finished block gets its summary line");
  assert.match(summary.textContent, /3 steps/);
  assert.equal(summary.getAttribute("aria-expanded"), "false");
  assert.equal(view.stepCount(), 0, "the rail is collapsed away");
});

test("a finished block containing a failure names the failure in its folded line", async () => {
  const view = await renderBlock([
    step("a"),
    step("b", { isError: true, status: "failed" }),
    step("c"),
  ]);
  assert.match(
    view.summary().textContent,
    /3 steps · 1 failed/,
    "a failure must never hide behind a neutral count",
  );
});

test("clicking the folded line expands the whole rail", async () => {
  const { act } = await import("@testing-library/react");
  const view = await renderBlock([step("a"), step("b"), step("c")]);
  assert.equal(view.stepCount(), 0);

  await act(async () => {
    view.summary().click();
  });

  assert.equal(await view.settleToStepCount(3), 3);
  assert.equal(view.summary().getAttribute("aria-expanded"), "true");
});

test("a block expanded by the reader while live shows every step, not just the window", async () => {
  const { act } = await import("@testing-library/react");
  const items = ["a", "b", "c", "d", "e"].map((id) => step(id));
  items[4] = step("e", { status: "executing", completedAt: null });
  const view = await renderBlock(items, { streamingItemId: "e" });

  assert.equal(view.stepCount(), 3);
  await act(async () => {
    view.previousSteps().click();
  });
  assert.equal(
    await view.settleToStepCount(5),
    5,
    "a reader who asked to see the work sees all of it",
  );

  // And the window does NOT come back as more work streams in: the reader's
  // choice is not re-decided on every append.
  await act(async () => {
    view.stream(
      [...items, step("f", { status: "executing", completedAt: null })],
      "f",
    );
  });
  assert.equal(
    await view.settleToStepCount(6),
    6,
    "a reader-expanded live block keeps showing everything as it grows",
  );
});

// ── Fold animation ───────────────────────────────────────────────────────────

test("a block that finishes while mounted stays open for a paint so the collapse is visible", async () => {
  const { act } = await import("@testing-library/react");
  const live = [
    step("a"),
    step("b", { status: "executing", completedAt: null }),
  ];
  const view = await renderBlock(live);
  assert.equal(view.summary(), null, "live: no header");
  assert.equal(view.stepCount(), 2);

  // The turn finishes: the same block id re-renders with settled steps.
  await act(async () => {
    view.stream([step("a"), step("b")]);
  });

  // Still open on the commit right after finishing — that open state is what
  // gives the height animation something to collapse FROM. A block that jumped
  // straight to closed would swap a rail for a one-line summary between frames.
  assert.equal(
    view.stepCount(),
    2,
    "the rail is still mounted for the settle frame",
  );
  assert.ok(
    view.summary(),
    "the summary line appears as soon as work finishes",
  );

  // After the settle frames it closes — once the collapse animation has run.
  assert.equal(await view.settleToStepCount(0), 0, "the block settles closed");
});

test("under reduced motion a finishing block folds immediately, with no settle frames", async () => {
  const { act } = await import("@testing-library/react");
  prefersReducedMotion = true;

  const view = await renderBlock([
    step("a"),
    step("b", { status: "executing", completedAt: null }),
  ]);
  assert.equal(view.stepCount(), 2);

  await act(async () => {
    view.stream([step("a"), step("b")]);
  });

  assert.equal(
    view.stepCount(),
    0,
    "reduced motion skips the animation, so there is nothing to hold open for",
  );
  assert.ok(
    view.summary(),
    "it still folds to a summary line — only the animation is skipped",
  );
});

// ── Reader choice ────────────────────────────────────────────────────────────

/**
 * The echo trap, and why this block is structurally immune to it.
 *
 * `<details>` fires `toggle` for programmatic `open` changes as well as for
 * clicks, indistinguishably — so a policy-driven open echoes back looking like
 * a reader choice and pins the row to its first policy state forever. That trap
 * cost time on the tool-run card.
 *
 * This block cannot hit it, because its disclosure is a `<button>` whose only
 * state change is the click handler firing: there is no browser-generated echo
 * to mistake for intent. That is a real invariant and not an accident of the
 * current markup — switching the trigger to `<details>` would reintroduce the
 * trap — so it is asserted rather than assumed. An earlier version of this test
 * dispatched a synthetic `toggle` at the block and asserted it changed nothing,
 * which passed for the wrong reason: nothing was listening for `toggle` at all.
 */
test("the block's disclosure has no toggle echo to mistake for a reader choice", async () => {
  const { act } = await import("@testing-library/react");
  const live = [
    step("a"),
    step("b", { status: "executing", completedAt: null }),
  ];
  const view = await renderBlock(live);

  await act(async () => {
    view.stream([step("a"), step("b")]);
  });
  assert.equal(await view.settleToStepCount(0), 0, "policy folds it");

  const trigger = view.summary();
  assert.equal(
    trigger.tagName,
    "BUTTON",
    "a button has no programmatic-toggle echo; <details> would need the hook's guard",
  );
  assert.equal(
    view.q("details"),
    null,
    "no <details> anywhere in the block, so no echo can be generated",
  );

  // And the fold is genuinely repeatable: policy opens it for the next live
  // phase and folds it again, which is the exact behaviour a recorded echo
  // would have disabled.
  await act(async () => {
    view.stream(
      [
        step("a"),
        step("b"),
        step("c", { status: "executing", completedAt: null }),
      ],
      "c",
    );
  });
  assert.equal(
    await view.settleToStepCount(3),
    3,
    "policy re-opens for new work",
  );

  await act(async () => {
    view.stream([step("a"), step("b"), step("c")]);
  });
  assert.equal(
    await view.settleToStepCount(0),
    0,
    "and folds again — policy transitions still work",
  );
});

test("a reader who opens a finished block keeps it open as the transcript moves on", async () => {
  const { act } = await import("@testing-library/react");
  const view = await renderBlock([step("a"), step("b")]);
  assert.equal(view.stepCount(), 0);

  await act(async () => {
    view.summary().click();
  });
  assert.equal(await view.settleToStepCount(2), 2);

  // A later append re-renders the block; the reader's choice must survive it.
  await act(async () => {
    view.stream([step("a"), step("b"), step("c")]);
  });
  assert.equal(
    await view.settleToStepCount(3),
    3,
    "the reader's choice outlives later policy transitions",
  );
});

test("a reader who folds a live block keeps it folded while work continues", async () => {
  const { act } = await import("@testing-library/react");
  const live = [
    step("a"),
    step("b", { status: "executing", completedAt: null }),
  ];
  const view = await renderBlock(live);
  assert.equal(view.stepCount(), 2, "live blocks open themselves");

  // While live there is no summary trigger, so the reader's route to folding is
  // the block's own disclosure change handler. Drive it the way a click would.
  await act(async () => {
    view.stream([step("a"), step("b")]);
  });
  assert.equal(await view.settleToStepCount(0), 0, "policy folded it");

  await act(async () => {
    view.summary().click();
  });
  assert.equal(await view.settleToStepCount(2), 2, "reader opened it");

  await act(async () => {
    view.stream(
      [
        step("a"),
        step("b"),
        step("c", { status: "executing", completedAt: null }),
      ],
      "c",
    );
  });
  assert.equal(
    await view.settleToStepCount(3),
    3,
    "the reader's open choice persists into the next live phase",
  );
});

// ── Rail ─────────────────────────────────────────────────────────────────────

test("the rail marks running, failed and settled steps with distinct glyph states", async () => {
  const view = await renderBlock(
    [
      step("a"),
      step("b", { isError: true, status: "failed" }),
      step("c", { status: "executing", completedAt: null }),
    ],
    { streamingItemId: "c" },
  );

  assert.deepEqual(view.glyphStates(), ["settled", "failed", "running"]);
  assert.equal(view.summary(), null, "a running step keeps the block live");
});

test("a running step pulses and a failed one does not", async () => {
  const view = await renderBlock(
    [
      step("a", { isError: true, status: "failed" }),
      step("b", { status: "executing", completedAt: null }),
    ],
    { streamingItemId: "b" },
  );
  const [failed, running] = view.qa("[data-step-state]");
  assert.ok(
    running.className.includes("animate-pulse"),
    "work in flight pulses",
  );
  assert.ok(
    !failed.className.includes("animate-pulse"),
    "a settled failure is not in flight",
  );
});

test("the rail bullet masks the spine with the drawer surface colour", async () => {
  // The bullet has to mask the spine passing behind it, and the mask must match
  // the surface the transcript is drawn on. A mask in any other colour shows as
  // a disc of the wrong shade around every bullet (berd's BOT-1599).
  const view = await renderBlock([step("a"), step("b")]);
  await view.expand();
  const bullet = view.q("[data-step-state]");
  assert.match(bullet.className, /\bbg-background\b/);
  assert.match(bullet.className, /\bring-background\b/);
  assert.match(bullet.className, /\brounded-full\b/);
});

test("the spine is drawn for every step except the last", async () => {
  const view = await renderBlock([step("a"), step("b"), step("c")]);
  await view.expand();
  const spines = view.qa(".w-px");
  assert.equal(
    spines.length,
    2,
    "three steps means two connecting segments; a trailing spine would dangle",
  );
});

test("thinking renders as a rail row with its own glyph, not a nested disclosure", async () => {
  const view = await renderBlock([thoughtStep("thought:1"), step("a")]);
  await view.expand();
  const thought = view.q('[data-testid="transcript-work-block-thought"]');
  assert.ok(thought, "reasoning renders on the rail");
  assert.match(thought.textContent, /weighing the options/);
  assert.equal(
    view.q('[data-testid="transcript-thought-disclosure"]'),
    null,
    "the block is already one disclosure — a thought must not add a second",
  );
});

/**
 * An interim note is progress, not a second reply.
 *
 * #6720 gives every conversation-variant assistant message a 20px avatar + name
 * identity row, which is right for the turn's answer. A rail note is the same
 * item type, so routing it through that presenter would render a fully
 * attributed agent turn nested inside a muted step row — the reader would see
 * the agent apparently reply twice, once inside the work it was doing. berd
 * draws the same line: its `progress` entry is a plain rail row.
 *
 * The suppression is done on this side (a dedicated prose body) rather than by
 * reaching into the message presenter, so #6720 keeps one rule for what a
 * message looks like.
 */
test("an interim note renders as rail prose with no identity row", async () => {
  const view = await renderBlock([
    step("a"),
    noteStep("msg:interim", "checked the three call sites"),
  ]);
  await view.expand();

  const note = view.q('[data-testid="transcript-work-block-note"]');
  assert.ok(note, "the note renders on the rail");
  assert.match(note.textContent, /checked the three call sites/);

  assert.ok(
    view.q('[data-testid="transcript-assistant-identity"]') === null,
    "an avatar + name row inside a muted step reads as a second reply",
  );
  assert.ok(
    view.q('[data-testid="transcript-assistant-message"]') === null,
    "the note must not go through the message presenter at all",
  );
});

/**
 * A relay post is a step, not a reply — the same rule as an interim note,
 * reached by a different route.
 *
 * A note is an assistant *message* the block re-presents as prose. A relay post
 * is a *tool call* that classifies as `renderClass: "message"`, so it renders
 * through `CompactMessageSummary`: 28px avatar, bordered speech bubble,
 * timestamp, delivery-receipt button. That is right in the activity feed, where
 * a posted message is a destination to open; on the rail it makes the agent
 * appear to reply in the middle of its own work — and it did, in the seeded
 * browser preview, which is where this was caught.
 *
 * Suppressing it needs the presentation signal rather than the transcript
 * variant: the same relay step OUTSIDE a block in this variant keeps its
 * bubble, which the next test pins.
 */
test("a relay post on the rail is a plain step, with no bubble or avatar", async () => {
  const view = await renderBlock([step("a"), relayStep("relay:1")]);
  await view.expand();

  assert.equal(
    view.stepCount(),
    2,
    "the relay post takes its own rail row, like any other step",
  );
  assert.equal(
    view.qa('[data-work-block-entry="tool"]').length,
    2,
    "a relay post is a tool step — it is something the agent did",
  );
  assert.equal(
    view.q('[data-testid="transcript-tool-message-preview"]'),
    null,
    "a speech bubble inside a muted step reads as the agent replying mid-work",
  );
  assert.equal(
    view.q('[data-testid="transcript-agent-sent-avatar"]'),
    null,
    "no identity avatar on the rail",
  );
  assert.equal(
    view.q('[data-testid="transcript-sent-message-context-button"]'),
    null,
    "no delivery receipt on the rail",
  );

  // It is still a real, expandable tool row carrying its command.
  const rows = view.qa('[data-testid="transcript-tool-item"]');
  assert.equal(rows.length, 2, "both steps render as tool rows");
  assert.ok(
    rows[1].querySelector("details"),
    "the relay step keeps the ordinary step disclosure so its args stay reachable",
  );
  assert.match(
    rows[1].textContent,
    /Sent|posted the findings/,
    "the row still says what the step was",
  );
});

/**
 * The other half of the branch: outside a block the bubble is correct and must
 * survive. Without this, suppressing the bubble everywhere in the conversation
 * variant would pass the test above.
 */
test("the same relay post outside a work block keeps its message bubble", async () => {
  const { createElement } = await import("react");
  const { render } = await import("@testing-library/react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
    await import("@tanstack/react-router");
  const { AgentSessionTranscriptVariantProvider } = await import(
    "./agentSessionTranscriptContext.ts"
  );
  const { TranscriptActivityItem } = await import(
    "./activityRenderClasses/TranscriptActivityItem.tsx"
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          AgentSessionTranscriptVariantProvider,
          { value: "conversation" },
          createElement(TranscriptActivityItem, {
            agentAvatarUrl: null,
            agentName: "Agent",
            agentPubkey: "pk",
            item: relayStep("relay:1"),
          }),
        ),
      ),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute,
  });
  await router.load();
  const view = render(createElement(RouterProvider, { router }));

  assert.ok(
    view.container.querySelector(
      '[data-testid="transcript-tool-message-preview"]',
    ),
    "outside a block a posted message is a destination the reader can open — the bubble stays",
  );
});

test("the rail glyph is chosen by kind, and prose kinds share the speech bubble", async () => {
  // The exhaustive switch is the point: a note that fell through to the tool
  // branch would wear a wrench and read as something the agent ran.
  const view = await renderBlock([
    thoughtStep("thought:1"),
    noteStep("msg:interim"),
    step("a"),
    step("b", { isError: true, status: "failed" }),
  ]);
  await view.expand();

  const glyphClass = (kind, index = 0) => {
    const rows = view.qa(`[data-work-block-entry="${kind}"]`);
    const icon = rows[index].querySelector("svg");
    return icon.getAttribute("class") ?? "";
  };

  // lucide stamps each icon with a `lucide-<kebab-name>` class, so the glyph
  // identity is readable from the DOM without reaching into the icon modules.
  assert.match(glyphClass("thought"), /lucide-message-circle/);
  assert.match(
    glyphClass("note"),
    /lucide-message-circle/,
    "prose is the agent talking, whether it is reasoning or a note",
  );
  assert.match(glyphClass("tool", 0), /lucide-wrench/);
  assert.match(
    glyphClass("tool", 1),
    /lucide-circle/,
    "a failed step is a filled dot, not a wrench",
  );
});

test("the rail bullet is never red, whatever the step's outcome", async () => {
  // A failure is carried by glyph shape and by the folded line's count. Tinting
  // the bullet would make one bad step read as an alarm across the whole run.
  //
  // The running step keeps this block live, so the rail is already open — which
  // is also the only state in which a running bullet can be observed at all.
  const view = await renderBlock(
    [
      step("a"),
      step("b", { isError: true, status: "failed" }),
      step("c", { status: "executing", completedAt: null }),
    ],
    { streamingItemId: "c" },
  );

  assert.deepEqual(
    view.glyphStates(),
    ["settled", "failed", "running"],
    "all three outcomes are on screen",
  );
  for (const bullet of view.qa("[data-step-state]")) {
    assert.ok(
      !/\b(text|bg|ring)-(destructive|red)/.test(bullet.className),
      `rail bullet for ${bullet.getAttribute("data-step-state")} must stay muted`,
    );
    assert.match(bullet.className, /\btext-muted-foreground\b/);
  }
});

/**
 * berd brightens rail prose with `usePrimaryText={open}`. Here the brightening
 * is unconditional, and this test records why that is not a divergence: a closed
 * block unmounts its rows rather than dimming them, so there is no state in
 * which rail prose is on screen and NOT in an open block. A `primaryText` prop
 * would have an unreachable false branch.
 */
test("rail prose is primary text, and a closed block has no prose on screen at all", async () => {
  const { act } = await import("@testing-library/react");
  const live = [
    thoughtStep("thought:1"),
    noteStep("msg:interim"),
    step("b", { status: "executing", completedAt: null }),
  ];
  const view = await renderBlock(live, { streamingItemId: "b" });

  const prose = () =>
    view.qa(
      '[data-testid="transcript-work-block-thought"],[data-testid="transcript-work-block-note"]',
    );

  assert.equal(prose().length, 2, "both prose rows are on the live rail");
  for (const node of prose()) {
    assert.match(
      node.className,
      /\btext-foreground\b/,
      "prose the reader can see is primary, not muted",
    );
    assert.ok(
      !/\btext-muted-foreground\b/.test(node.className),
      "the row must not carry both colours",
    );
  }

  // Finish the turn: the block folds and takes its prose with it.
  await act(async () => {
    view.stream([thoughtStep("thought:1"), noteStep("msg:interim"), step("b")]);
  });
  assert.equal(await view.settleToStepCount(0), 0, "it folded");
  assert.equal(
    prose().length,
    0,
    "a folded block renders no prose, so there is no dimmed state to test",
  );

  // And the reader reopening it brings the same primary prose back.
  await act(async () => {
    view.summary().click();
  });
  assert.equal(await view.settleToStepCount(3), 3, "the reader reopened it");
  assert.equal(prose().length, 2);
  for (const node of prose()) {
    assert.match(node.className, /\btext-foreground\b/);
  }
});

// ── Streaming cost ───────────────────────────────────────────────────────────

/**
 * A block re-renders on every append while work streams. Unchanged steps must
 * not re-render with it: each step's presenter rebuilds compact tool summaries,
 * parses diffs and renders markdown/images, so an unmemoized step row makes a
 * long block cost O(n) of that work per appended step.
 *
 * Counted at the presenter boundary — `TranscriptActivityItem` looks its
 * presenter up in `ACTIVITY_RENDER_CLASS_PRESENTERS` on every render, so
 * swapping in a counting presenter observes exactly the work a step row
 * triggers, without reaching into React internals.
 */
async function countStepRenders(initialItems, nextItems) {
  const { createElement } = await import("react");
  const { render } = await import("@testing-library/react");
  const { ACTIVITY_RENDER_CLASS_PRESENTERS } = await import(
    "./activityRenderClasses/TranscriptActivityItem.tsx"
  );
  const { AgentSessionTranscriptTurnMetaProvider } = await import(
    "./agentSessionTranscriptContext.ts"
  );
  const { AgentSessionWorkBlockSegment } = await import(
    "./AgentSessionWorkBlock.tsx"
  );

  const renders = [];
  const original = ACTIVITY_RENDER_CLASS_PRESENTERS.shell;
  ACTIVITY_RENDER_CLASS_PRESENTERS.shell = function CountingPresenter(props) {
    renders.push(props.item.id);
    return createElement("div", null, props.item.id);
  };

  try {
    const element = (items) =>
      createElement(
        AgentSessionTranscriptTurnMetaProvider,
        {
          value: {
            streamingItemId: items[items.length - 1].id,
          },
        },
        createElement(AgentSessionWorkBlockSegment, {
          agentAvatarUrl: null,
          agentName: "Agent",
          agentPubkey: "pk",
          block: {
            id: "work-block:a",
            items,
            timestamp: items[0].timestamp,
          },
        }),
      );

    const view = render(element(initialItems));
    renders.length = 0;
    view.rerender(element(nextItems));
    return renders;
  } finally {
    ACTIVITY_RENDER_CLASS_PRESENTERS.shell = original;
  }
}

test("appending a step does not re-render the steps already on the rail", async () => {
  // The block is expanded (a live block with ≤3 steps shows them all), and the
  // prior steps are the SAME objects across both renders, as the transcript
  // store replaces items rather than mutating them.
  const settled = [step("a"), step("b")];
  const appended = [
    ...settled,
    step("c", { status: "executing", completedAt: null }),
  ];

  const rendered = await countStepRenders(settled, appended);

  assert.deepEqual(rendered, ["c"]);
});

test("a step that actually changed does re-render", async () => {
  // Guards the memo from being too aggressive: an executing step settling is a
  // new object for that id, and it must re-render to drop its running glyph.
  const a = step("a");
  const executing = step("b", { status: "executing", completedAt: null });
  const settled = step("b");

  const rendered = await countStepRenders([a, executing], [a, settled]);

  assert.deepEqual(rendered, ["b"]);
});
