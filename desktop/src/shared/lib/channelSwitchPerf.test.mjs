import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldAttributeFetch,
  buildSwitchPerfLogRecord,
  resolveSettleAction,
  CHANNEL_SWITCH_MEASURE,
  beginChannelSwitchTrace,
  resetChannelSwitchTrace,
  resolveFinalFrame,
  resolveSettleWait,
  abandonChannelSwitchTrace,
  resolveRenderReadiness,
  scheduleRouteExitAbandon,
  resolveTraceAnchor,
  settleChannelSwitchTrace,
  summarizeChannelSwitchTrace,
} from "./channelSwitchPerf.ts";

function trace(overrides = {}) {
  return {
    channelId: "abcdef1234567890",
    startedAt: 1_000,
    // Liveness clock defaults to the anchor; DM entries back-date startedAt
    // below openedAt, which is exactly why the two are separate fields.
    openedAt: overrides.startedAt ?? 1_000,
    maxFrameGapMs: 0,
    settleEnteredAt: null,
    routeCommitAt: null,
    windowFetch: null,
    membersFetch: null,
    ...overrides,
  };
}

test("summary reports total and cache-served fetches", () => {
  const summary = summarizeChannelSwitchTrace(trace(), 1_412.4);
  assert.equal(
    summary,
    "[switch-perf] channel=abcdef12 total=412ms commit=? window=cache members=cache",
  );
});

test("summary includes route commit offset and fetch timings", () => {
  const summary = summarizeChannelSwitchTrace(
    trace({
      routeCommitAt: 1_038,
      windowFetch: { durationMs: 180.6, eventCount: 250 },
      membersFetch: { durationMs: 320.2, memberCount: 10_000 },
    }),
    1_912,
  );
  assert.equal(
    summary,
    "[switch-perf] channel=abcdef12 total=912ms commit=+38ms " +
      "window=250 events in 181ms members=10000 members in 320ms",
  );
});

test("log record carries rounded stage timings and fetch attributions", () => {
  const record = buildSwitchPerfLogRecord(
    trace({
      routeCommitAt: 1_038.4,
      windowFetch: { durationMs: 180.6, eventCount: 250 },
      membersFetch: { durationMs: 320.2, memberCount: 10_000 },
    }),
    1_912.3,
  );
  assert.equal(record.channelId, "abcdef1234567890");
  assert.equal(record.totalMs, 912);
  assert.equal(record.commitOffsetMs, 38);
  assert.deepEqual(record.windowFetch, { durationMs: 181, eventCount: 250 });
  assert.deepEqual(record.membersFetch, {
    durationMs: 320,
    memberCount: 10_000,
  });
  assert.equal(typeof record.ts, "string");
});

test("log record marks cache-served fetches and missing commit as null", () => {
  const record = buildSwitchPerfLogRecord(trace(), 1_412);
  assert.equal(record.commitOffsetMs, null);
  assert.equal(record.windowFetch, null);
  assert.equal(record.membersFetch, null);
});

test("settle resolves only the trace for the settled channel", () => {
  const active = trace();
  assert.deepEqual(resolveSettleAction(active, "abcdef1234567890", 2_000), {
    settledTrace: active,
    clearActive: true,
  });
  assert.deepEqual(resolveSettleAction(null, "abcdef1234567890", 2_000), {
    settledTrace: null,
    clearActive: false,
  });
});

test("a mismatched settle never clobbers a newer switch's trace", () => {
  // Channel A settles after the user already clicked channel B: B's trace
  // must survive so B still gets measured.
  const nextSwitch = trace({ channelId: "bbbb0000bbbb0000" });
  assert.deepEqual(resolveSettleAction(nextSwitch, "abcdef1234567890", 2_000), {
    settledTrace: null,
    clearActive: false,
  });
});

