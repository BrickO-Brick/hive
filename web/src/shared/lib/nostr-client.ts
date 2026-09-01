/**
 * Minimal Nostr client with NIP-01 queries and NIP-42 AUTH.
 *
 * Uses NIP-07 when a browser extension is available, with an ephemeral
 * page-lifetime identity as the fallback for read-only queries on open relays.
 */

import { makeAuthEvent } from "nostr-tools/nip42";
import {
  type SignedNostrEvent,
  signNostrEvent,
} from "@/shared/lib/nostr-signer";

export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [tag: `#${string}`]: string[] | undefined;
}

export type NostrEvent = SignedNostrEvent;

const QUERY_TIMEOUT_MS = 10_000;
const SUBSCRIPTION_RECONNECT_MS = 1_000;

export type NostrSubscriptionState =
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting";

/**
 * Keep a NIP-01 subscription open after EOSE so new events arrive in real time.
 * The returned cleanup function closes the socket and disables reconnects.
 */
export function subscribeEvents(
  wsUrl: string,
  filter: NostrFilter,
  onEvent: (event: NostrEvent) => void,
  onError: (error: Error) => void,
  onStateChange?: (state: NostrSubscriptionState) => void,
): () => void {
  const subId = `s-${Date.now().toString(36)}`;
  let disposed = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let unauthenticatedReqTimer: ReturnType<typeof setTimeout> | null = null;
  let hasConnected = false;

  const connect = () => {
    if (disposed) return;

    onStateChange?.(hasConnected ? "reconnecting" : "connecting");

    const socket = new WebSocket(wsUrl);
    ws = socket;
    let reqSent = false;
    let authEventId: string | null = null;

    const sendReq = () => {
      if (!reqSent && socket.readyState === WebSocket.OPEN) {
        reqSent = true;
        socket.send(JSON.stringify(["REQ", subId, filter]));
        hasConnected = true;
        onStateChange?.("connected");
      }
    };

    socket.addEventListener("open", () => {
      unauthenticatedReqTimer = setTimeout(sendReq, 100);
    });

    socket.addEventListener("message", async (message) => {
      let data: unknown;
      try {
        data = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (!Array.isArray(data)) return;

      if (data[0] === "AUTH" && typeof data[1] === "string") {
        onStateChange?.("authenticating");
        if (unauthenticatedReqTimer) {
          clearTimeout(unauthenticatedReqTimer);
          unauthenticatedReqTimer = null;
        }
        try {
          const auth = await signNostrEvent(makeAuthEvent(wsUrl, data[1]));
          if (
            disposed ||
            ws !== socket ||
            socket.readyState !== WebSocket.OPEN
          ) {
            return;
          }
          authEventId = auth.id;
          socket.send(JSON.stringify(["AUTH", auth]));
        } catch (error) {
          onError(
            error instanceof Error
              ? error
              : new Error("Relay authentication failed."),
          );
          socket.close();
        }
        return;
      }

      if (data[0] === "OK" && data[1] === authEventId) {
        if (data[2] === true) {
          sendReq();
        } else {
          onError(new Error(String(data[3] ?? "Relay authentication failed.")));
          socket.close();
        }
        return;
      }

      if (data[0] === "EVENT" && data[1] === subId && data[2]) {
        onEvent(data[2] as NostrEvent);
      } else if (data[0] === "CLOSED" && data[1] === subId) {
        onError(new Error(String(data[2] ?? "Relay closed the subscription.")));
        socket.close();
      }
    });

    socket.addEventListener("error", () => {
      onError(new Error("WebSocket connection failed."));
    });

    socket.addEventListener("close", () => {
      if (unauthenticatedReqTimer) {
        clearTimeout(unauthenticatedReqTimer);
        unauthenticatedReqTimer = null;
      }
      if (!disposed && ws === socket) {
        onStateChange?.("reconnecting");
        reconnectTimer = setTimeout(connect, SUBSCRIPTION_RECONNECT_MS);
      }
    });
  };

  connect();

  return () => {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (unauthenticatedReqTimer) clearTimeout(unauthenticatedReqTimer);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(["CLOSE", subId]));
    }
    ws?.close();
  };
}

/**
 * Open a WebSocket to `wsUrl`, authenticate via NIP-42 if challenged,
 * send a REQ with the given filter, collect EVENTs until EOSE, then
 * close and return them.
 */
