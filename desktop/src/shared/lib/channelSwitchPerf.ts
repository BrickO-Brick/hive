/**
 * Channel-switch timing: click → route commit → settled paint, plus the
 * message-window fetch when it lands inside that interval.
 *
 * Deliberately small. One trace is active at a time; `beginChannelSwitchTrace`
 * (from `goChannel`, via `commitGuardedNavigation`) opens it and
 * `settleChannelSwitchTrace` closes it one paint after the channel's timeline
 * leaves its loading latch. Output is a `[switch-perf]` console line plus User
 * Timing marks and measures (`buzz:channel-switch:*`) — the Performance panel
 * and the Playwright perf harness read the same numbers. Nothing is persisted.
 *
 * The honesty bounds below are chosen rather than inferred. Every extra
 * inference this instrument tried to make became a way to report a number that
 * never happened, so the scope is narrow on purpose:
 * - Only navigations that reach `goChannel` are traced. History back/forward
 *   and re-selecting the active channel are not.
 * - The interval starts at the navigation, anchored to the triggering input
 *   event when one is dispatching. Callers that await before navigating (DM
 *   actions await `open_dm`) exclude that await by design.
 * - A trace overlapping a hidden window is dropped, never measured: rAF
 *   suspends and network throttles while hidden, so elapsed time there is not
 *   the user's switch.
 * - The settle waits a bounded number of frames for a pending render. Past
 *   that bound the measure is still emitted, flagged `settleWaitTruncated` —
 *   a slow switch is data, not an error.
 * - Every abandoned trace prints why. Drops correlate with slow switches, so a
 *   silent drop would make "no switches" and "switches discarded" look alike.
 */

export type ChannelSwitchTrace = {
  channelId: string;
  startedAt: number;
  routeCommitAt: number | null;
  windowFetch: { durationMs: number; eventCount: number } | null;
  /** Set when the timeline reports settled; bounds fetch attribution. */
  settleEnteredAt: number | null;
};

/** A switch that hasn't settled after this long is abandoned, not measured. */
const SWITCH_TRACE_TIMEOUT_MS = 30_000;

/**
 * Frames the settle waits for a pending render before recording anyway.
 * Bounded in frames rather than milliseconds so a stalled main thread cannot
 * stretch the wait into the measurement.
 */
const MAX_SETTLE_FRAMES = 30;

export const CHANNEL_SWITCH_START_MARK = "buzz:channel-switch:start";
export const CHANNEL_SWITCH_SETTLED_MARK = "buzz:channel-switch:settled";
export const CHANNEL_SWITCH_MEASURE = "buzz:channel-switch:click-to-settled";

/**
 * Repo-wide marker for "a deferred commit is in flight", set by the message
 * timeline and by the lazy channel pane's fallback. Other components use it
 * too, so the settle wait is bounded in frames rather than trusting it to
 * clear: a foreign owner can extend a switch by at most MAX_SETTLE_FRAMES,
 * and that sample is flagged `settleWaitTruncated`.
 */
const RENDER_PENDING_SELECTOR = '[data-render-pending="true"]';

let activeTrace: ChannelSwitchTrace | null = null;

/** Formats one settled trace as the `[switch-perf]` console line. */
export function summarizeChannelSwitchTrace(
  trace: ChannelSwitchTrace,
  settledAt: number,
  settleWaitTruncated = false,
): string {
  const total = Math.round(settledAt - trace.startedAt);
  const commit =
    trace.routeCommitAt === null
      ? "?"
      : `+${Math.round(trace.routeCommitAt - trace.startedAt)}ms`;
  const window =
    trace.windowFetch === null
      ? "cache"
      : `${trace.windowFetch.eventCount} events in ${Math.round(trace.windowFetch.durationMs)}ms`;
  return (
    `[switch-perf] channel=${trace.channelId.slice(0, 8)} total=${total}ms ` +
    `commit=${commit} window=${window}` +
    (settleWaitTruncated ? " settle=truncated" : "")
  );
}

function dropTrace(trace: ChannelSwitchTrace, reason: string): void {
  console.info(
    `[switch-perf] channel=${trace.channelId.slice(0, 8)} dropped (${reason})`,
  );
  if (activeTrace === trace) activeTrace = null;
}

/**
 * Timestamp of the most recent visibilitychange. Any transition inside a trace
 * window means an off-screen interval overlaps the measurement. One listener
 * per document (tests swap documents).
 */
