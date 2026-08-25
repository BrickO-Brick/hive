import type {
  AgentSessionTranscriptTurnMeta,
  AgentSessionTranscriptVariant,
} from "./agentSessionTranscriptContext";
import { EMPTY_TRANSCRIPT_TURN_META } from "./agentSessionTranscriptContext";
import type {
  TranscriptDisplayBlock,
  TranscriptTurnSegment,
} from "./agentSessionTranscriptGrouping";
import type { TranscriptItem } from "./agentSessionTypes";

/**
 * Flatten a turn's segments into the leaf items that the reader actually sees
 * in the order they appear. Prompt segments contribute their user message;
 * setup segments contribute nothing (they render as a quiet divider, not work);
 * summary segments contribute their collapsed tool items.
 *
 * This walks the SHARED segment union deliberately. The conversation variant's
 * additive work-block transform runs later, at the list's render boundary
 * (`TranscriptDisplayBlockView`), so no `work-block` segment can reach here —
 * and the streaming tail must be computed from the true item order regardless
 * of how the variant later groups those items for presentation.
 */
function turnSegmentItems(segment: TranscriptTurnSegment): TranscriptItem[] {
  if (segment.kind === "prompt") return [segment.user];
  if (segment.kind === "setup") return [];
  if (segment.kind === "summary") return segment.summary.items;
  return [segment.item];
}

/**
 * Derive the `conversation` variant's live-turn hints from the display blocks.
 *
 * Two things the work block cannot see for itself:
 *
 *  - **`streamingItemId`** — the trailing leaf item of the final turn, and only
 *    when the agent's turn is actually live. The block reads this to decide
 *    whether it is still working: a thought or note streaming in carries no
 *    status of its own, so without this hint a block whose last step is prose
 *    would fold while the reader was still watching it arrive.
 *  - **`liveTurnId`** — which turn a session currently owns. A tool item keeps
 *    its `executing` status forever if the agent dies mid-step, so status alone
 *    cannot tell a running step from an abandoned one; the block needs to know
 *    whose turn is live to decide (see `AgentSessionTranscriptTurnMeta`).
 *
 * Returns the shared empty value for non-conversation variants so the default
 * and compactPreview paths allocate nothing and stay byte-identical.
 */
export function buildConversationTurnMeta(
  displayBlocks: TranscriptDisplayBlock[],
  options: { isTurnLive: boolean; variant: AgentSessionTranscriptVariant },
): AgentSessionTranscriptTurnMeta {
  if (options.variant !== "conversation" || !options.isTurnLive) {
    return EMPTY_TRANSCRIPT_TURN_META;
  }

  const lastBlock = displayBlocks[displayBlocks.length - 1];
  // The live turn is the last turn in the transcript: work arrives in order, so
  // a turn with anything after it has already been superseded. Read from the
  // blocks rather than from the active-turn store because the store's turn ids
  // and the transcript's are populated by different paths, and a mismatch would
  // silently gate every step off.
  const liveTurnId = lastTurnId(displayBlocks);

  if (lastBlock?.kind === "single") {
    return { liveTurnId, streamingItemId: lastBlock.item.id };
  }
  if (lastBlock?.kind !== "turn") {
    return { liveTurnId, streamingItemId: null };
  }

  const items = lastBlock.segments.flatMap(turnSegmentItems);
  return { liveTurnId, streamingItemId: items[items.length - 1]?.id ?? null };
}

/**
 * The id of the last turn block, ignoring anything that trails it.
 *
 * A lifecycle row (a compaction notice, a session boundary) can land after the
 * turn it belongs to and arrives as a `single` block, so the last block is not
 * always the live turn — but the last *turn* is.
 */
function lastTurnId(displayBlocks: TranscriptDisplayBlock[]): string | null {
  for (let index = displayBlocks.length - 1; index >= 0; index -= 1) {
    const block = displayBlocks[index];
    if (block.kind === "turn") return block.turnId;
  }
  return null;
}
