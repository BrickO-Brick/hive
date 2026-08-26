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

// ── Per-window durable outbox ────────────────────────────────────────────────
//
// Each sidebar-sync lane persists an unpublished edit so it survives a
// quit/community-switch inside the 2s publish debounce. The durability boundary
// is localStorage, which offers no atomic compare-and-delete or transactional
// read-modify-write, so a single key shared across every window can never be
// mutated safely: one window's read→write or read→remove can race a peer's
// write in the gap and drop its still-unpublished edit (the defect a per-write
// ownership token could narrow but not close).
//
// The outbox is therefore keyed PER WINDOW:
// `<prefix>:<pubkey>:<relay>:<nonce>`, where `nonce` is stable for one window's
// lifetime (parked in sessionStorage — survives reload, gone on window close).
// Each window is the ONLY writer of its own key, so a hot-path write is a single
// unconditional `setItem` with no read and no shared-key contention: the write
// race is designed out rather than guarded.
//
// A window clears only its own key once its publish completes. Redundant foreign
// keys (a peer that published then crashed, or an edit the relay has since
// absorbed) are reclaimed at boot, gated on durable relay evidence so a live
// peer's genuinely-unpublished edit is never destroyed:
//   - merge lanes:      delete a record the fetched relay head already subsumes.
//   - whole-blob lanes:  delete a record the head's own timestamp supersedes
//                        (`queuedAt` ≤ head `created_at`) — never one that
//                        merely loses a local comparison.
// Reclamation runs only when the head fetch succeeded, never on a failed fetch,
// and re-reads each foreign key immediately before removing it so a value that
// changed since the decision is left for its owner. This is not atomic —
// localStorage cannot be — but it narrows the residual to a recheck→remove gap
// that additionally requires the owner to quit before its own debounce publish
// (its in-memory pending re-drives otherwise). After any successful publish the
// relay head is newest, so foreign keys still drain to zero across boots.

const OUTBOX_WINDOW_NONCE_KEY = "buzz-sidebar-outbox-window.v1";

// Monotonic fallback counter so two mints in the same millisecond (or in an
// environment without `crypto.randomUUID`) still differ.
let nonceCounter = 0;
let cachedWindowNonce: string | null = null;