let lastVisibilityChangeAt = Number.NEGATIVE_INFINITY;
const watchedDocuments = new WeakSet<object>();

function ensureVisibilityWatcher(): void {
  if (typeof document === "undefined" || !document.addEventListener) return;
  if (watchedDocuments.has(document)) return;
  watchedDocuments.add(document);
  document.addEventListener("visibilitychange", () => {
    lastVisibilityChangeAt = performance.now();
  });
}

function overlapsHiddenWindow(trace: ChannelSwitchTrace): boolean {
  return (
    document.visibilityState === "hidden" ||
    lastVisibilityChangeAt >= trace.startedAt
  );
}

function clearSwitchEntries(): void {
  performance.clearMarks(CHANNEL_SWITCH_START_MARK);
  performance.clearMarks(CHANNEL_SWITCH_SETTLED_MARK);
  performance.clearMeasures(CHANNEL_SWITCH_MEASURE);
}

export function beginChannelSwitchTrace(channelId: string): void {
  if (typeof performance === "undefined") return;
  ensureVisibilityWatcher();
  if (activeTrace) dropTrace(activeTrace, "superseded");
  // Anchor at the triggering input event when one is dispatching: a click can
  // sit queued behind a long task before its handler runs, and that input
  // delay is felt switch latency. window.event is set only during synchronous
  // dispatch, so a stale timestamp cannot leak in from an async continuation.
  // min() guards a skewed event clock; max() keeps the mark non-negative,
  // which performance.mark requires.
  const now = performance.now();
  const dispatching = typeof window === "undefined" ? undefined : window.event;
  const startedAt =
    dispatching && typeof dispatching.timeStamp === "number"
      ? Math.max(0, Math.min(dispatching.timeStamp, now))
      : now;
  activeTrace = {
    channelId,
    startedAt,
    routeCommitAt: null,
    windowFetch: null,
    settleEnteredAt: null,
  };
  // Clear the previous switch here, not only on record: traces that die
  // without recording never reach record()'s clearing, and a consumer polling
  // the buffer mid-switch must never read the previous switch's entries.
  clearSwitchEntries();
  // startTime keeps the mark on the same anchor as the measure.
  performance.mark(CHANNEL_SWITCH_START_MARK, {
    detail: { channelId },
    startTime: startedAt,
  });
}

export function markChannelSwitchRouteCommit(channelId: string): void {
  if (typeof performance === "undefined") return;
  if (!activeTrace || activeTrace.channelId !== channelId) return;
  if (activeTrace.routeCommitAt !== null) return;
  activeTrace.routeCommitAt = performance.now();
}

/**
 * A fetch attributes to the active trace only when it targets the traced
 * channel and started inside the measured interval. A fetch that started
 * before the switch (the first leg of a rapid A→B→A completing during the
 * second A trace) is not this switch's cost, and letting it claim the slot
 * would block the real fetch. A fetch that started after the timeline settled
 * is background revalidation the user never waited on. Pure for unit testing.
 */
export function shouldAttributeFetch(
  trace: ChannelSwitchTrace | null,
  channelId: string,
  fetchStartedAt: number,
): trace is ChannelSwitchTrace {
  if (!trace || trace.channelId !== channelId) return false;
  if (fetchStartedAt < trace.startedAt) return false;
  return (
    trace.settleEnteredAt === null || fetchStartedAt <= trace.settleEnteredAt
  );
}

export function traceChannelWindowFetch(
  channelId: string,
  eventCount: number,
  durationMs: number,
  fetchStartedAt: number,
): void {
  if (!shouldAttributeFetch(activeTrace, channelId, fetchStartedAt)) return;
  activeTrace.windowFetch ??= { durationMs, eventCount };
}

/**
 * Drops the active trace for surfaces whose readiness this instrument cannot
 * observe (forum channels, whose loading ForumView owns). Better no
 * measurement than a systematically underreported one.
 */
export function abandonChannelSwitchTrace(channelId: string): void {
  if (activeTrace?.channelId === channelId) {
    dropTrace(activeTrace, "unobservable surface");
  }
}

/**
 * Abandons whatever trace is active, regardless of channel. Called when
 * navigation leaves the channel surface (any committed non-channel
 * destination, any history traversal): a trace can be live with no channel
 * screen mounted at all — the route still resolving — so this is the only
 * reliable exit hook, and a later untraced re-entry would otherwise settle it
 * with the time spent away.
 */
export function dropActiveChannelSwitchTrace(): void {
  if (activeTrace) dropTrace(activeTrace, "left channel surface");
}

