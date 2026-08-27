import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEL_SWITCH_MEASURE,
  CHANNEL_SWITCH_START_MARK,
  abandonChannelSwitchTrace,
  beginChannelSwitchTrace,
  dropActiveChannelSwitchTrace,
  markChannelSwitchRouteCommit,
  resetChannelSwitchTrace,
  resolveSettleAction,
  settleChannelSwitchTrace,
  shouldAttributeFetch,
  summarizeChannelSwitchTrace,
  traceChannelWindowFetch,
} from "./channelSwitchPerf.ts";

function trace(overrides = {}) {
  return {
    channelId: "abcdef1234567890",
    startedAt: 1_000,
    routeCommitAt: null,
    windowFetch: null,
    settleEnteredAt: null,
    ...overrides,
  };
}

// --- Pure helpers ---------------------------------------------------------

test("summary reports total, commit offset and cache-served fetches", () => {
  assert.equal(
    summarizeChannelSwitchTrace(trace({ routeCommitAt: 1_200 }), 1_412.4),
    "[switch-perf] channel=abcdef12 total=412ms commit=+200ms window=cache",
  );
});

test("summary reports an attributed fetch and the truncation flag", () => {
  assert.equal(
    summarizeChannelSwitchTrace(
      trace({ windowFetch: { durationMs: 307.2, eventCount: 89 } }),
      1_739,
      true,
    ),
    "[switch-perf] channel=abcdef12 total=739ms commit=? " +
      "window=89 events in 307ms settle=truncated",
  );
});

test("a settle for another channel leaves the active trace alone", () => {
  // A previous channel can finish loading after the next switch began;
  // clobbering the newer trace would drop exactly the rapid switches worth
  // capturing.
  const active = trace();
  assert.deepEqual(resolveSettleAction(active, "bbbb0000bbbb0000", 1_100), {
    settledTrace: null,
    timedOut: false,
  });
  assert.deepEqual(resolveSettleAction(null, "abcdef1234567890", 1_100), {
    settledTrace: null,
    timedOut: false,
  });
});

test("a settle past the timeout reports the trace as timed out", () => {
  const stale = trace({ startedAt: 1_000 });
  assert.deepEqual(resolveSettleAction(stale, "abcdef1234567890", 31_001), {
    settledTrace: null,
    timedOut: true,
  });
  assert.equal(
    resolveSettleAction(stale, "abcdef1234567890", 11_000).settledTrace,
    stale,
  );
});

test("fetches attribute only inside the measured interval", () => {
  const active = trace({ startedAt: 1_000 });
  // Started before the switch (a stale A→B→A leg): not this switch's cost,
  // and it would occupy the one-shot slot the real fetch needs.
  assert.equal(shouldAttributeFetch(active, "abcdef1234567890", 999), false);
  assert.equal(shouldAttributeFetch(active, "abcdef1234567890", 1_000), true);
  // Other channel or no trace: never.
  assert.equal(shouldAttributeFetch(active, "bbbb0000bbbb0000", 1_500), false);
  assert.equal(shouldAttributeFetch(null, "abcdef1234567890", 1_500), false);
  // Started after the timeline settled: background revalidation the user never
  // waited on. The trace is still active while it waits for the paint.
  const settling = trace({ startedAt: 1_000, settleEnteredAt: 2_000 });
  assert.equal(shouldAttributeFetch(settling, "abcdef1234567890", 1_999), true);
  assert.equal(
    shouldAttributeFetch(settling, "abcdef1234567890", 2_001),
    false,
  );
});

// --- Lifecycle ------------------------------------------------------------

/**
 * Drives the real lifecycle with a manual frame queue, a virtual clock and a
 * controllable pending marker. The clock is rebased above the real one so a
 * visibilitychange fired by an earlier test cannot silently drop every trace
 * at settle entry and make these assertions vacuous.
 */
