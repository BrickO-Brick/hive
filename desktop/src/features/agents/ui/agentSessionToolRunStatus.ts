import type { TranscriptItem } from "./agentSessionTypes";

/**
 * Aggregate status for a collapsed group of transcript activity.
 *
 * The ordering below is deliberately failure-leaning: a collapsed parent must
 * never present a group as finished-and-fine while one of its children failed
 * or is still running. Reading the aggregate is the whole point of collapsing,
 * so the aggregate is the one place we refuse to round in the optimistic
 * direction.
 */
export type ToolRunGroupStatus =
  | "failed"
  | "executing"
  | "pending"
  | "completed";

/** Precedence order applied by {@link getToolRunGroupStatus} (worst first). */
const STATUS_PRECEDENCE: ToolRunGroupStatus[] = [
  "failed",
  "executing",
  "pending",
  "completed",
];

function statusForItem(item: TranscriptItem): ToolRunGroupStatus {
  if (item.type === "tool") {
    if (item.isError || item.status === "failed") return "failed";
    if (item.status === "executing") return "executing";
    if (item.status === "pending") return "pending";
    return "completed";
  }

  // Non-tool rows can still carry failure (a lifecycle error reclassified into
  // the group's span). Everything else is inert for aggregation purposes.
  return item.renderClass === "error" ? "failed" : "completed";
}

/**
 * Fold a group's children into one status, leaning toward the worst outcome.
 *
 * `failed` beats `executing` beats `pending` beats `completed`. An empty group
 * reports `completed` — there is nothing outstanding to warn about.
 */
export function getToolRunGroupStatus(
  items: readonly TranscriptItem[],
): ToolRunGroupStatus {
  let worstIndex = STATUS_PRECEDENCE.length - 1;
  for (const item of items) {
    const index = STATUS_PRECEDENCE.indexOf(statusForItem(item));
    if (index < worstIndex) {
      worstIndex = index;
    }
    if (worstIndex === 0) break;
  }
  return STATUS_PRECEDENCE[worstIndex];
}

/** True while a group still has work outstanding. */
export function isToolRunGroupActive(status: ToolRunGroupStatus): boolean {
  return status === "executing" || status === "pending";
}

/** Number of failing children in a group (used for conspicuous failure copy). */
export function countToolRunGroupFailures(
  items: readonly TranscriptItem[],
): number {
  let failures = 0;
  for (const item of items) {
    if (statusForItem(item) === "failed") failures += 1;
  }
  return failures;
}
