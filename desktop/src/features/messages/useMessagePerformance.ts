import * as React from "react";
import {
  CHANNEL_ROWS_PAINTED_MARK,
  CHANNEL_ROWS_PAINTED_MEASURE,
  CHANNEL_RESIZE_OBSERVER_CALLBACK_MARK,
  CHANNEL_SCROLL_WRITE_MARK,
  CHANNEL_SWITCH_START_MARK,
  CHANNEL_VIRTUALIZER_CALLBACK_MARK,
  CHANNEL_VIEWPORT_SETTLED_MARK,
  CHANNEL_VIEWPORT_SETTLED_MEASURE,
  THREAD_OPEN_START_MARK,
  THREAD_REPLIES_PAINTED_MARK,
  THREAD_REPLIES_PAINTED_MEASURE,
  THREAD_VIEWPORT_SETTLED_MARK,
  THREAD_VIEWPORT_SETTLED_MEASURE,
  finishPerformanceMeasure,
  startPerformanceMark,
  subscribePerformanceMark,
} from "@/features/messages/lib/messagePerformance";
import type { TimelineMessage } from "@/features/messages/types";
const CHANNEL_EVIDENCE = [
  CHANNEL_VIRTUALIZER_CALLBACK_MARK,
  CHANNEL_RESIZE_OBSERVER_CALLBACK_MARK,
  CHANNEL_SCROLL_WRITE_MARK,
] as const;
export function markChannelSelectionPerformance(
  channelId: string,
  activeChannelId?: string | null,
): void {
  if (channelId !== activeChannelId)
    startPerformanceMark(CHANNEL_SWITCH_START_MARK, channelId);
}
export function useMeasuredOpenThread(
  openId: string | null,
  onOpen: (message: TimelineMessage) => void,
): (message: TimelineMessage) => void {
  return React.useCallback(
    (message) => {
      if (message.id !== openId)
        startPerformanceMark(THREAD_OPEN_START_MARK, message.id);
      onOpen(message);
    },
    [onOpen, openId],
  );
}
function usePaint(input: {
  identity: string | null;
  count: number;
  start: string;
  end: string;
  measure: string;
}): void {
  const measured = React.useRef(-1);
  React.useEffect(() => {
    if (!input.identity || !input.count) return;
    const frame = requestAnimationFrame(() => {
      const value = finishPerformanceMeasure({
        startMark: input.start,
        endMark: input.end,
        measure: input.measure,
        identity: input.identity as string,
        detail: { rowCount: input.count },
      });
      if (value !== null && value !== measured.current)
        measured.current = value;
    });
    return () => cancelAnimationFrame(frame);
  }, [input.count, input.end, input.identity, input.measure, input.start]);
}
export function useChannelRowsPaintedPerformanceMeasure(
  channelId: string | null,
  count: number,
): void {
  usePaint({
    identity: channelId,
    count,
    start: CHANNEL_SWITCH_START_MARK,
    end: CHANNEL_ROWS_PAINTED_MARK,
    measure: CHANNEL_ROWS_PAINTED_MEASURE,
  });
}
export function useThreadRepliesPaintedPerformanceMeasure(
  threadId: string | null,
  count: number,
): void {
  usePaint({
    identity: threadId,
    count,
    start: THREAD_OPEN_START_MARK,
    end: THREAD_REPLIES_PAINTED_MARK,
    measure: THREAD_REPLIES_PAINTED_MEASURE,
  });
}
function useSettle(input: {
  identity: string | null;
  ready: boolean;
  version: number;
  evidence?: readonly string[];
  start: string;
  end: string;
  measure: string;
}): void {
  const [evidenceVersion, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(
    () =>
      input.evidence?.length
        ? subscribePerformanceMark(input.evidence, bump)
        : undefined,
    [input.evidence],
  );
  React.useEffect(() => {
    void evidenceVersion;
    void input.version;
    if (!input.identity || !input.ready) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() =>
        finishPerformanceMeasure({
          startMark: input.start,
          endMark: input.end,
          measure: input.measure,
          identity: input.identity as string,
        }),
      );
    });
    return () => {
      cancelAnimationFrame(first);
      if (second) cancelAnimationFrame(second);
    };
  }, [
    evidenceVersion,
    input.end,
    input.identity,
    input.measure,
    input.ready,
    input.start,
    input.version,
  ]);
}
export function useChannelViewportSettledPerformanceMeasure(input: {
  channelId: string | null;
  ready: boolean;
  settleVersion: number;
}): void {
  useSettle({
    identity: input.channelId,
    ready: input.ready,
    version: input.settleVersion,
    evidence: CHANNEL_EVIDENCE,
    start: CHANNEL_SWITCH_START_MARK,
    end: CHANNEL_VIEWPORT_SETTLED_MARK,
    measure: CHANNEL_VIEWPORT_SETTLED_MEASURE,
  });
}
export function useThreadSettleVersion(
  bodyRef: React.RefObject<HTMLElement | null>,
): number {
  const [version, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const observer = new ResizeObserver(bump);
    body.addEventListener("scroll", bump, { passive: true });
    observer.observe(body);
    return () => {
      observer.disconnect();
      body.removeEventListener("scroll", bump);
    };
  }, [bodyRef]);
  return version;
}
export function useThreadViewportSettledPerformanceMeasure(input: {
  ready: boolean;
  settleVersion: number;
  threadHeadId: string | null;
}): void {
  useSettle({
    identity: input.threadHeadId,
    ready: input.ready,
    version: input.settleVersion,
    start: THREAD_OPEN_START_MARK,
    end: THREAD_VIEWPORT_SETTLED_MARK,
    measure: THREAD_VIEWPORT_SETTLED_MEASURE,
  });
}
export function useThreadPerformance(input: {
  bodyRef: React.RefObject<HTMLElement | null>;
  ready: boolean;
  replyCount: number;
  threadHeadId: string | null;
}): void {
  useThreadRepliesPaintedPerformanceMeasure(
    input.threadHeadId,
    input.replyCount,
  );
  useThreadViewportSettledPerformanceMeasure({
    ready: input.ready,
    settleVersion: useThreadSettleVersion(input.bodyRef),
    threadHeadId: input.threadHeadId,
  });
}
