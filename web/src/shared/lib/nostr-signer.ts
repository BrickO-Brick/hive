import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

export type UnsignedNostrEvent = {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

export type SignedNostrEvent = UnsignedNostrEvent & {
  id: string;
  pubkey: string;
  sig: string;
};

type Nip07Provider = {
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedNostrEvent): Promise<SignedNostrEvent>;
};

declare global {
  interface Window {
    nostr?: Nip07Provider;
  }
}

export class Nip07UnavailableError extends Error {
  constructor() {
    super("A NIP-07 browser extension is required to join in the browser.");
    this.name = "Nip07UnavailableError";
  }
}

let ephemeralSecretKey: Uint8Array | null = null;
const MANTAP_SECRET_KEY_STORAGE = "hive.mantap.nostr-secret.v1";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
}

function getMantapSecretKey(): Uint8Array | null {
  if (typeof window === "undefined") return null;
  try {
    return hexToBytes(
      window.localStorage.getItem(MANTAP_SECRET_KEY_STORAGE) ?? "",
    );
  } catch {
    return null;
  }
}

/** Create or load the browser-local Nostr identity used by Mantap SSO. */
export function ensureMantapBrowserIdentity(): string {
  const existing = getMantapSecretKey();
  if (existing) return getPublicKey(existing);
  const secret = generateSecretKey();
  window.localStorage.setItem(MANTAP_SECRET_KEY_STORAGE, bytesToHex(secret));
  return getPublicKey(secret);
}

export function hasMantapBrowserIdentity(): boolean {
  return getMantapSecretKey() != null;
}

export function clearMantapBrowserIdentity(): void {
  window.localStorage.removeItem(MANTAP_SECRET_KEY_STORAGE);
}

function getEphemeralSecretKey(): Uint8Array {
  if (!ephemeralSecretKey) {
    ephemeralSecretKey = generateSecretKey();
  }
  return ephemeralSecretKey;
}

export function hasNip07Provider(): boolean {
  return typeof window !== "undefined" && window.nostr != null;
}

function sameUnsignedEvent(
  expected: UnsignedNostrEvent,
  actual: SignedNostrEvent,
): boolean {
  return (
    actual.kind === expected.kind &&
    actual.created_at === expected.created_at &&
    actual.content === expected.content &&
    JSON.stringify(actual.tags) === JSON.stringify(expected.tags)
  );
}

/**
 * Sign with NIP-07 when available, otherwise use a page-lifetime key.
 *
 * The ephemeral fallback preserves anonymous browsing on open relays. Flows
 * that create durable membership must set `requireNip07` so a reload cannot
 * orphan a relay-membership row.
 */
export async function signNostrEvent(
  template: Omit<UnsignedNostrEvent, "created_at"> & {
    created_at?: number;
  },
  options?: { requireNip07?: boolean },
): Promise<SignedNostrEvent> {
  const unsigned: UnsignedNostrEvent = {
    ...template,
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
  };
  const provider = typeof window === "undefined" ? undefined : window.nostr;
  const mantapSecretKey = getMantapSecretKey();

  // A Mantap-provisioned identity must stay on the exact browser key that was
  // bound during exchange, even if a NIP-07 extension is installed later.
  if (!options?.requireNip07 && mantapSecretKey) {
    return finalizeEvent(unsigned, mantapSecretKey);
  }

  if (provider) {
    const expectedPubkey = await provider.getPublicKey();
    const signed = await provider.signEvent(unsigned);
    if (
      signed.pubkey !== expectedPubkey ||
      !sameUnsignedEvent(unsigned, signed) ||
      typeof signed.id !== "string" ||
      typeof signed.sig !== "string"
    ) {
      throw new Error("The NIP-07 extension returned an invalid signed event.");
    }
    return signed;
  }

  if (options?.requireNip07) {
    throw new Nip07UnavailableError();
  }

  const secretKey = getEphemeralSecretKey();
  const signed = finalizeEvent(unsigned, secretKey);
  if (signed.pubkey !== getPublicKey(secretKey)) {
    throw new Error("Failed to create the ephemeral browser identity.");
  }
  return signed;
}