test("settle drops a trace that has timed out", () => {
  const stale = trace({ startedAt: 1_000 });
  assert.deepEqual(resolveSettleAction(stale, "abcdef1234567890", 31_001), {
    settledTrace: null,
    clearActive: true,
  });
  assert.deepEqual(
    resolveSettleAction(stale, "abcdef1234567890", 11_000).settledTrace,
    stale,
  );
});

test("the settle wait records truncated — never as an honest settle — at deadline", () => {
  // Still pending, before the deadline: keep waiting.
  assert.equal(resolveSettleWait(4_999, 5_000, true, 0), "wait");
  // Render caught up: record cleanly.
  assert.deepEqual(resolveSettleWait(1_000, 5_000, false, 0), {
    settleWaitTruncated: false,
  });
  // Deadline expired while still pending: the record must say so — a >5s
  // switch reported as an ordinary settle would hide exactly the tail this
  // tracer exists to expose.
  assert.deepEqual(resolveSettleWait(5_000, 5_000, true, 0), {
    settleWaitTruncated: true,
  });
});

test("a frame-starved trace is dropped, not recorded as a clean settle", () => {
  // rAF suspends in hidden windows, so a queued settle can fire minutes
  // after the click with renderPending long since false — the absence must
  // not be charged to the switch. Nothing legitimate can be older than the
  // 30s settle-entry timeout plus the 5s render wait.
  assert.equal(resolveSettleWait(35_001, 40_000, false, 0), "drop");
  assert.equal(resolveSettleWait(35_001, 40_000, true, 0), "drop");
  // At the bound (a 29.9s settle plus a truncated 5s wait) records survive.
  assert.deepEqual(resolveSettleWait(35_000, 34_900, true, 0), {
    settleWaitTruncated: true,
  });
});

test("a not-pending frame landing past the wait deadline is starvation, not a settle", () => {
  // Settle entered at t=1s (deadline 6s), render caught up, then frames
  // stalled (system suspend, App Nap — no visibilitychange): the next frame
  // lands at t=20s with nothing pending. The gap is starvation; recording
  // it would fabricate a clean 20s switch well under the 35s age guard.
  assert.equal(resolveSettleWait(20_000, 6_000, false, 0), "drop");
  // Still-pending arrivals past the deadline remain truncated records: the
  // render genuinely wasn't done, which is the tail the tracer must keep.
  assert.deepEqual(resolveSettleWait(6_001, 6_000, true, 0), {
    settleWaitTruncated: true,
  });
});

test("a starved frame gap drops even while the render-pending marker is latched", () => {
  // During a suspension React can't flush the deferred commit, so the
  // pending marker stays latched — its truth is NOT evidence the render was
  // slow. A single inter-frame gap beyond any plausible main-thread stall
  // means the process was suspended; recording a truncated 22s "switch"
  // would fabricate the very regression the tracer hunts.
  assert.equal(resolveSettleWait(22_300, 5_300, true, 0, 22_000), "drop");
  // Heavy-but-real frames (multi-hundred-ms long tasks) still record.
  assert.deepEqual(resolveSettleWait(5_400, 5_300, true, 0, 900), {
    settleWaitTruncated: true,
  });
  // The first frame has no predecessor: no gap to judge.
  assert.deepEqual(resolveSettleWait(1_000, 5_300, false, 0, null), {
    settleWaitTruncated: false,
  });
});

test("a truncated settle is flagged in the summary and the log record", () => {
  const summary = summarizeChannelSwitchTrace(trace(), 1_412, true);
  assert.ok(summary.endsWith(" settle=truncated"), summary);
  const record = buildSwitchPerfLogRecord(trace(), 1_412, true);
  assert.equal(record.settleWaitTruncated, true);
  // Clean settles keep the field out of the line entirely.
  assert.ok(
    !("settleWaitTruncated" in buildSwitchPerfLogRecord(trace(), 1_412)),
  );
});

