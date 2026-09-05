import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type NostrEvent,
  type NostrSubscriptionState,
  queryEventsHttp,
  subscribeEvents,
} from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { hiveUserFacingError } from "./hiveErrors";

const HISTORY_PAGE_SIZE = 100;

function newestFirst(events: NostrEvent[]): NostrEvent[] {
  return [...events].sort(
    (left, right) =>
      right.created_at - left.created_at || left.id.localeCompare(right.id),
  );
}

function chronological(events: NostrEvent[]): NostrEvent[] {
  return [...events].sort(
    (left, right) =>
      left.created_at - right.created_at || right.id.localeCompare(left.id),
  );
}

function mergeEvents(current: NostrEvent[], incoming: NostrEvent[]) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const event of incoming) byId.set(event.id, event);
  return chronological([...byId.values()]);
}

export function useHiveChatHistory({
  activeChannelId,
  messagesEndRef,
  setConnection,
  setError,
}: {
  activeChannelId: string | null;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  setConnection: Dispatch<SetStateAction<NostrSubscriptionState>>;
  setError: Dispatch<SetStateAction<string>>;
}) {
  const [messages, setMessages] = useState<NostrEvent[]>([]);
  const [lastLiveEvent, setLastLiveEvent] = useState<NostrEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [cursor, setCursor] = useState<{
    beforeId: string;
    until: number;
  } | null>(null);
  const generationRef = useRef(0);
  const mergeMessage = useCallback(
    (event: NostrEvent) => {
      setMessages((current) => mergeEvents(current, [event]));
      window.requestAnimationFrame(() =>
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }),
      );
    },
    [messagesEndRef],
  );

  const refresh = useCallback(async () => {
    if (!activeChannelId) return;
    const generation = generationRef.current;
    setLoading(true);
    setError("");
    try {
      const page = newestFirst(
        await queryEventsHttp([
          {
            kinds: [9],
            "#h": [activeChannelId],
            limit: HISTORY_PAGE_SIZE,
          },
        ]),
      );
      if (generation !== generationRef.current) return;
      setMessages((current) => mergeEvents(current, page));
      const oldest = page[page.length - 1];
      setCursor(
        oldest ? { beforeId: oldest.id, until: oldest.created_at } : null,
      );
      setHasOlder(page.length === HISTORY_PAGE_SIZE);
      window.requestAnimationFrame(() =>
        messagesEndRef.current?.scrollIntoView({ behavior: "auto" }),
      );
    } catch (cause) {
      if (generation === generationRef.current) {
        setError(hiveUserFacingError(cause, "load"));
      }
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [activeChannelId, messagesEndRef, setError]);

  const loadOlder = useCallback(async () => {
    if (!activeChannelId || !cursor || loadingOlder || !hasOlder) return;
    const generation = generationRef.current;
    setLoadingOlder(true);
    try {
      const page = newestFirst(
        await queryEventsHttp([
          {
            kinds: [9],
            "#h": [activeChannelId],
            until: cursor.until,
            before_id: cursor.beforeId,
            limit: HISTORY_PAGE_SIZE,
          },
        ]),
      );
      if (generation !== generationRef.current) return;
      setMessages((current) => mergeEvents(current, page));
      const oldest = page[page.length - 1];
      if (oldest) setCursor({ beforeId: oldest.id, until: oldest.created_at });
      setHasOlder(page.length === HISTORY_PAGE_SIZE);
    } catch (cause) {
      if (generation === generationRef.current) {
        setError(hiveUserFacingError(cause, "load"));
      }
    } finally {
      if (generation === generationRef.current) setLoadingOlder(false);
    }
  }, [activeChannelId, cursor, hasOlder, loadingOlder, setError]);

  useEffect(() => {
    generationRef.current += 1;
    setMessages([]);
    setCursor(null);
    setHasOlder(false);
    setLoading(Boolean(activeChannelId));
    if (!activeChannelId) return;
    const liveSince = Math.floor(Date.now() / 1000) - 60;
    const unsubscribe = subscribeEvents(
      relayWsUrl(),
      {
        kinds: [9],
        "#h": [activeChannelId],
        since: liveSince,
        limit: HISTORY_PAGE_SIZE,
      },
      (event) => {
        setError("");
        mergeMessage(event);
        setLastLiveEvent(event);
      },
      (cause) => setError(hiveUserFacingError(cause, "connect")),
      (state) => {
        setConnection(state);
        if (state === "connected") {
          setError("");
          void refresh();
        }
      },
    );
    return () => {
      generationRef.current += 1;
      unsubscribe();
    };
  }, [activeChannelId, mergeMessage, refresh, setConnection, setError]);

  return {
    hasOlder,
    lastLiveEvent,
    loadOlder,
    loading,
    loadingOlder,
    mergeMessage,
    messages,
    refresh,
  };
}
