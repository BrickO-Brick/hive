import type * as React from "react";

import { MessageLinkNavigationGuardProvider } from "@/shared/ui/markdown/messageLinkNavigationGuardContext";
import { ChannelPane } from "./ChannelScreenLazyViews";

type GuardedChannelPaneProps = React.ComponentProps<typeof ChannelPane> & {
  messageLinkNavigationGuard: React.ComponentProps<
    typeof MessageLinkNavigationGuardProvider
  >["value"];
};

export function GuardedChannelPane({
  messageLinkNavigationGuard,
  ...props
}: GuardedChannelPaneProps) {
  return (
    <MessageLinkNavigationGuardProvider value={messageLinkNavigationGuard}>
      <ChannelPane {...props} />
    </MessageLinkNavigationGuardProvider>
  );
}
