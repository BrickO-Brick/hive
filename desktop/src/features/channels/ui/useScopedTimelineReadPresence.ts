import * as React from "react";

export type TimelineReadPresence = {
  isAtBottom: boolean;
  readAt: number | null;
};

export function useScopedTimelineReadPresence(
  scopeId: string | null,
): [TimelineReadPresence, (presence: TimelineReadPresence) => void] {
  const [state, setState] = React.useState({
    isAtBottom: false,
    readAt: null as number | null,
    scopeId: null as string | null,
  });
  const onPresenceChange = React.useCallback(
    (presence: TimelineReadPresence) => setState({ ...presence, scopeId }),
    [scopeId],
  );
  return [
    state.scopeId === scopeId ? state : { isAtBottom: false, readAt: null },
    onPresenceChange,
  ];
}
