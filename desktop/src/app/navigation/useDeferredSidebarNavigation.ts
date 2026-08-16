import * as React from "react";

import { dispatchNavigationIntent } from "@/app/navigation/navigationIntent";

type DeferredSidebarNavigationOptions = {
  pathname: string;
  selectedChannelId: string | null;
  selectChannel: (channelId: string) => Promise<unknown> | undefined;
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
  const isCommittingRef = React.useRef(false);
  const ignoreNextNavigationIntentRef = React.useRef(false);
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
    isCommittingRef.current = false;
    ignoreNextNavigationIntentRef.current = false;
    cancelDeferred();
    setPendingChannelId(null);
  }, [cancelDeferred]);

  React.useEffect(() => cancel, [cancel]);
  React.useEffect(() => {
    const handleNavigationIntent = () => {
      if (ignoreNextNavigationIntentRef.current) {
        ignoreNextNavigationIntentRef.current = false;
        return;
      }
      cancel();
    };
    window.addEventListener("buzz:navigation-intent", handleNavigationIntent);
    return () =>
      window.removeEventListener(
        "buzz:navigation-intent",
        handleNavigationIntent,
      );
  }, [cancel]);
  React.useEffect(() => {
    // Keep the destination skeleton mounted through the route commit and one
    // paint. Clearing state directly in this effect can be batched before the
    // browser paints, exposing either the old outlet or expensive new outlet.
    void pathname;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      cancel();
    });
  }, [cancel, pathname]);
  React.useEffect(() => {
    if (!isCommittingRef.current && pendingChannelId === selectedChannelId) {
      setPendingChannelId(null);
    }
  }, [pendingChannelId, selectedChannelId]);

  const selectDeferred = React.useCallback(
    (channelId: string) => {
      if (channelId === selectedChannelId) {
        selectChannel(channelId);
        return;
      }
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
            isCommittingRef.current = true;
            ignoreNextNavigationIntentRef.current = true;
            const navigationResult = selectChannel(channelId);
            if (navigationResult) {
              void navigationResult.catch(() => {
                if (generationRef.current === generation) cancel();
              });
            }
          }, 0);
        });
      });
    },
    [cancel, selectChannel, selectedChannelId],
  );

  return { pendingChannelId, selectDeferred };
}
