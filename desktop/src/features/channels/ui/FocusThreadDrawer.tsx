import type * as React from "react";

import { getThreadViewMode } from "@/features/channels/lib/threadViewModePreference";
import { CoverDrawer } from "@/features/channels/ui/CoverDrawer";

type FocusThreadDrawerProps = {
  channelName: string;
  children: React.ReactNode;
  onClose: () => void;
};

/**
 * A real dismissal keeps focus mode selected; a presentation switch has already
 * selected split mode and owns focus inside the new panel.
 */
function shouldRestoreFocusOnClose() {
  return getThreadViewMode() === "focus";
}

/**
 * The focus-mode thread presentation: a {@link CoverDrawer} holding the thread.
 *
 * Everything about the surface itself — motion, scrim, Escape, focus capture —
 * lives in `CoverDrawer`. What is thread-specific is the focus-restore rule
 * above, which has to yield to the view-mode toggle.
 */
export function FocusThreadDrawer({
  channelName,
  children,
  onClose,
}: FocusThreadDrawerProps) {
  return (
    <CoverDrawer
      ariaLabel="Thread"
      onClose={onClose}
      scrimLabel={`Back to #${channelName}`}
      shouldRestoreFocusOnClose={shouldRestoreFocusOnClose}
      testId="focus-thread-drawer"
    >
      {children}
    </CoverDrawer>
  );
}
