import type * as React from "react";

import { useChannelViewOverride } from "@/features/channels/ui/ChannelViewOverrideContext";
import { channelChrome } from "@/shared/layout/chromeLayout";
import { cn } from "@/shared/lib/cn";

const IN_FLOW_CHANNEL_CONTENT_STYLE = {
  "--buzz-channel-content-top-padding": "0rem",
  "--channel-top-chrome-height": "0.25rem",
} as React.CSSProperties;

export function ChannelPaneMainColumn({
  children,
}: {
  children: React.ReactNode;
}) {
  const channelView = useChannelViewOverride();
  const mainColumnHeader = channelView?.mainColumnHeader;
  const className = cn(
    "relative isolate flex min-h-0 min-w-0 flex-1 flex-col",
    channelView?.mainContent && "hidden",
  );

  if (!mainColumnHeader) return <div className={className}>{children}</div>;

  return (
    <div className={className}>
      <div
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col",
          channelChrome.contentPadding,
        )}
      >
        <div
          className="relative flex min-h-0 min-w-0 flex-1 flex-col"
          style={IN_FLOW_CHANNEL_CONTENT_STYLE}
        >
          {mainColumnHeader}
          <div
            className={channelView?.hideMainColumnBody ? "hidden" : "contents"}
            data-testid="channel-main-column-body"
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChannelPaneMainContent() {
  const mainContent = useChannelViewOverride()?.mainContent;
  if (!mainContent) return null;

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pt-(--buzz-channel-content-top-padding,5.75rem)"
      data-testid="channel-main-content"
    >
      {mainContent}
    </div>
  );
}
