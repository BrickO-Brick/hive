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
const MANTAP_KEYRING_STORAGE = "hive.mantap.nostr-keyring.v2";
const MANTAP_SESSION_STORAGE = "hive.mantap.identity.v1";
const MAX_MANTAP_IDENTITIES = 8;

export type MantapIdentityHint = {
  subject: string;
  email: string;
};

type MantapKeyringEntry = {
  subject?: string;
  email: string;
  secret: string;
  lastUsedAt: number;
};

type MantapKeyring = {
  version: 2;
  activeSubject?: string;
  entries: MantapKeyringEntry[];
};

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
    const keyring = loadMantapKeyring();
    const active = keyring.activeSubject
      ? keyring.entries.find((entry) => entry.subject === keyring.activeSubject)
      : undefined;
    const activeSecret = active ? hexToBytes(active.secret) : null;
    if (activeSecret) return activeSecret;
    return hexToBytes(
      window.localStorage.getItem(MANTAP_SECRET_KEY_STORAGE) ?? "",
    );
  } catch {
    return null;
  }
}

function loadMantapKeyring(): MantapKeyring {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(MANTAP_KEYRING_STORAGE) ?? "null",
    ) as Partial<MantapKeyring> | null;
    if (parsed?.version !== 2 || !Array.isArray(parsed.entries)) {
      return { version: 2, entries: [] };
    }
    const entries = parsed.entries
      .filter(
        (entry): entry is MantapKeyringEntry =>
          typeof entry?.email === "string" &&
          typeof entry?.secret === "string" &&
          hexToBytes(entry.secret) != null &&
          typeof entry?.lastUsedAt === "number" &&
          (entry.subject === undefined || typeof entry.subject === "string"),
      )
      .slice(0, MAX_MANTAP_IDENTITIES);
    const activeSubject =
      typeof parsed.activeSubject === "string" &&
      entries.some((entry) => entry.subject === parsed.activeSubject)
        ? parsed.activeSubject
        : undefined;
    return { version: 2, activeSubject, entries };
  } catch {
    return { version: 2, entries: [] };
  }
}

function previousMantapEmail(): string {
  try {
    const session = JSON.parse(
      window.localStorage.getItem(MANTAP_SESSION_STORAGE) ?? "null",
    ) as { email?: unknown } | null;
    return typeof session?.email === "string"
      ? session.email.trim().toLowerCase()
      : "";
  } catch {
    return "";
  }
}

function saveMantapKeyring(keyring: MantapKeyring): void {
  const entries = [...keyring.entries]
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
    .slice(0, MAX_MANTAP_IDENTITIES);
  window.localStorage.setItem(
    MANTAP_KEYRING_STORAGE,
    JSON.stringify({ ...keyring, entries }),
  );
}

function createKeyringEntry(
  hint: MantapIdentityHint,
  secret = generateSecretKey(),
): MantapKeyringEntry {
  return {
    subject: hint.subject,
    email: hint.email.trim().toLowerCase(),
    secret: bytesToHex(secret),
    lastUsedAt: Date.now(),
  };
}

/**
 * Select the browser-local Nostr identity for one verified-on-exchange Mantap
 * subject. The bounded keyring keeps account switches reversible instead of
 * rebinding one browser key across multiple Mantap accounts.
 */
export function selectMantapBrowserIdentity(hint: MantapIdentityHint): string {
  const normalizedHint = {
    subject: hint.subject,
    email: hint.email.trim().toLowerCase(),
  };
  const keyring = loadMantapKeyring();
  let entry = keyring.entries.find(
    (candidate) => candidate.subject === normalizedHint.subject,
  );

  if (!entry) {
    entry = keyring.entries.find(
      (candidate) =>
        candidate.subject === undefined &&
        candidate.email === normalizedHint.email,
    );
    if (entry) entry.subject = normalizedHint.subject;
  }

  const legacySecret = getLegacyMantapSecretKey();
  if (!entry && legacySecret) {
    const legacyEmail = previousMantapEmail();
    const legacyEntry: MantapKeyringEntry = {
      subject:
        !legacyEmail || legacyEmail === normalizedHint.email
          ? normalizedHint.subject
          : undefined,
      email: legacyEmail || normalizedHint.email,
      secret: bytesToHex(legacySecret),
      lastUsedAt: Date.now(),
    };
    keyring.entries.push(legacyEntry);
    if (legacyEntry.subject === normalizedHint.subject) entry = legacyEntry;
  }

  if (!entry) {
    entry = createKeyringEntry(normalizedHint);
    keyring.entries.push(entry);
  }
  entry.email = normalizedHint.email;
  entry.lastUsedAt = Date.now();
  keyring.activeSubject = normalizedHint.subject;
  saveMantapKeyring(keyring);
  if (legacySecret) {
    window.localStorage.removeItem(MANTAP_SECRET_KEY_STORAGE);
  }
  const secret = hexToBytes(entry.secret);
  if (!secret) throw new Error("Failed to select the Mantap browser identity.");
  return getPublicKey(secret);
}

function getLegacyMantapSecretKey(): Uint8Array | null {
  try {
    return hexToBytes(
      window.localStorage.getItem(MANTAP_SECRET_KEY_STORAGE) ?? "",
    );
  } catch {
    return null;
  }
}

/** Create or load the active browser-local Nostr identity used by Mantap SSO. */
export function ensureMantapBrowserIdentity(hint?: MantapIdentityHint): string {
  if (hint) return selectMantapBrowserIdentity(hint);
  const existing = getMantapSecretKey();
  if (existing) return getPublicKey(existing);
  const secret = generateSecretKey();
  window.localStorage.setItem(MANTAP_SECRET_KEY_STORAGE, bytesToHex(secret));
  return getPublicKey(secret);
}

export function hasMantapBrowserIdentity(): boolean {
  return getMantapSecretKey() != null;
}

/** Replace only the conflicting account key while preserving other accounts. */
export function rotateMantapBrowserIdentity(hint: MantapIdentityHint): string {
  const keyring = loadMantapKeyring();
  keyring.entries = keyring.entries.filter(
    (entry) => entry.subject !== hint.subject,
  );
  const replacement = createKeyringEntry(hint);
  keyring.entries.push(replacement);
  keyring.activeSubject = hint.subject;
  saveMantapKeyring(keyring);
  const secret = hexToBytes(replacement.secret);
  if (!secret) throw new Error("Failed to rotate the Mantap browser identity.");
  return getPublicKey(secret);
}

export function clearMantapBrowserIdentity(): void {
  window.localStorage.removeItem(MANTAP_SECRET_KEY_STORAGE);
  window.localStorage.removeItem(MANTAP_KEYRING_STORAGE);
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
