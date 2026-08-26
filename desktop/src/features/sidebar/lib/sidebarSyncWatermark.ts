/**
 * Persisted remote-head watermark for sidebar-preference sync managers.
 *
 * Each manager (sections, sort, stars, mutes, project membership) persists the highest
 * `created_at` it has ever observed from the relay under a key scoped to
 * pubkey + relay + blob type.  On the next boot the manager reads this value
 * back: if it is > 0 a remote blob has existed before and seed-publishing
 * must be skipped even when the fetch comes back empty (error, timeout, or
 * auth-race).
 *
 * Keys live in localStorage alongside the payload blobs.  They are tiny
 * (one integer string per key) and scoped so they never bleed across
 * identities, communities, or blob types.
 *
 * `relayUrl` is always required — a pubkey-only fallback is not safe because
 * a head seen on relay A would suppress legitimate first-time seeding on
 * relay B.  The URL is normalised (trimmed, trailing slash stripped,
 * lower-cased) before being embedded in the key so the same relay written
 * two ways never produces two different keys.
 */

import { normalizeRelayUrl } from "@/shared/lib/normalizeRelayUrl";

const PREFIX = "buzz-sync-watermark.v1";

// The relay rejects events more than ±15 minutes (900s) from server time
// (`MAX_TIMESTAMP_DRIFT_SECS` in ingest.rs). Clamp every sidebar-sync publish's
// `created_at` well inside that window so a skewed remote head can never make a
// manager manufacture an unbounded future timestamp that wedges every
// subsequent publish. 840s leaves ~60s of transit margin while still letting a
// publish win LWW against any legitimately-timestamped head.
const MAX_PUBLISH_FUTURE_SECS = 840;

/**
 * Compute the `created_at` for a sidebar-sync publish.
 *
 * Stamps one second past the newest observed remote head so the write wins
 * last-write-wins, but never further ahead than the relay's future-drift
 * window. If a skewed remote head sits beyond the window the manager loses LWW
 * and adopts it on the next fetch rather than walking past it and wedging.
 *
 * `nowSecs` defaults to the current wall clock in seconds; callers pass it
 * explicitly only to keep a single clock reading across a publish.
 */
export function clampPublishCreatedAt(
  lastRemoteCreatedAt: number,
  nowSecs: number = Math.floor(Date.now() / 1_000),
): number {
  return Math.min(
    Math.max(nowSecs, lastRemoteCreatedAt + 1),
    nowSecs + MAX_PUBLISH_FUTURE_SECS,
  );
}

// Monotonic fallback counter so two token mints in the same millisecond within
// one window (or in an environment without `crypto.randomUUID`) still differ.
let tokenCounter = 0;

/**
 * Mint a per-write ownership token for a durable outbox entry.
 *
 * Every window writes the outbox under one shared `(pubkey, relay)` key but
 * holds only an in-memory generation, so a completion in one window must never
 * clear an entry another window overwrote. The token identifies which write
 * produced the persisted entry: a completing publish clears only when the
 * stored token still matches the one it wrote (compare-and-clear), so a peer's
 * newer write — which replaced the token — survives an older window's ACK.
 *
 * Prefers `crypto.randomUUID` for cross-window uniqueness; the counter/time/
 * random fallback keeps tokens distinct where it is unavailable (older runtimes
 * and the test harness).
 */