test("fetches attribute only when started after the switch began", () => {
  const active = trace({ channelId: "abcdef1234567890", startedAt: 1_000 });
  // Started before the switch (stale A→B→A leg): not attributable.
  assert.equal(shouldAttributeFetch(active, "abcdef1234567890", 999), false);
  // Started at/after the switch: attributable.
  assert.equal(shouldAttributeFetch(active, "abcdef1234567890", 1_000), true);
  assert.equal(shouldAttributeFetch(active, "abcdef1234567890", 1_500), true);
  // Other channel or no trace: never.
  assert.equal(shouldAttributeFetch(active, "bbbb0000bbbb0000", 1_500), false);
  assert.equal(shouldAttributeFetch(null, "abcdef1234567890", 1_500), false);
  // Started after the timeline settled: background revalidation the user
  // never waited on. The trace is still active (it waits for the deferred
  // paint), so without the upper bound this would be reported as switch cost.
  const settling = trace({ startedAt: 1_000, settleEnteredAt: 2_000 });
  assert.equal(shouldAttributeFetch(settling, "abcdef1234567890", 1_999), true);
  assert.equal(
    shouldAttributeFetch(settling, "abcdef1234567890", 2_001),
    false,
  );
});

test("a superseded members fetch never claims the trace's one-shot slot", async () => {
  const { openChannelMembersFetch, traceChannelMembersFetch } = await import(
    "./channelSwitchPerf.ts"
  );
  await withSettleHarness(async ({ begin, settle, flush }) => {
    begin("aaaa1111aaaa1111");
    const startedAt = performance.now();
    // Fetch #1 starts, then a live join/leave invalidation replaces it with
    // fetch #2. #1 resolves first (the Tauri call can't be cancelled) but
    // must not attribute: its roster is not the one rendered. The query's
    // AbortSignal is deliberately not used for this — consuming it flips
    // React Query to cancel-and-revert on last-observer unsubscribe, which
    // discards warm rosters on interrupted switches.
    const first = openChannelMembersFetch("aaaa1111aaaa1111");
    const second = openChannelMembersFetch("aaaa1111aaaa1111");
    traceChannelMembersFetch("aaaa1111aaaa1111", 9_999, 900, startedAt, first);
    traceChannelMembersFetch(
      "aaaa1111aaaa1111",
      10_002,
      120,
      startedAt,
      second,
    );
    settle("aaaa1111aaaa1111");
    flush();
    const measure = performance
      .getEntriesByName("buzz:channel-switch:click-to-settled")
      .at(-1);
    assert.equal(measure?.detail?.membersFetch?.memberCount, 10_002);
    assert.equal(measure?.detail?.membersFetch?.durationMs, 120);
  });
});

test("a suspension before the first settle frame drops, not records truncated", async () => {
  await withSettleHarness(async ({ begin, settle, flush, measures }) => {
    const virtualClock = { now: 0 };
    performance.now = () => virtualClock.now;
    try {
      // The deferred marker stays latched during a suspension, so its truth
      // is not evidence of slow rendering — the settle-entry → first-frame
      // window must be starvation-guarded like every later frame.
      // Element-like: carries the pending marker but no committed timeline
      // generation, so readiness stays gated on the marker alone.
      globalThis.document.querySelector = () => ({ getAttribute: () => null });
      begin("aaaa1111aaaa1111");
      settle("aaaa1111aaaa1111");
      virtualClock.now = 20_000;
      flush();
      assert.deepEqual(measures(), []);
    } finally {
      delete performance.now;
    }
  });
});

// --- Settle lifecycle: rapid switches and community resets ----------------