function withHarness(run) {
  const frames = [];
  const drops = [];
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalNow = performance.now;
  const originalInfo = console.info;
  const base = originalNow.call(performance) + 1_000;
  let clock = base;
  let pending = false;
  performance.now = () => clock;
  console.info = (line) => {
    if (typeof line === "string" && line.includes("dropped (")) {
      drops.push(line.slice(line.indexOf("dropped (") + 9, -1));
    }
  };
  globalThis.window = {
    requestAnimationFrame: (cb) => frames.push(cb) && frames.length,
    cancelAnimationFrame: () => {},
  };
  globalThis.document = {
    addEventListener: () => {},
    querySelector: () => (pending ? {} : null),
    removeEventListener: () => {},
    visibilityState: "visible",
  };
  performance.clearMeasures?.(CHANNEL_SWITCH_MEASURE);
  const api = {
    drops,
    at: (offset) => {
      clock = base + offset;
    },
    setPending: (value) => {
      pending = value;
    },
    hide: () => {
      globalThis.document.visibilityState = "hidden";
    },
    flush: (rounds = 40) => {
      for (let i = 0; i < rounds && frames.length > 0; i += 1) {
        for (const cb of frames.splice(0, frames.length)) cb();
      }
    },
    measures: () =>
      performance
        .getEntriesByName(CHANNEL_SWITCH_MEASURE)
        .map((entry) => entry.detail?.channelId),
    lastMeasure: () =>
      performance.getEntriesByName(CHANNEL_SWITCH_MEASURE).at(-1),
  };
  try {
    run(api);
  } finally {
    performance.now = originalNow;
    console.info = originalInfo;
    resetChannelSwitchTrace();
    performance.clearMeasures?.(CHANNEL_SWITCH_MEASURE);
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
}

test("an undisturbed switch records exactly one measure", () => {
  withHarness(({ at, flush, measures, lastMeasure }) => {
    at(0);
    beginChannelSwitchTrace("aaaa");
    at(20);
    markChannelSwitchRouteCommit("aaaa");
    at(120);
    settleChannelSwitchTrace("aaaa");
    flush();
    assert.deepEqual(measures(), ["aaaa"]);
    assert.notEqual(lastMeasure().detail.routeCommitAt, null);
    assert.equal(lastMeasure().detail.settleWaitTruncated, undefined);
  });
});

test("the settle waits for a pending render, then truncates rather than hangs", () => {
  withHarness(({ at, flush, setPending, measures, lastMeasure }) => {
    at(0);
    beginChannelSwitchTrace("aaaa");
    setPending(true);
    at(50);
    settleChannelSwitchTrace("aaaa");
    // The marker never clears: the wait is bounded in frames, and the sample
    // is reported flagged rather than discarded — a slow switch is data.
    flush();
    assert.deepEqual(measures(), ["aaaa"]);
    assert.equal(lastMeasure().detail.settleWaitTruncated, true);
  });
});

test("a switch that paints mid-wait records without the truncation flag", () => {
  withHarness(({ at, flush, setPending, lastMeasure }) => {
    at(0);
    beginChannelSwitchTrace("aaaa");
    setPending(true);
    at(50);
    settleChannelSwitchTrace("aaaa");
    flush(2);
    setPending(false);
    flush();
    assert.equal(lastMeasure().detail.settleWaitTruncated, undefined);
  });
});

test("a superseding switch discards the first trace, with a reason", () => {
  withHarness(({ at, flush, drops, measures }) => {
    at(0);
    beginChannelSwitchTrace("aaaa");
    at(400);
    // The user gave up on A and clicked B. A being slow is exactly why they
    // clicked again, so a silent discard censors the switches worth seeing.
    beginChannelSwitchTrace("bbbb");
    settleChannelSwitchTrace("aaaa");
    flush();
    assert.deepEqual(drops, ["superseded"]);
    assert.deepEqual(measures(), []);
  });
});

test("a hidden window drops the trace instead of recording the absence", () => {
  withHarness(({ at, flush, hide, drops, measures }) => {
    at(0);
    beginChannelSwitchTrace("aaaa");
    hide();
    at(9_000);
    settleChannelSwitchTrace("aaaa");
    flush();
    assert.deepEqual(drops, ["hidden window"]);
    assert.deepEqual(measures(), []);
  });
});

test("a timed-out switch is dropped, with a reason", () => {
  withHarness(({ at, flush, drops, measures }) => {
    at(0);
    beginChannelSwitchTrace("aaaa");
    at(31_000);
    settleChannelSwitchTrace("aaaa");
    flush();
    assert.deepEqual(drops, ["timed out"]);
    assert.deepEqual(measures(), []);
  });
});

test("leaving the channel surface and forum surfaces drop with a reason", () => {
  withHarness(({ at, drops }) => {
    at(0);
    beginChannelSwitchTrace("aaaa");
    dropActiveChannelSwitchTrace();
    at(10);
    beginChannelSwitchTrace("bbbb");
    abandonChannelSwitchTrace("bbbb");
    assert.deepEqual(drops, ["left channel surface", "unobservable surface"]);
  });
});

test("a second settle neither restarts the wait nor moves the fetch bound", () => {
  withHarness(({ at, flush, measures }) => {
    at(0);
    beginChannelSwitchTrace("aaaa");
    at(50);
    settleChannelSwitchTrace("aaaa");
    at(60);
    settleChannelSwitchTrace("aaaa");
    flush();
    assert.deepEqual(measures(), ["aaaa"]);
  });
});

test("an attributed window fetch reaches the measure", () => {
  withHarness(({ at, flush, lastMeasure }) => {
    at(0);
    beginChannelSwitchTrace("aaaa");
    traceChannelWindowFetch("aaaa", 89, 307, performance.now());
    at(120);
    settleChannelSwitchTrace("aaaa");
    flush();
    assert.deepEqual(lastMeasure().detail.windowFetch, {
      durationMs: 307,
      eventCount: 89,
    });
  });
});

test("beginning a switch clears the previous switch's entries", () => {
  withHarness(({ at, flush, measures }) => {
    at(0);
    beginChannelSwitchTrace("aaaa");
    at(100);
    settleChannelSwitchTrace("aaaa");
    flush();
    assert.deepEqual(measures(), ["aaaa"]);
    // A consumer polling the buffer mid-switch must never read the previous
    // switch's measure as the current one's.
    at(200);
    beginChannelSwitchTrace("bbbb");
    assert.deepEqual(measures(), []);
  });
});

test("the start mark shares the measure's anchor", () => {
  withHarness(({ at, flush }) => {
    at(0);
    beginChannelSwitchTrace("aaaa");
    const startMark = performance
      .getEntriesByName(CHANNEL_SWITCH_START_MARK)
      .at(-1);
    at(100);
    settleChannelSwitchTrace("aaaa");
    flush();
    const measure = performance.getEntriesByName(CHANNEL_SWITCH_MEASURE).at(-1);
    // Without a shared anchor the Performance panel shows the measure
    // starting before its own start mark.
    assert.equal(startMark.startTime, measure.startTime);
  });
});