export function mintOutboxToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `${Date.now().toString(36)}-${(tokenCounter++).toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Read a durable outbox entry, tolerating both the token envelope written by
 * this build (`{ store, token }`) and the bare-store shape written by a prior
 * build (token absent). Returns the parsed store plus its ownership token
 * (`null` for a legacy entry, which is therefore unconditionally clearable), or
 * `null` when the key is empty/unparseable or the store fails validation.
 */
export function readOutboxEntry<T>(
  key: string,
  parseStore: (json: unknown) => T | null,
): { store: T; token: string | null } | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const json = JSON.parse(raw);
    if (
      json !== null &&
      typeof json === "object" &&
      !Array.isArray(json) &&
      "store" in (json as Record<string, unknown>)
    ) {
      const env = json as { store: unknown; token?: unknown };
      const store = parseStore(env.store);
      if (!store) return null;
      return {
        store,
        token: typeof env.token === "string" ? env.token : null,
      };
    }
    // Legacy bare-store shape from a pre-token build. Token absent ⇒ clearable.
    const store = parseStore(json);
    if (!store) return null;
    return { store, token: null };
  } catch {
    return null;
  }
}

/** Persist a durable outbox entry as a token envelope. Best-effort. */
export function writeOutboxEntry(
  key: string,
  store: unknown,
  token: string,
): void {
  try {
    window.localStorage.setItem(key, JSON.stringify({ store, token }));
  } catch {
    // Best-effort durability; the in-memory pending edit still drives this
    // session's publish even if the persisted copy could not be written.
  }
}

/**
 * Clear a durable outbox entry with cross-window ownership.
 *
 * When `token` is provided this is a compare-and-clear: the entry is removed
 * only if its stored token still matches (or is a legacy token-less value).
 * A peer window that overwrote the entry replaced the token, so an older
 * window's completing publish no-ops here and the peer's still-unpublished
 * edit survives. An omitted `token` clears unconditionally (used when the
 * caller has already established there is nothing worth preserving).
 */
export function clearOutboxEntry(key: string, token?: string): void {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return;
    if (token !== undefined) {
      let stored: string | null = null;
      try {
        const json = JSON.parse(raw);
        if (
          json !== null &&
          typeof json === "object" &&
          typeof (json as { token?: unknown }).token === "string"
        ) {
          stored = (json as { token: string }).token;
        }
      } catch {
        // Unparseable ⇒ treat as legacy/foreign and fall through to remove.
      }
      // A newer write replaced our entry — leave it for its owner to clear.
      if (stored !== null && stored !== token) return;
    }
    window.localStorage.removeItem(key);
  } catch {
    // Ignore — a stale entry is re-evaluated (and re-cleared if identical to
    // the head) on the next publish attempt.
  }
}

/**
 * Tri-state result returned by every `fetchRemote*()` method.
 *
 * - `found`  — the relay returned an event that decrypted and parsed cleanly.
 * - `absent` — the relay was successfully queried and returned zero events
 *              (genuine first-time use on this relay).
 * - `failed` — the fetch threw (timeout, relay error, auth-race), or an event
 *              existed but could not be decrypted/parsed.  In the `failed`
 *              case, `createdAt` may be set when the event itself was readable
 *              even though its payload was not — the manager records the head
 *              so seed-publish is still blocked.
 */
export type FetchResult<T> =
  | { status: "found"; data: T; createdAt: number; eventId: string }
  | { status: "absent" }
  | { status: "failed"; createdAt?: number };

function watermarkKey(
  pubkey: string,
  blobType: string,
  relayUrl: string,
): string {
  return `${PREFIX}:${blobType}:${pubkey}:${encodeURIComponent(normalizeRelayUrl(relayUrl))}`;
}

/** Read the persisted watermark (0 when absent or on read error). */
export function readWatermark(
  pubkey: string,
  blobType: string,
  relayUrl: string,
): number {
  try {
    const raw = window.localStorage.getItem(
      watermarkKey(pubkey, blobType, relayUrl),
    );
    if (raw === null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Persist a new watermark if it is strictly greater than the current value.
 * Absence or error never lowers the watermark (monotonic).
 */
export function advanceWatermark(
  pubkey: string,
  blobType: string,
  relayUrl: string,
  next: number,
): void {
  try {
    const current = readWatermark(pubkey, blobType, relayUrl);
    if (next <= current) return;
    window.localStorage.setItem(
      watermarkKey(pubkey, blobType, relayUrl),
      String(next),
    );
  } catch {
    // Ignore write failures — the in-memory lastRemoteCreatedAt still guards
    // seed-publish within this session; the watermark is belt-and-suspenders
    // across sessions.
  }
}

/** Result returned by `bootstrap()` — the hook acts on this without publishing. */
export type BootstrapResult<T> =
  | { action: "apply-remote"; data: T }
  | { action: "hold" };

/**
 * Shared boot policy for all sidebar-preference sync managers.
 *
 * Each manager calls this from its `bootstrap()` method, supplying its
 * surface-specific fetch, publish, and local-store accessors.  The full
 * decision lives here once so that a mutation to any one surface cannot
 * escape via a per-manager copy.
 *
 * Policy:
 *   - `found`                           → return `apply-remote`; hook applies data.
 *   - `failed`                          → hold; seed-publish blocked (error or unreadable event).
 *   - `absent` + `lastHead > 0`         → hold; relay blob seen before, absence may be transient.
 *   - `absent` + `lastHead === 0` + non-empty local → call `publishFn(local)`; return `hold`.
 *   - `absent` + `lastHead === 0` + empty local     → hold; nothing to seed.
 */
export function runBootstrap<TRemote, TLocal>({
  fetchResult,
  lastHead,
  localStore,
  isLocalNonEmpty,
  publishFn,
}: {
  fetchResult: FetchResult<TRemote>;
  lastHead: number;
  localStore: TLocal;
  isLocalNonEmpty: (store: TLocal) => boolean;
  publishFn: (store: TLocal) => void;
}): BootstrapResult<TRemote> {
  if (fetchResult.status === "found") {
    return { action: "apply-remote", data: fetchResult.data };
  }
  if (fetchResult.status === "absent" && lastHead === 0) {
    if (isLocalNonEmpty(localStore)) {
      publishFn(localStore);
    }
  }
  return { action: "hold" };
}
