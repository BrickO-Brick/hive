import type { TranscriptToolRunSummary } from "./agentSessionTranscriptGrouping";

/**
 * Durable identity for a tool-run group, stable across re-grouping.
 *
 * A summary's own `id` encodes how the group was batched at the moment it was
 * built: a same-kind run is `summary:read_file:<first>`, and the moment one
 * differing tool call lands beside it the same work is rebuilt as
 * `summary:mixed:<first>`. Keying reader state on that id would silently
 * discard a deliberate choice to open a group every time the agent emitted one
 * more call.
 *
 * The first leaf item's id is the stable part. Item ids derive from the channel
 * and the ACP tool-call id, so they survive both re-derivation over merged
 * live/archive windows and the same-kind → mixed transition (a group that
 * grows by appending keeps its first leaf). `turnId` scopes the key so two
 * turns can never collide, and is read from the leaf rather than the summary
 * because only leaves carry turn identity.
 */
export function getToolRunGroupKey(
  summary: Pick<TranscriptToolRunSummary, "id" | "items">,
): string {
  const first = summary.items[0];
  if (!first) {
    // A group with no leaves cannot be identified by content; fall back to the
    // batch-derived id rather than colliding every empty group onto one key.
    return `group:empty:${summary.id}`;
  }
  return `group:${first.turnId ?? "no-turn"}:${first.id}`;
}
