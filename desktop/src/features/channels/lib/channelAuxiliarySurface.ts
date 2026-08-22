import type { ThreadViewMode } from "@/features/channels/lib/threadViewModePreference";

/**
 * The one auxiliary surface a channel shows beside (or over) its timeline.
 *
 * Exactly one at a time, in this priority order. The open handlers in
 * `useChannelAgentSessions` / `useChannelProfilePanel` already clear the other
 * panels' state so last-opened wins; this resolution is what guarantees that a
 * lingering search param or a race can still only ever produce one surface.
 */
export type ChannelAuxiliarySurface =
  | "agent-session"
  | "channel-management"
  | "profile"
  | "thread"
  | "thread-skeleton";

type ChannelAuxiliarySurfaceOptions = {
  channelManagementOpen: boolean;
  hasActiveChannel: boolean;
  hasProfilePanel: boolean;
  hasSelectedAgent: boolean;
  hasThreadHead: boolean;
  shouldShowThreadSkeleton: boolean;
};

/** Which auxiliary surface the channel pane should render, if any. */
export function resolveChannelAuxiliarySurface({
  channelManagementOpen,
  hasActiveChannel,
  hasProfilePanel,
  hasSelectedAgent,
  hasThreadHead,
  shouldShowThreadSkeleton,
}: ChannelAuxiliarySurfaceOptions): ChannelAuxiliarySurface | null {
  if (channelManagementOpen && hasActiveChannel) return "channel-management";
  if (hasThreadHead) return "thread";
  if (shouldShowThreadSkeleton) return "thread-skeleton";
  if (hasActiveChannel && hasSelectedAgent) return "agent-session";
  if (hasProfilePanel) return "profile";
  return null;
}

/** A cover drawer overlays the channel content area instead of splitting it. */
export type ChannelCoverDrawer = "agent-session" | "thread";

type ChannelCoverDrawerOptions = {
  surface: ChannelAuxiliarySurface | null;
  threadViewMode: ThreadViewMode;
  useSplitAuxiliaryPane: boolean;
};

/**
 * Which surface, if any, presents as a cover drawer.
 *
 * Threads honour the user's view-mode preference. Agent activity does not and
 * deliberately offers no toggle: its transcript is tool calls, diffs, and
 * command output, which a 380px side pane cannot show usefully — so at any
 * viewport wide enough for two panes it always covers. Narrow/overlay and
 * single-panel viewports keep their existing presentations for both.
 *
 * Returning a single value is what makes the two drawers mutually exclusive:
 * there is one covered slot, and the resolved surface owns it.
 */
export function resolveChannelCoverDrawer({
  surface,
  threadViewMode,
  useSplitAuxiliaryPane,
}: ChannelCoverDrawerOptions): ChannelCoverDrawer | null {
  if (!useSplitAuxiliaryPane) return null;

  if (surface === "thread" || surface === "thread-skeleton") {
    return threadViewMode === "focus" ? "thread" : null;
  }

  return surface === "agent-session" ? "agent-session" : null;
}