export function queryEvents(
  wsUrl: string,
  filter: NostrFilter,
): Promise<NostrEvent[]> {
  return new Promise((resolve, reject) => {
    const events: NostrEvent[] = [];
    const subId = `q-${Date.now().toString(36)}`;
    let settled = false;
    let reqSent = false;
    let authEventId: string | null = null;
    let unauthenticatedReqTimer: ReturnType<typeof setTimeout> | null = null;

    const ws = new WebSocket(wsUrl);

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error(`Relay query timed out after ${QUERY_TIMEOUT_MS}ms`));
      }
    }, QUERY_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      if (unauthenticatedReqTimer) {
        clearTimeout(unauthenticatedReqTimer);
      }
      try {
        ws.close();
      } catch {
        // ignore
      }
    };

    const sendReq = () => {
      if (!reqSent) {
        reqSent = true;
        ws.send(JSON.stringify(["REQ", subId, filter]));
      }
    };

    ws.addEventListener("open", () => {
      // Wait briefly for an AUTH challenge before sending REQ.
      // Buzz relays always send AUTH, but other relays may not.
      unauthenticatedReqTimer = setTimeout(() => sendReq(), 100);
    });

    ws.addEventListener("message", async (msg) => {
      let data: unknown;
      try {
        data = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      if (!Array.isArray(data)) return;

      const [type] = data;

      if (type === "AUTH" && typeof data[1] === "string") {
        // NIP-42: relay sent an AUTH challenge — sign and respond.
        if (unauthenticatedReqTimer) {
          clearTimeout(unauthenticatedReqTimer);
          unauthenticatedReqTimer = null;
        }
        const challenge = data[1];
        const template = makeAuthEvent(wsUrl, challenge);
        try {
          const signed = await signNostrEvent(template);
          if (settled) return;
          authEventId = signed.id;
          ws.send(JSON.stringify(["AUTH", signed]));
        } catch (error) {
          if (!settled) {
            settled = true;
            cleanup();
            reject(
              error instanceof Error
                ? error
                : new Error("Failed to sign relay authentication."),
            );
          }
        }
        return;
      }

      if (type === "OK" && data[1] === authEventId) {
        if (data[2] === true) {
          sendReq();
        } else if (!settled) {
          settled = true;
          cleanup();
          reject(
            new Error(
              typeof data[3] === "string"
                ? data[3]
                : "Relay authentication failed.",
            ),
          );
        }
        return;
      }

      if (type === "EVENT" && data[1] === subId && data[2]) {
        events.push(data[2] as NostrEvent);
      } else if (type === "EOSE" && data[1] === subId) {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(events);
        }
      } else if (type === "CLOSED" && data[1] === subId) {
        // Subscription was rejected (e.g. auth failed).
        if (!settled) {
          settled = true;
          cleanup();
          const reason =
            typeof data[2] === "string"
              ? data[2]
              : "subscription closed by relay";
          reject(new Error(reason));
        }
      } else if (type === "NOTICE") {
        // Informational notice from relay — ignore for now.
      }
    });

    ws.addEventListener("error", () => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error("WebSocket connection failed"));
      }
    });

    ws.addEventListener("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(events);
      }
    });
  });
}

/** Publish one signed event over NIP-01, completing NIP-42 first when challenged. */
export function publishEvent(
  wsUrl: string,
  event: SignedNostrEvent,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    let sent = false;
    let authEventId: string | null = null;
    let sendTimer: ReturnType<typeof setTimeout> | null = null;
    const timeout = setTimeout(
      () => finish(new Error("Relay publish timed out.")),
      QUERY_TIMEOUT_MS,
    );

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (sendTimer) clearTimeout(sendTimer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (error) reject(error);
      else resolve();
    };
    const send = () => {
      if (!sent) {
        sent = true;
        ws.send(JSON.stringify(["EVENT", event]));
      }
    };

    ws.addEventListener("open", () => {
      sendTimer = setTimeout(send, 100);
    });
    ws.addEventListener("message", async (message) => {
      let data: unknown;
      try {
        data = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (!Array.isArray(data)) return;
      if (data[0] === "AUTH" && typeof data[1] === "string") {
        if (sendTimer) clearTimeout(sendTimer);
        try {
          const auth = await signNostrEvent(makeAuthEvent(wsUrl, data[1]));
          authEventId = auth.id;
          ws.send(JSON.stringify(["AUTH", auth]));
        } catch (error) {
          finish(
            error instanceof Error
              ? error
              : new Error("Relay authentication failed."),
          );
        }
      } else if (data[0] === "OK" && data[1] === authEventId) {
        if (data[2] === true) send();
        else
          finish(new Error(String(data[3] ?? "Relay authentication failed.")));
      } else if (data[0] === "OK" && data[1] === event.id) {
        if (data[2] === true) finish();
        else
          finish(new Error(String(data[3] ?? "Relay rejected the message.")));
      }
    });
    ws.addEventListener("error", () =>
      finish(new Error("WebSocket connection failed.")),
    );
    ws.addEventListener("close", () => {
      if (!settled)
        finish(new Error("Relay closed before acknowledging the message."));
    });
  });
}
