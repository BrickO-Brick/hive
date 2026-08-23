import * as React from "react";

import { registerMessageTargetNavigationGuard } from "@/app/navigation/messageTargetNavigationGuard";

export function useMessageLinkNavigationGuard(
  requireThreadEditResolution: () => boolean,
) {
  React.useLayoutEffect(
    () => registerMessageTargetNavigationGuard(requireThreadEditResolution),
    [requireThreadEditResolution],
  );
}