/** Community switch (and test reset): nothing survives into the next one. */
export function resetChannelSwitchTrace(): void {
  if (activeTrace) dropTrace(activeTrace, "community reset");
  activeTrace = null;
  lastVisibilityChangeAt = Number.NEGATIVE_INFINITY;
  if (typeof performance !== "undefined") clearSwitchEntries();
}

/**
 * Decides what a settle call does with the active trace. A settle for a
 * different channel must leave the trace alone — a previous channel can finish
 * loading after the next switch began, and clobbering the newer trace would
 * drop exactly the rapid switches worth capturing. Pure for unit testing.
 */
export function resolveSettleAction(
  trace: ChannelSwitchTrace | null,
  channelId: string,
  now: number,
): { settledTrace: ChannelSwitchTrace | null; timedOut: boolean } {
  if (!trace || trace.channelId !== channelId) {
    return { settledTrace: null, timedOut: false };
  }
  if (now - trace.startedAt > SWITCH_TRACE_TIMEOUT_MS) {
    return { settledTrace: null, timedOut: true };
  }
  return { settledTrace: trace, timedOut: false };
}

/**
 * Closes the active trace once the settled frame has painted. The timeline
 * exposes `data-render-pending` until its deferred commit catches up,
 * and the lazy channel pane's fallback carries the same marker while its chunk
 * loads; waiting for both (bounded) keeps `totalMs` honest on render-heavy and
 * cold-chunk switches. A final frame then lands the mark after the paint.
 */
export function settleChannelSwitchTrace(channelId: string): void {
  if (typeof performance === "undefined") return;
  const { settledTrace, timedOut } = resolveSettleAction(
    activeTrace,
    channelId,
    performance.now(),
  );
  if (!settledTrace) {
    if (timedOut && activeTrace) dropTrace(activeTrace, "timed out");
    return;
  }
  const trace = settledTrace;
  // These globals gate the whole settle path: the wait loop reads
  // document.visibilityState, querySelector and rAF unguarded past this point.
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    !window.requestAnimationFrame
  ) {
    dropTrace(trace, "no DOM");
    return;
  }
  ensureVisibilityWatcher();
  if (overlapsHiddenWindow(trace)) {
    dropTrace(trace, "hidden window");
    return;
  }
  // Idempotent: a second settle for this channel must not restart the wait or
  // move the fetch-attribution bound.
  if (trace.settleEnteredAt !== null) return;
  trace.settleEnteredAt = performance.now();
  // Bind once — reading the ambient global on every frame would follow a
  // swapped-out window and throw from inside a callback nothing can catch.
  const schedule = window.requestAnimationFrame.bind(window);

  const record = (settleWaitTruncated: boolean) => {
    const settledAt = performance.now();
    if (activeTrace === trace) activeTrace = null;
    // Keep only the latest switch in the User Timing buffer: desktop sessions
    // run for weeks and the buffer is never GC'd.
    clearSwitchEntries();
    performance.mark(CHANNEL_SWITCH_SETTLED_MARK, {
      detail: { channelId },
      startTime: settledAt,
    });
    performance.measure(CHANNEL_SWITCH_MEASURE, {
      detail: {
        channelId,
        routeCommitAt: trace.routeCommitAt,
        windowFetch: trace.windowFetch,
        ...(settleWaitTruncated ? { settleWaitTruncated: true } : {}),
      },
      start: trace.startedAt,
      end: settledAt,
    });
    console.info(
      summarizeChannelSwitchTrace(trace, settledAt, settleWaitTruncated),
    );
  };

  let framesWaited = 0;
  const awaitPaint = () => {
    // A newer switch replaced this trace, or a reset dropped it. Either way
    // the paint this callback would sample is not this switch's own.
    if (activeTrace !== trace) return;
    if (overlapsHiddenWindow(trace)) {
      dropTrace(trace, "hidden window");
      return;
    }
    const pending = document.querySelector(RENDER_PENDING_SELECTOR) !== null;
    if (pending && framesWaited < MAX_SETTLE_FRAMES) {
      framesWaited += 1;
      schedule(awaitPaint);
      return;
    }
    // One more frame so the mark lands after the browser paints.
    schedule(() => {
      if (activeTrace !== trace) return;
      if (overlapsHiddenWindow(trace)) {
        dropTrace(trace, "hidden window");
        return;
      }
      record(pending);
    });
  };
  schedule(awaitPaint);
}
