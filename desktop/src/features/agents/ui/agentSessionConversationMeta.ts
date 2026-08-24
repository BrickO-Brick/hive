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
 * Derive the `conversation` variant's streaming hint from the display blocks.
 *
 * Only the trailing leaf item of the final turn can be mid-stream, and only
 * when the agent's turn is actually live. The work block reads this to decide
 * whether it is still working: a thought or note streaming in carries no status
 * of its own, so without this hint a block whose last step is prose would fold
 * while the reader was still watching it arrive.
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
  if (lastBlock?.kind === "single") {
    return { streamingItemId: lastBlock.item.id };
  }
  if (lastBlock?.kind !== "turn") {
    return EMPTY_TRANSCRIPT_TURN_META;
  }

  const items = lastBlock.segments.flatMap(turnSegmentItems);
  return { streamingItemId: items[items.length - 1]?.id ?? null };
}
