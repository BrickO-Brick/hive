import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import {
  ensureMantapBrowserIdentity,
  type MantapIdentityHint,
  rotateMantapBrowserIdentity,
} from "@/shared/lib/nostr-signer";

export type HiveIdentity = {
  email: string;
  pubkey: string;
  channelId: string;
  role: string;
  subject?: string;
};

const SESSION_KEY = "hive.mantap.identity.v1";
const MANTAP_ORIGIN = "https://mantap.onebrick.io";
const DEFAULT_HIVE_RETURN_PATH = "/app";

/**
 * Keep post-authentication navigation on this Hive origin and inside the app.
 */
export function safeHiveReturnPath(value: string | null | undefined): string {
  if (!value) return DEFAULT_HIVE_RETURN_PATH;
  try {
    const candidate = new URL(value, window.location.origin);
    if (
      candidate.origin !== window.location.origin ||
      candidate.pathname !== DEFAULT_HIVE_RETURN_PATH
    ) {
      return DEFAULT_HIVE_RETURN_PATH;
    }
    return `${candidate.pathname}${candidate.search}${candidate.hash}`;
  } catch {
    return DEFAULT_HIVE_RETURN_PATH;
  }
}

/** Build the Mantap login URL that returns through Hive's ticket exchange. */
export function mantapLoginUrl(returnPath?: string): string {
  const callback = new URL("/mantul-sso", window.location.origin);
  callback.searchParams.set("returnTo", safeHiveReturnPath(returnPath));
  const login = new URL(MANTAP_ORIGIN);
  login.searchParams.set("returnTo", callback.toString());
  return login.toString();
}

export class MantapSsoExchangeError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "MantapSsoExchangeError";
  }
}

/**
 * Read an unverified hint only to select a browser-local key. The relay still
 * validates the signed ticket before it grants any membership.
 */
export function readMantapTicketIdentity(
  ticket: string,
): MantapIdentityHint | null {
  try {
    const parts = ticket.split(".");
    if (parts.length !== 3) return null;
    const encoded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(
      atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")),
    ) as { sub?: unknown; email?: unknown };
    if (
      typeof payload.sub !== "string" ||
      payload.sub.length === 0 ||
      payload.sub.length > 255 ||
      typeof payload.email !== "string"
    ) {
      return null;
    }
    const email = payload.email.trim().toLowerCase();
    if (!email || email.length > 320) return null;
    return { subject: payload.sub, email };
  } catch {
    return null;
  }
}

export async function exchangeMantapTicket(
  ticket: string,
): Promise<HiveIdentity> {
  const url = `${relayHttpBaseUrl().replace(/\/+$/, "")}/api/onebrick/sso/exchange`;
  const body = JSON.stringify({ ticket });
  const authorization = await makeNip98AuthHeader(url, "POST", { body });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new MantapSsoExchangeError(
      String(payload.error ?? `HTTP ${response.status}`),
      response.status,
    );
  }
  const identity = {
    email: String(payload.email),
    pubkey: String(payload.pubkey),
    channelId: String(payload.channel_id),
    role: String(payload.role),
    subject: typeof payload.subject === "string" ? payload.subject : undefined,
  };
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(identity));
  return identity;
}

let activeExchange:
  | { ticket: string; promise: Promise<HiveIdentity> }
  | undefined;

/**
 * Share a one-time ticket exchange across Strict Mode effects and perform at
 * most one key rotation when a historical browser key belongs to another
 * Mantap subject.
 */
export function exchangeMantapTicketWithRecovery(
  ticket: string,
  onRecovering?: () => void,
): Promise<HiveIdentity> {
  if (activeExchange?.ticket === ticket) return activeExchange.promise;

  const hint = readMantapTicketIdentity(ticket);
  const promise = (async () => {
    ensureMantapBrowserIdentity(hint ?? undefined);
    try {
      return await exchangeMantapTicket(ticket);
    } catch (error) {
      if (
        !(error instanceof MantapSsoExchangeError) ||
        error.code !== "nostr_key_already_bound" ||
        !hint
      ) {
        throw error;
      }
      onRecovering?.();
      rotateMantapBrowserIdentity(hint);
      return exchangeMantapTicket(ticket);
    }
  })();
  activeExchange = { ticket, promise };
  const clear = () => {
    if (activeExchange?.promise === promise) activeExchange = undefined;
  };
  void promise.then(clear, clear);
  return promise;
}

export function loadHiveIdentity(): HiveIdentity | null {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(SESSION_KEY) ?? "null",
    ) as HiveIdentity | null;
    return value?.email && value?.pubkey && value?.channelId ? value : null;
  } catch {
    return null;
  }
}

export function clearHiveIdentity(): void {
  window.localStorage.removeItem(SESSION_KEY);
}
