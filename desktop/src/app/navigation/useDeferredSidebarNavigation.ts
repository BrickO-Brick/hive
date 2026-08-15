import * as React from "react";

import { dispatchNavigationIntent } from "@/app/navigation/navigationIntent";

type DeferredSidebarNavigationOptions = {
  pathname: string;
  selectedChannelId: string | null;
  selectChannel: (channelId: string) => void;
};

export function useDeferredSidebarNavigation({
  pathname,
  selectedChannelId,
  selectChannel,
}: DeferredSidebarNavigationOptions) {
  const [pendingChannelId, setPendingChannelId] = React.useState<string | null>(
    null,
  );
  const frameRef = React.useRef<number | null>(null);
  const timerRef = React.useRef<number | null>(null);
  const generationRef = React.useRef(0);
  const pathnameRef = React.useRef(pathname);
  pathnameRef.current = pathname;

  const cancelDeferred = React.useCallback(() => {
    generationRef.current += 1;
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const cancel = React.useCallback(() => {
    cancelDeferred();
    setPendingChannelId(null);
  }, [cancelDeferred]);

  React.useEffect(() => cancel, [cancel]);
  React.useEffect(() => {
    const handleNavigationIntent = () => cancelDeferred();
    window.addEventListener("buzz:navigation-intent", handleNavigationIntent);
    return () =>
      window.removeEventListener(
        "buzz:navigation-intent",
        handleNavigationIntent,
      );
  }, [cancelDeferred]);
  React.useEffect(() => {
    // A committed route change supersedes any deferred sidebar intent.
    void pathname;
    cancel();
  }, [cancel, pathname]);
  React.useEffect(() => {
    if (pendingChannelId === selectedChannelId) setPendingChannelId(null);
  }, [pendingChannelId, selectedChannelId]);

  const selectDeferred = React.useCallback(
    (channelId: string) => {
      dispatchNavigationIntent();
      cancel();
      const generation = generationRef.current;
      const sourcePathname = pathnameRef.current;
      setPendingChannelId(channelId);
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        if (
          generationRef.current !== generation ||
          pathnameRef.current !== sourcePathname
        ) {
          return;
        }
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null;
          if (
            generationRef.current !== generation ||
            pathnameRef.current !== sourcePathname
          ) {
            return;
          }
          timerRef.current = window.setTimeout(() => {
            timerRef.current = null;
            if (
              generationRef.current !== generation ||
              pathnameRef.current !== sourcePathname
            ) {
              return;
            }
            selectChannel(channelId);
          }, 0);
        });
      });
    },
    [cancel, selectChannel],
  );

  return { pendingChannelId, selectDeferred };
}
