import * as React from "react";

import type { TimelineMessage } from "@/features/messages/types";

type PendingMessagePreparationProps = {
  message: TimelineMessage;
};

export const PendingMessagePreparation = React.memo(
  function PendingMessagePreparation({
    message,
  }: PendingMessagePreparationProps) {
    const pending = message.pending
      ? (message.tags ?? []).filter((tag) => tag[0] === "client-pending")
      : [];
    if (pending.length === 0) return null;

    return (
      <div
        aria-live="polite"
        className="mt-2 flex max-w-sm flex-col gap-1.5"
        data-testid="message-preparation-status"
      >
        {pending.map((tag, index) => (
          <div
            className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
            key={`${tag[1]}-${tag[2] ?? index}`}
          >
            <span
              aria-hidden="true"
              className="size-3 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground"
            />
            <span className="truncate">
              {tag[1] === "link-preview"
                ? "Preparing link preview…"
                : `Preparing ${tag[2] || "attachment"}…`}
            </span>
          </div>
        ))}
      </div>
    );
  },
);
