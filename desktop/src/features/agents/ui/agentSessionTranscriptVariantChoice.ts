import type { AgentSessionTranscriptVariant } from "./agentSessionTranscriptContext";

/**
 * Narrowest panel width that still reads as a conversation.
 *
 * The `conversation` variant lays the transcript out as a document: a centered
 * reading column with right-aligned prompt bubbles capped well inside it. Below
 * roughly this width the bubble/prose asymmetry collapses and the dense
 * `default` activity feed is the more legible presentation, so the wide layout
 * is the only one that opts in.
 *
 * Calibrated against `shared/layout/auxiliaryPanelLayout.ts`: the panel opens at
 * `AUXILIARY_PANEL_DEFAULT_WIDTH_PX` (380) and clamps to at least
 * `AUXILIARY_PANEL_MAX_WIDTH_PX` (720), so 640 sits deliberately in the top of
 * that range — a panel at its default or merely-widened size keeps the feed, and
 * only a reader who has pulled it near full width (or a full-cover host that
 * pins the variant explicitly) gets the reading layout.
 */
export const CONVERSATION_TRANSCRIPT_MIN_WIDTH_PX = 640;

/**
 * Pick the transcript variant for an agent session panel from its layout.
 *
 * Callers may always override by passing an explicit `transcriptVariant`; this
 * is only the default when they don't. Kept as a pure function so the threshold
 * is testable without mounting the panel.
 */
export function resolveAgentSessionTranscriptVariant({
  isSinglePanelView,
  widthPx,
}: {
  isSinglePanelView: boolean;
  widthPx: number;
}): AgentSessionTranscriptVariant {
  // Single-panel view stacks the panel over the channel on a narrow viewport
  // and renders it at 100% width, so `widthPx` (the stored/resizable width)
  // does not describe what the reader sees. Keep the default feed there.
  if (isSinglePanelView) {
    return "default";
  }

  return widthPx >= CONVERSATION_TRANSCRIPT_MIN_WIDTH_PX
    ? "conversation"
    : "default";
}
