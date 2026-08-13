export const CHANNEL_SWITCH_START_MARK = "buzz:channel-switch:start";
export const CHANNEL_ROWS_PAINTED_MARK = "buzz:channel-switch:rows-painted";
export const CHANNEL_ROWS_PAINTED_MEASURE =
  "buzz:channel-switch:rows-painted-duration";
export const CHANNEL_VIEWPORT_SETTLED_MARK =
  "buzz:channel-switch:viewport-settled";
export const CHANNEL_VIEWPORT_SETTLED_MEASURE =
  "buzz:channel-switch:viewport-settled-duration";
export const CHANNEL_VIRTUALIZER_CALLBACK_MARK =
  "buzz:channel-switch:virtualizer-callback";
export const CHANNEL_RESIZE_OBSERVER_CALLBACK_MARK =
  "buzz:channel-switch:resize-observer-callback";
export const CHANNEL_SCROLL_WRITE_MARK = "buzz:channel-switch:scroll-write";
export const THREAD_OPEN_START_MARK = "buzz:thread-open:start";
export const THREAD_REPLIES_PAINTED_MARK = "buzz:thread-open:replies-painted";
export const THREAD_REPLIES_PAINTED_MEASURE =
  "buzz:thread-open:replies-painted-duration";
export const THREAD_VIEWPORT_SETTLED_MARK = "buzz:thread-open:viewport-settled";
export const THREAD_VIEWPORT_SETTLED_MEASURE =
  "buzz:thread-open:viewport-settled-duration";

const listeners = new Map<string, Set<() => void>>();
export function subscribePerformanceMark(
  names: readonly string[],
  listener: () => void,
): () => void {
  for (const name of names) {
    const current = listeners.get(name) ?? new Set();
    current.add(listener);
    listeners.set(name, current);
  }
  return () => {
    for (const name of names) listeners.get(name)?.delete(listener);
  };
}
export function startPerformanceMark(
  name: string,
  identity: string,
  detail?: Record<string, unknown>,
): void {
  performance.mark(name, { detail: { ...detail, identity } });
}
export function recordPerformanceMark(
  name: string,
  detail?: Record<string, unknown>,
): void {
  const current = listeners.get(name);
  // Callback evidence exists only while a settle measurement is active. This
  // keeps normal scrolling/resizing from filling the User Timing buffer or
  // doing instrumentation work for the rest of the session.
  if (!current?.size) return;
  performance.mark(name, detail ? { detail } : undefined);
  for (const listener of current) listener();
}
export function finishPerformanceMeasure(input: {
  startMark: string;
  endMark: string;
  measure: string;
  identity: string;
  detail?: Record<string, unknown>;
}): number | null {
  const start = [...performance.getEntriesByName(input.startMark, "mark")]
    .reverse()
    .find(
      (entry) => (entry as PerformanceMark).detail?.identity === input.identity,
    );
  if (!start) return null;
  performance.mark(input.endMark, {
    detail: { ...input.detail, identity: input.identity },
  });
  const end = performance.getEntriesByName(input.endMark, "mark").at(-1);
  if (!end) return null;
  performance.measure(input.measure, {
    start: start.startTime,
    end: end.startTime,
    detail: { ...input.detail, identity: input.identity },
  });
  return start.startTime;
}
