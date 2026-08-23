import * as React from "react";

export function useScopedAtBottom(
  scopeId: string | null,
): [boolean, (isAtBottom: boolean) => void] {
  const [state, setState] = React.useState({
    isAtBottom: false,
    scopeId: null as string | null,
  });
  const onAtBottomChange = React.useCallback(
    (isAtBottom: boolean) => setState({ isAtBottom, scopeId }),
    [scopeId],
  );
  return [state.scopeId === scopeId && state.isAtBottom, onAtBottomChange];
}