function mintNonce(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `${Date.now().toString(36)}-${(nonceCounter++).toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The stable per-window nonce that scopes this window's outbox keys. Minted
 * once and parked in sessionStorage so a reload re-owns the same key while a
 * new window gets its own; an unavailable sessionStorage (private mode, test
 * harness without one) falls back to a process-lifetime in-memory nonce.
 */
export function outboxWindowNonce(): string {
  if (cachedWindowNonce !== null) return cachedWindowNonce;
  try {
    const existing = window.sessionStorage.getItem(OUTBOX_WINDOW_NONCE_KEY);
    if (existing) {
      cachedWindowNonce = existing;
      return existing;
    }
    const nonce = mintNonce();
    window.sessionStorage.setItem(OUTBOX_WINDOW_NONCE_KEY, nonce);
    cachedWindowNonce = nonce;
    return nonce;
  } catch {
    cachedWindowNonce = mintNonce();
    return cachedWindowNonce;
  }
}

function scopeSuffix(pubkey: string, relayUrl: string): string {
  return `${pubkey}:${encodeURIComponent(normalizeRelayUrl(relayUrl))}`;
}

/** This window's own outbox key — the only key it ever writes or removes. */
export function ownOutboxKey(
  prefix: string,
  pubkey: string,
  relayUrl: string,
): string {
  return `${prefix}:${scopeSuffix(pubkey, relayUrl)}:${outboxWindowNonce()}`;
}

/** Prefix every window's key for this (lane, pubkey, relay) starts with. */
function outboxScopePrefix(
  prefix: string,
  pubkey: string,
  relayUrl: string,
): string {
  return `${prefix}:${scopeSuffix(pubkey, relayUrl)}:`;
}

/** A durable outbox record enumerated across all windows for a lane. */
export type OutboxRecord<T> = {
  key: string;
  store: T;
  // Seconds since epoch when the edit was queued (0 for a legacy entry written
  // before per-window keys, which therefore never wins a whole-blob tie).
  queuedAt: number;
  // The exact stored string at enumeration time, for the pre-delete recheck.
  raw: string;
  isOwn: boolean;
};

/**
 * Parse a stored outbox value, tolerating the per-window envelope
 * (`{ store, queuedAt }`), the previous token envelope (`{ store, token }` ⇒
 * `queuedAt` 0), and a bare store from an even older build (⇒ `queuedAt` 0).
 */
function parseEnvelope<T>(
  raw: string | null,
  parseStore: (json: unknown) => T | null,
): { store: T; queuedAt: number } | null {
  if (!raw) return null;
  try {
    const json = JSON.parse(raw);
    if (
      json !== null &&
      typeof json === "object" &&
      !Array.isArray(json) &&
      "store" in (json as Record<string, unknown>)
    ) {
      const env = json as { store: unknown; queuedAt?: unknown };
      const store = parseStore(env.store);
      if (!store) return null;
      const queuedAt =
        typeof env.queuedAt === "number" && Number.isFinite(env.queuedAt)
          ? env.queuedAt
          : 0;
      return { store, queuedAt };
    }
    // Legacy bare-store shape from a pre-envelope build.
    const store = parseStore(json);
    if (!store) return null;
    return { store, queuedAt: 0 };
  } catch {
    return null;
  }
}

/**
 * Persist this window's unpublished edit under its own key. A single
 * unconditional `setItem` — no read, no merge, no shared-key contention.
 * Best-effort: the in-memory pending edit still drives this session's publish
 * even if the persisted copy could not be written.
 */
export function writeOwnOutbox(
  prefix: string,
  pubkey: string,
  relayUrl: string,
  store: unknown,
  nowSecs: number = Math.floor(Date.now() / 1_000),
): void {
  try {
    window.localStorage.setItem(
      ownOutboxKey(prefix, pubkey, relayUrl),
      JSON.stringify({ store, queuedAt: nowSecs }),
    );
  } catch {
    // Best-effort durability.
  }
}

/** Remove this window's own outbox key (its edit published or is a no-op). */
export function clearOwnOutbox(
  prefix: string,
  pubkey: string,
  relayUrl: string,
): void {
  try {
    window.localStorage.removeItem(ownOutboxKey(prefix, pubkey, relayUrl));
  } catch {
    // Ignore — a stale own key is re-evaluated on the next publish/boot.
  }
}

function localStorageKeys(): string[] {
  const ls = window.localStorage;
  const keys: string[] = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k !== null) keys.push(k);
  }
  return keys;
}

/**
 * Enumerate every window's durable outbox record for a lane, plus the single
 * legacy shared key from a pre-per-window build (treated as one more record so
 * an edit persisted by a prior build still resumes and is later reclaimed).
 */
export function enumerateOutbox<T>(
  prefix: string,
  legacyKey: string,
  pubkey: string,
  relayUrl: string,
  parseStore: (json: unknown) => T | null,
): OutboxRecord<T>[] {
  const scopePrefix = outboxScopePrefix(prefix, pubkey, relayUrl);
  const own = ownOutboxKey(prefix, pubkey, relayUrl);
  const records: OutboxRecord<T>[] = [];
  try {
    for (const key of localStorageKeys()) {
      if (!key.startsWith(scopePrefix)) continue;
      const raw = window.localStorage.getItem(key);
      const parsed = parseEnvelope(raw, parseStore);
      if (parsed && raw !== null) {
        records.push({
          key,
          store: parsed.store,
          queuedAt: parsed.queuedAt,
          raw,
          isOwn: key === own,
        });
      }
    }
    const legacyRaw = window.localStorage.getItem(legacyKey);
    const legacy = parseEnvelope(legacyRaw, parseStore);
    if (legacy && legacyRaw !== null) {
      records.push({
        key: legacyKey,
        store: legacy.store,
        queuedAt: legacy.queuedAt,
        raw: legacyRaw,
        isOwn: false,
      });
    }
  } catch {
    // Return whatever parsed before the failure.
  }
  return records;
}

/**
 * Reclaim redundant FOREIGN outbox keys whose edits durable relay evidence
 * shows are safe to drop (`shouldReclaim`). Never touches this window's own
 * key. Re-reads each key immediately before removing it and skips if the stored
 * value changed since enumeration, so a live owner's fresh write is preserved.
 */
export function reclaimOutbox<T>(
  prefix: string,
  legacyKey: string,
  pubkey: string,
  relayUrl: string,
  parseStore: (json: unknown) => T | null,
  shouldReclaim: (record: OutboxRecord<T>) => boolean,
): void {
  for (const record of enumerateOutbox(
    prefix,
    legacyKey,
    pubkey,
    relayUrl,
    parseStore,
  )) {
    if (record.isOwn) continue;
    if (!shouldReclaim(record)) continue;
    try {
      // Recheck: only remove if the value is byte-identical to what the
      // reclaim decision was made against. A peer that rewrote the key in the
      // gap owns a fresh edit we must not destroy.
      if (window.localStorage.getItem(record.key) === record.raw) {
        window.localStorage.removeItem(record.key);
      }
    } catch {
      // Leave for the next boot's reclamation.
    }
  }
}

/**
 * The single winning record among all windows' whole-blob outbox entries for
 * resume: max `queuedAt`, ties broken by the (nonce-bearing) key string so the
 * choice is deterministic across windows. Null when no record exists.
 *
 * Whole-blob LWW means only the newest queued intent is replayed; an older
 * blob a peer queued is superseded by definition and never resurrected.
 */
export function latestOutbox<T>(
  prefix: string,
  legacyKey: string,
  pubkey: string,
  relayUrl: string,
  parseStore: (json: unknown) => T | null,
): T | null {
  let best: OutboxRecord<T> | null = null;
  for (const record of enumerateOutbox(
    prefix,
    legacyKey,
    pubkey,
    relayUrl,
    parseStore,
  )) {
    if (
      best === null ||
      record.queuedAt > best.queuedAt ||
      (record.queuedAt === best.queuedAt && record.key > best.key)
    ) {
      best = record;
    }
  }
  return best?.store ?? null;
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
