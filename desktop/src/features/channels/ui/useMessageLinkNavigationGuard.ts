import * as React from "react";

import type { ParsedMessageLink } from "@/features/messages/lib/messageLink";

export function useMessageLinkNavigationGuard(
  requireThreadEditResolution: () => boolean,
) {
  return React.useCallback(
    (_link: ParsedMessageLink) => requireThreadEditResolution(),
    [requireThreadEditResolution],
  );
}
