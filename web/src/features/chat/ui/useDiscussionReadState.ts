import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_PREFIX = "hive.discussion-read-state.v1";

type DiscussionReadState = {
  initializedAt: number;
  readThrough: Record<string, number>;
};

function storageKey(identityPubkey: string): string {
  return `${STORAGE_PREFIX}:${identityPubkey}`;
}

function loadReadState(identityPubkey: string): DiscussionReadState {
  const initializedAt = Math.floor(Date.now() / 1_000);
  const stored = window.localStorage.getItem(storageKey(identityPubkey));
  if (!stored) return { initializedAt, readThrough: {} };
  try {
    const parsed = JSON.parse(stored) as Partial<DiscussionReadState>;
    if (
      typeof parsed.initializedAt !== "number" ||
      !parsed.readThrough ||
      typeof parsed.readThrough !== "object"
    ) {
      throw new TypeError("Invalid discussion read state");
    }
    return {
      initializedAt: parsed.initializedAt,
      readThrough: Object.fromEntries(
        Object.entries(parsed.readThrough).filter(
          ([discussionId, timestamp]) =>
            discussionId.length > 0 && typeof timestamp === "number",
        ),
      ),
    };
  } catch {
    window.localStorage.removeItem(storageKey(identityPubkey));
    return { initializedAt, readThrough: {} };
  }
}

export function useDiscussionReadState({
  activeDiscussionId,
  activity,
  identityPubkey,
  viewingDiscussion,
}: {
  activeDiscussionId: string | null;
  activity: ReadonlyMap<string, number>;
  identityPubkey: string;
  viewingDiscussion: boolean;
}) {
  const [readState, setReadState] = useState(() =>
    loadReadState(identityPubkey),
  );

  const markRead = useCallback(
    (discussionId: string, timestamp: number) => {
      setReadState((current) => {
        if ((current.readThrough[discussionId] ?? 0) >= timestamp) {
          return current;
        }
        const next = {
          ...current,
          readThrough: {
            ...Object.fromEntries(
              Object.entries(current.readThrough).filter(([id]) =>
                activity.has(id),
              ),
            ),
            [discussionId]: timestamp,
          },
        };
        return next;
      });
    },
    [activity],
  );

  useEffect(() => {
    window.localStorage.setItem(
      storageKey(identityPubkey),
      JSON.stringify(readState),
    );
  }, [identityPubkey, readState]);

  useEffect(() => {
    if (!viewingDiscussion || !activeDiscussionId) return;
    const latestActivity = activity.get(activeDiscussionId);
    if (latestActivity) markRead(activeDiscussionId, latestActivity);
  }, [activeDiscussionId, activity, markRead, viewingDiscussion]);

  const unreadDiscussionIds = useMemo(() => {
    const unread = new Set<string>();
    for (const [discussionId, timestamp] of activity) {
      const readThrough =
        readState.readThrough[discussionId] ?? readState.initializedAt;
      if (timestamp > readThrough) unread.add(discussionId);
    }
    return unread;
  }, [activity, readState]);

  return unreadDiscussionIds;
}
