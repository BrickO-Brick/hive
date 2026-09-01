import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

export type HiveIdentity = {
  email: string;
  pubkey: string;
  channelId: string;
  role: string;
};

const SESSION_KEY = "hive.mantap.identity.v1";

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
  if (!response.ok)
    throw new Error(String(payload.error ?? `HTTP ${response.status}`));
  const identity = {
    email: String(payload.email),
    pubkey: String(payload.pubkey),
    channelId: String(payload.channel_id),
    role: String(payload.role),
  };
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(identity));
  return identity;
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
