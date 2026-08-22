import * as React from "react";

import type { ParsedMessageLink } from "@/features/messages/lib/messageLink";

export const MessageLinkNavigationGuardContext = React.createContext<
  (link: ParsedMessageLink) => boolean
>(() => true);

export const MessageLinkNavigationGuardProvider =
  MessageLinkNavigationGuardContext.Provider;

export function useMessageLinkNavigationGuard() {
  return React.useContext(MessageLinkNavigationGuardContext);
}