async function withSettleHarness(run, documentOverrides = {}) {
  const frames = [];
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  globalThis.window = {
    requestAnimationFrame: (cb) => frames.push(cb) && frames.length,
    cancelAnimationFrame: () => {},
  };
  globalThis.document = {
    addEventListener: () => {},
    querySelector: () => null,
    removeEventListener: () => {},
    visibilityState: "visible",
    ...documentOverrides,
  };
  const {
    abandonChannelSwitchTrace,
    beginChannelSwitchTrace,
    cancelRouteExitAbandon,
    scheduleRouteExitAbandon,
    settleChannelSwitchTrace,
    resetChannelSwitchTrace,
    CHANNEL_SWITCH_MEASURE,
  } = await import("./channelSwitchPerf.ts");
  performance.clearMeasures?.(CHANNEL_SWITCH_MEASURE);
  const flush = () => {
    // Drain chained rAFs until quiescent.
    for (let i = 0; i < 20 && frames.length > 0; i += 1) {
      for (const cb of frames.splice(0, frames.length)) cb();
    }
  };
  const measures = () =>
    performance
      .getEntriesByName(CHANNEL_SWITCH_MEASURE)
      .map((entry) => entry.detail?.channelId);
  try {
    await run({
      abandon: abandonChannelSwitchTrace,
      begin: beginChannelSwitchTrace,
      cancelAbandon: cancelRouteExitAbandon,
      scheduleAbandon: scheduleRouteExitAbandon,
      settle: settleChannelSwitchTrace,
      reset: resetChannelSwitchTrace,
      flush,
      measures,
    });
  } finally {
    resetChannelSwitchTrace();
    performance.clearMeasures?.(CHANNEL_SWITCH_MEASURE);
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
}

test("a switch begun during A's deferred wait drops A's record (no clock theft)", async () => {
  await withSettleHarness(async ({ begin, settle, flush, measures }) => {
    begin("aaaa1111aaaa1111");
    settle("aaaa1111aaaa1111"); // A's deferred-paint wait is now queued
    begin("bbbb2222bbbb2222"); // rapid follow-up switch replaces the trace
    flush();
    // A must NOT be recorded: its settledAt would be sampled from B's
    // timeline, charging B's delay to A.
    assert.deepEqual(measures(), []);
    settle("bbbb2222bbbb2222");
    flush();
    assert.deepEqual(measures(), ["bbbb2222bbbb2222"]);
  });
});

test("a community reset during the deferred wait drops the record", async () => {
  await withSettleHarness(async ({ begin, settle, reset, flush, measures }) => {
    begin("aaaa1111aaaa1111");
    settle("aaaa1111aaaa1111");
    reset();
    flush();
    assert.deepEqual(measures(), []);
  });
});

test("an undisturbed settle records exactly one measure", async () => {
  await withSettleHarness(async ({ begin, settle, flush, measures }) => {
    begin("aaaa1111aaaa1111");
    settle("aaaa1111aaaa1111");
    flush();
    assert.deepEqual(measures(), ["aaaa1111aaaa1111"]);
  });
});

test("beginning a switch clears the previous switch's settled mark and measure", async () => {
  await withSettleHarness(async ({ begin, settle, flush, measures }) => {
    const { CHANNEL_SWITCH_SETTLED_MARK } = await import(
      "./channelSwitchPerf.ts"
    );
    begin("aaaa1111aaaa1111");
    settle("aaaa1111aaaa1111");
    flush();
    assert.deepEqual(measures(), ["aaaa1111aaaa1111"]);
    // A consumer polling the buffer mid-switch (the Playwright specs, the
    // Performance panel) must never read the PREVIOUS switch's entries as
    // the current one's.
    begin("bbbb2222bbbb2222");
    assert.deepEqual(measures(), []);
    assert.equal(
      performance.getEntriesByName(CHANNEL_SWITCH_SETTLED_MARK).length,
      0,
    );
  });
});

test("a window hidden between click and settle entry drops the trace", async () => {
  const visibilityListeners = [];
  await withSettleHarness(
    async ({ begin, settle, flush, measures }) => {
      begin("aaaa1111aaaa1111");
      assert.ok(visibilityListeners.length >= 1, "watcher armed at begin");
      // The window hides while the fetch is in flight (cmd-H / minimize),
      // then the user returns and the settle runs with the window visible
      // again: the absence sits inside totalMs, so the trace must drop.
      globalThis.document.visibilityState = "hidden";
      for (const listener of visibilityListeners) listener();
      globalThis.document.visibilityState = "visible";
      settle("aaaa1111aaaa1111");
      flush();
      assert.deepEqual(measures(), []);
    },
    {
      addEventListener: (type, listener) => {
        if (type === "visibilitychange") visibilityListeners.push(listener);
      },
    },
  );
});

test("abandoned switches never accumulate start marks", async () => {
  await withSettleHarness(async ({ abandon, begin }) => {
    const { CHANNEL_SWITCH_START_MARK } = await import(
      "./channelSwitchPerf.ts"
    );
    performance.clearMarks?.(CHANNEL_SWITCH_START_MARK);
    // Traces that die without recording (forum visits, route exits, drops)
    // never reach record()'s buffer clearing — begin() must bound the
    // buffer itself or weeks-long sessions accumulate a mark per abandon.
    for (const channelId of ["aaaa", "bbbb", "cccc", "dddd"]) {
      begin(channelId);
      abandon(channelId);
    }
    assert.equal(
      performance.getEntriesByName(CHANNEL_SWITCH_START_MARK).length,
      1,
    );
    performance.clearMarks?.(CHANNEL_SWITCH_START_MARK);
  });
});

test("a settle in a hidden window drops the trace instead of recording", async () => {
  await withSettleHarness(
    async ({ begin, settle, flush, measures }) => {
      begin("aaaa1111aaaa1111");
      // rAF is suspended while hidden; the queued chain would only fire when
      // the user returns, charging the whole absence to the switch.
      settle("aaaa1111aaaa1111");
      flush();
      assert.deepEqual(measures(), []);
      // The trace was released, not wedged: a later stale settle is a no-op.
      settle("aaaa1111aaaa1111");
      flush();
      assert.deepEqual(measures(), []);
    },
    { visibilityState: "hidden" },
  );
});

test("a window hidden during the settle wait drops the record", async () => {
  const visibilityListeners = [];
  await withSettleHarness(
    async ({ begin, settle, flush, measures }) => {
      begin("aaaa1111aaaa1111");
      settle("aaaa1111aaaa1111");
      assert.equal(visibilityListeners.length, 1, "wait registers a listener");
      // The user cmd-tabs away mid-wait; frames resume only on return.
      visibilityListeners[0]();
      flush();
      assert.deepEqual(measures(), []);
    },
    {
      addEventListener: (type, listener) => {
        if (type === "visibilitychange") visibilityListeners.push(listener);
      },
    },
  );
});

test("a scheduled route-exit abandon canceled in the same task keeps the trace", async () => {
  await withSettleHarness(
    async ({
      begin,
      cancelAbandon,
      scheduleAbandon,
      settle,
      flush,
      measures,
    }) => {
      begin("aaaa1111aaaa1111");
      // StrictMode's dev-only effect replay: cleanup schedules the abandon,
      // the synchronous re-setup cancels it before the microtask runs.
      scheduleAbandon("aaaa1111aaaa1111");
      cancelAbandon("aaaa1111aaaa1111");
      await Promise.resolve();
      settle("aaaa1111aaaa1111");
      flush();
      assert.deepEqual(measures(), ["aaaa1111aaaa1111"]);
    },
  );
});

test("the trace anchors at the input event, not handler dispatch", async () => {
  await withSettleHarness(async ({ begin, settle, flush }) => {
    // Real-clock gap: earlier tests fired visibilitychange listeners, and a
    // back-dated anchor overlapping those timestamps is (correctly) dropped
    // by the hidden-window guard. Let them age out first.
    await new Promise((resolve) => setTimeout(resolve, 600));
    // A click can sit queued behind a long task before its handler runs;
    // that input delay is felt switch latency and must be inside totalMs.
    // window.event is set only during synchronous dispatch, so this anchor
    // can never leak in from async continuations.
    globalThis.window.event = { timeStamp: performance.now() - 550 };
    begin("aaaa1111aaaa1111");
    delete globalThis.window.event;
    const startMark = performance
      .getEntriesByName("buzz:channel-switch:start")
      .at(-1);
    settle("aaaa1111aaaa1111");
    flush();
    const measure = performance
      .getEntriesByName("buzz:channel-switch:click-to-settled")
      .at(-1);
    assert.ok(measure, "measure recorded");
    assert.ok(
      measure.duration >= 550,
      `input delay must be inside the measure (got ${measure.duration})`,
    );
    // The mark and the measure must share the anchor, or the Performance
    // panel shows two different switch durations for the same switch.
    assert.equal(startMark?.startTime, measure.startTime);
  });
});

test("beginning a switch revokes a pending route-exit abandon for that channel", async () => {
  await withSettleHarness(
    async ({ begin, scheduleAbandon, settle, flush, measures }) => {
      // Same-task unmount-then-renavigate to the same channel: the cleanup
      // schedules the abandon, then goChannel synchronously opens a fresh
      // trace before the microtask drains. The stale abandon must not kill
      // the new trace.
      scheduleAbandon("aaaa1111aaaa1111");
      begin("aaaa1111aaaa1111");
      await Promise.resolve();
      settle("aaaa1111aaaa1111");
      flush();
      assert.deepEqual(measures(), ["aaaa1111aaaa1111"]);
    },
  );
});

test("an uncanceled route-exit abandon drops the trace before any frame fires", async () => {
  await withSettleHarness(
    async ({ begin, scheduleAbandon, settle, flush, measures }) => {
      begin("aaaa1111aaaa1111");
      scheduleAbandon("aaaa1111aaaa1111");
      await Promise.resolve();
      settle("aaaa1111aaaa1111");
      flush();
      assert.deepEqual(measures(), []);
    },
  );
});

test("leaving the channel surface abandons the trace; history-back records nothing", async () => {
  await withSettleHarness(
    async ({ abandon, begin, settle, flush, measures }) => {
      begin("aaaa1111aaaa1111");
      // Route exit (Projects/Home): the channel screen unmounts before the
      // trace settled and abandons it.
      abandon("aaaa1111aaaa1111");
      // History-back re-enters the channel without goChannel; its settle must
      // find no trace — otherwise the time spent away would be recorded as
      // switch latency.
      settle("aaaa1111aaaa1111");
      flush();
      assert.deepEqual(measures(), []);
    },
  );
});

test("suspension between readiness and the paint frame drops the record", () => {
  // The reviewer's repro: readiness at t=10ms, final frame at t=20_000ms.
  // Recording here would emit total=20000ms as an ordinary clean switch —
  // App Nap fires no visibilitychange, so the hidden-window guard cannot see
  // it and the frame-gap guard in awaitDeferredCommit has already run.
  assert.equal(resolveFinalFrame(20_000, 10, 0), "drop");
  // A normal paint frame one refresh interval after readiness still records.
  assert.equal(resolveFinalFrame(27, 10, 0), "record");
  // Boundary: exactly the frame-gap cap is still a record; one past it drops.
  assert.equal(resolveFinalFrame(3_010, 10, 0), "record");
  assert.equal(resolveFinalFrame(3_011, 10, 0), "drop");
});

test("the final frame also honors the overall trace age cap", () => {
  // Readiness landed just under the age cap and the paint frame is prompt,
  // so the frame gap is innocent — only the age check can catch this.
  assert.equal(resolveFinalFrame(35_001, 35_000, 0), "drop");
  assert.equal(resolveFinalFrame(35_000, 34_999, 0), "record");
});

// Drives the real settle lifecycle with a controllable clock and rAF queue so
// a stall can be injected at one exact seam. Offsets are rebased above the
// real clock: earlier tests in this file fire visibilitychange, and a trace
// back-dated below those timestamps is (correctly) dropped at settle entry —
// which would make every assertion here vacuous.
function withClockedFrames(run) {
  const frames = [];
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalNow = performance.now;
  const base = originalNow.call(performance) + 1_000;
  let clock = base;
  performance.now = () => clock;
  globalThis.window = {
    requestAnimationFrame: (cb) => frames.push(cb) && frames.length,
    cancelAnimationFrame: () => {},
  };
  globalThis.document = {
    addEventListener: () => {},
    // No pending marker: readiness is reached on the first settle frame.
    querySelector: () => null,
    removeEventListener: () => {},
    visibilityState: "visible",
  };
  performance.clearMeasures?.(CHANNEL_SWITCH_MEASURE);
  const at = (offset) => {
    clock = base + offset;
  };
  const step = (offset) => {
    at(offset);
    for (const cb of frames.splice(0, frames.length)) cb();
  };
  const measures = () =>
    performance.getEntriesByName(CHANNEL_SWITCH_MEASURE).length;
  try {
    run({ at, step, measures });
  } finally {
    performance.now = originalNow;
    resetChannelSwitchTrace();
    performance.clearMeasures?.(CHANNEL_SWITCH_MEASURE);
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
}

test("a stall between readiness and the paint frame records nothing", () => {
  withClockedFrames(({ at, step, measures }) => {
    at(0);
    beginChannelSwitchTrace("aaaa");
    at(10);
    settleChannelSwitchTrace("aaaa");
    // Readiness frame: no pending marker, inside the wait deadline.
    step(10);
    // Process suspended here (App Nap): no visibilitychange fires, so only
    // the final-frame guard can catch it.
    step(20_000);
    assert.equal(measures(), 0, "a 20s suspension must not record a switch");
  });
});

test("a prompt paint frame after readiness still records", () => {
  withClockedFrames(({ at, step, measures }) => {
    at(0);
    beginChannelSwitchTrace("aaaa");
    at(10);
    settleChannelSwitchTrace("aaaa");
    step(10);
    step(26);
    assert.equal(measures(), 1, "the guard must not drop healthy switches");
  });
});

test("a stale caller anchor is discarded rather than charged to the switch", () => {
  // DM flow: anchor captured at the click, open_dm awaited. If the user
  // navigates away during that await, the anchor is no longer this switch's
  // start and would charge unrelated activity to it.
  assert.deepEqual(resolveTraceAnchor(1_000, 500, 30_000), {
    startedAt: 30_000,
    anchorDiscarded: true,
  });
  // Inside the bound: the open_dm round-trip stays in the measurement.
  assert.deepEqual(resolveTraceAnchor(25_000, 500, 30_000), {
    startedAt: 25_000,
    anchorDiscarded: false,
  });
});

test("anchors are never negative, non-finite, or in the future", () => {
  // performance.mark({startTime}) throws on a negative timestamp, and begin()
  // runs inside the click handler — a diagnostic must never break navigation.
  assert.equal(resolveTraceAnchor(-5, 100, 100).startedAt, 0);
  assert.equal(resolveTraceAnchor(Number.NaN, 100, 100).anchorDiscarded, true);
  assert.equal(resolveTraceAnchor(Number.NaN, 100, 100).startedAt, 100);
  // A skewed event clock reporting the future is clamped to now.
  assert.equal(resolveTraceAnchor(200, 100, 100).startedAt, 100);
  // No anchor supplied, and performance was unavailable at capture time.
  assert.equal(resolveTraceAnchor(undefined, Number.NaN, 100).startedAt, 100);
});

test("a truncated settle survives a slow paint frame; a clean one does not", () => {
  // renderWasPending is direct evidence the long frame is a heavy commit, not
  // a suspension — and that measurement is already flagged. Dropping it would
  // discard exactly the pathological switch the instrument exists to expose.
  assert.equal(resolveFinalFrame(3_600, 10, 0, true), "record");
  assert.equal(resolveFinalFrame(3_600, 10, 0, false), "drop");
  // The age cap still applies to both.
  assert.equal(resolveFinalFrame(35_001, 35_000, 0, true), "drop");
});

test("post-paint churn does not keep a settled switch waiting", () => {
  // Nothing pending: ready, regardless of generations.
  assert.equal(resolveRenderReadiness(false, 4, 4), true);
  // Pending and the timeline has not committed since settle entry: the
  // switch's own rows are still unpainted, so keep waiting.
  assert.equal(resolveRenderReadiness(true, 4, 4), false);
  // Pending, but the timeline committed past the generation painted at settle
  // entry: the rows are on screen and this marker belongs to live traffic
  // that arrived afterwards. Recording the burst would inflate the switch.
  assert.equal(resolveRenderReadiness(true, 4, 5), true);
  // No timeline mounted (Suspense fallback still up): the pending marker is
  // the fallback's own, and there is nothing painted yet to be ready.
  assert.equal(resolveRenderReadiness(true, null, null), false);
  assert.equal(resolveRenderReadiness(true, 4, null), false);
});

// --- Drop accounting: no measurement disappears without a record -----------

function withDropCapture(run) {
  const drops = [];
  const originalInfo = console.info;
  console.info = (line) => {
    if (typeof line === "string" && line.includes("dropped reason=")) {
      drops.push(line.slice(line.indexOf("dropped reason=") + 15));
    }
  };
  try {
    run(drops);
  } finally {
    console.info = originalInfo;
    resetChannelSwitchTrace();
  }
}

test("an impatient second click accounts for the trace it supersedes", () => {
  withClockedFrames(({ at }) => {
    withDropCapture((drops) => {
      at(0);
      beginChannelSwitchTrace("aaaa");
      at(400);
      // The user gave up on A and clicked B. A's trace is gone — and A being
      // slow is exactly why they clicked again, so a silent discard censors
      // the switches worth measuring.
      beginChannelSwitchTrace("bbbb");
      assert.deepEqual(drops, ["superseded"]);
    });
  });
});

test("a community reset accounts for the trace it clears", () => {
  withClockedFrames(({ at }) => {
    withDropCapture((drops) => {
      at(0);
      beginChannelSwitchTrace("aaaa");
      resetChannelSwitchTrace();
      assert.deepEqual(drops, ["community-reset"]);
    });
  });
});

test("an unobservable surface accounts for its abandon", () => {
  withClockedFrames(({ at }) => {
    withDropCapture((drops) => {
      at(0);
      beginChannelSwitchTrace("aaaa");
      abandonChannelSwitchTrace("aaaa");
      assert.deepEqual(drops, ["unobservable-surface"]);
    });
  });
});

test("a timed-out settle accounts for the drop", () => {
  withClockedFrames(({ at, measures }) => {
    withDropCapture((drops) => {
      at(0);
      beginChannelSwitchTrace("aaaa");
      at(31_000);
      settleChannelSwitchTrace("aaaa");
      assert.deepEqual(drops, ["timeout"]);
      assert.equal(measures(), 0);
    });
  });
});

test("route-exit abandon respects hash-history routes", async () => {
  // The app uses createHashHistory, so the route lives in location.hash.
  // Reading location.pathname made this guard answer false for every real
  // channel route, degrading it to an unconditional abandon.
  const drops = [];
  const originalInfo = console.info;
  const originalWindow = globalThis.window;
  const originalNow = performance.now;
  const base = originalNow.call(performance) + 1_000;
  performance.now = () => base;
  console.info = (line) => {
    if (typeof line === "string" && line.includes("dropped reason=")) {
      drops.push(line.slice(line.indexOf("dropped reason=") + 15));
    }
  };
  globalThis.window = {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    location: { pathname: "/index.html", hash: "#/channels/aaaa" },
  };
  try {
    beginChannelSwitchTrace("aaaa");
    scheduleRouteExitAbandon("aaaa");
    await Promise.resolve();
    assert.deepEqual(drops, [], "the route still points at this channel");

    // A real exit still abandons.
    globalThis.window.location.hash = "#/projects";
    scheduleRouteExitAbandon("aaaa");
    await Promise.resolve();
    assert.deepEqual(drops, ["route-exit"]);
  } finally {
    console.info = originalInfo;
    performance.now = originalNow;
    resetChannelSwitchTrace();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
