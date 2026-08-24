import type { TimelineMessageDelta } from "@/features/messages/lib/timelineSnapshot";

export function getPinnedCenterDrift({
  contentTop,
  currentContentTop,
}: {
  contentTop: number;
  currentContentTop: number;
}): number | null {
  const drift = currentContentTop - contentTop;
  return Math.abs(drift) > 0.5 ? drift : null;
}

export function shouldIgnorePinnedCenterScroll({
  currentScrollTop,
  expectedScrollTop,
  isWritingScroll,
}: {
  currentScrollTop: number;
  expectedScrollTop: number | null;
  isWritingScroll: boolean;
}): boolean {
  return isWritingScroll || expectedScrollTop === currentScrollTop;
}

// Programmatic bottom pins require the physical floor, not merely the looser
// UI at-bottom threshold used for unread affordances.
const TRUE_BOTTOM_THRESHOLD_PX = 1;

type BottomSettleContainer = Pick<
  HTMLDivElement,
  "scrollHeight" | "clientHeight" | "scrollTop" | "scrollTo"
>;

export function settleProgrammaticBottomPin(
  container: BottomSettleContainer,
): boolean {
  container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
  return (
    container.scrollHeight - container.clientHeight - container.scrollTop <=
    TRUE_BOTTOM_THRESHOLD_PX
  );
}

export function resolveTimelineVisibleReadAt(
  messages: readonly { createdAt: number; parentId?: string | null }[],
): number | null {
  let latest: number | null = null;
  for (const message of messages) {
    if (message.parentId != null) continue;
    latest =
      latest === null ? message.createdAt : Math.max(latest, message.createdAt);
  }
  return latest;
}

export function resolveTimelineReadPresence({
  isPhysicallyAtBottom: _isPhysicallyAtBottom,
  isSemanticallyAtBottom,
}: {
  isPhysicallyAtBottom: boolean;
  isSemanticallyAtBottom: boolean;
}): boolean {
  // A buffered timeline can shorten the rendered model enough that the
  // virtualizer reports its physical floor while newer messages remain hidden.
  return isSemanticallyAtBottom;
}

export function shouldSettleForSplitPanel({
  isAtBottom,
  splitPanelOpen,
}: {
  isAtBottom: boolean;
  splitPanelOpen: boolean;
}): boolean {
  return isAtBottom && splitPanelOpen;
}

export function shouldSettleVirtualizedBottom({
  isAtBottom,
  messageDelta,
  messagesArrived,
  messagesChanged,
}: {
  isAtBottom: boolean;
  messageDelta: TimelineMessageDelta;
  messagesArrived: number;
  messagesChanged: boolean;
}): boolean {
  return (
    isAtBottom &&
    messageDelta !== "prepend" &&
    (messagesArrived > 0 || messagesChanged)
  );
}
