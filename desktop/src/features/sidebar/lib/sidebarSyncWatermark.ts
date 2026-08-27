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

// ── Per-window durable outbox (write-once, append-only) ──────────────────────
//
// Each sidebar-sync lane persists an unpublished edit so it survives a
// quit/community-switch inside the 2s publish debounce. The durability boundary
// is localStorage, which offers no atomic compare-and-delete or transactional
// read-modify-write: a single key shared across windows can never be mutated
// safely, and even a per-window key a window OVERWRITES can change between a
// peer's reclaim decision-read and its delete (the recheck race a byte-compare
// narrows but cannot close).
//
// The outbox is therefore keyed per window AND write-once. A key is
// `<prefix>:<pubkey>:<relay>:<nonce>:<seq>`, where `nonce` is stable for one
// window's lifetime (sessionStorage — survives reload, gone on window close) and
// `seq` is a per-window monotonic counter. A window NEVER rewrites a key: a new
// edit writes a NEW key (next `seq`) as a single unconditional `setItem`, then
// deletes its own now-superseded key(s). Both are own-key operations and the
// write precedes the delete, so a crash between them leaves ≥1 record for
// replay to coalesce, never zero.
//
// Because records are immutable, foreign reclamation is safe by construction: a
// booting window reads an immutable foreign record, proves it reclaimable
// against durable relay evidence, and deletes it. Nothing can have changed at
// that key since the proof — the only competing interleave is the owner
// deleting it first, and `removeItem` on an absent key is a no-op. No byte
// recheck and no destructive-path residual remain.
//   - merge lanes:      delete a record the fetched relay head already subsumes.
//   - whole-blob lanes:  delete a record the head STRICTLY supersedes
//                        (`queuedAt` < head `created_at`); a same-second record
//                        is kept until a strictly-newer head lands.
// Reclamation runs only after a successful head fetch, never touches this
// window's own keys, and never touches the legacy v1 shared key — that key is
// mutable (a live old-build window may be rewriting it) and its `queuedAt=0`
// makes supersession meaningless, so no gating makes deleting it safe; v2 only
// ever replays it. The bounded cost is at most one lingering legacy key per lane
// per (pubkey, relay), and only when the last old-build session quit with an
// unpublished edit.

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
 * once and parked in sessionStorage so a reload re-owns the same keys while a
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

/**
 * The base every own key for this (lane, pubkey, relay, window) shares:
 * `<prefix>:<pubkey>:<relay>:<nonce>`. Own keys append `:<seq>`.
 */
function ownKeyBase(prefix: string, pubkey: string, relayUrl: string): string {
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

// Per-window monotonic `seq`, keyed by own-key base. Lazily seeded above the max
// `seq` among this window's surviving own keys so a reload (nonce survives in
// sessionStorage, this in-memory counter restarts) can never reuse — and thus
// overwrite — a key. Overwriting an own key would silently break immutability
// and reopen the reclaim race.
const ownSeqCounter = new Map<string, number>();

// `seq` is zero-padded to a fixed width so a key's lexicographic order matches
// its numeric order. That makes the whole-blob replay tiebreak (max `queuedAt`,
// then key string) pick the higher `seq` — the newer edit — when a crash
// between write-new and delete-old leaves two same-second own keys with
// adjacent seqs that cross a digit boundary (…:9 vs …:10). 12 digits bound a
// window's edit count far past any reachable value.
const SEQ_WIDTH = 12;

/** This window's own keys for a base (`<base>:<seq>`). */
function ownKeys(base: string): string[] {
  const p = `${base}:`;
  return localStorageKeys().filter((k) => k.startsWith(p));
}

/** Allocate this window's next write-once own key for a base. */
function nextOwnKey(base: string): string {
  let last = ownSeqCounter.get(base);
  if (last === undefined) {
    last = -1;
    for (const k of ownKeys(base)) {
      const seq = Number(k.slice(base.length + 1));
      if (Number.isInteger(seq) && seq > last) last = seq;
    }
  }
  const seq = last + 1;
  ownSeqCounter.set(base, seq);
  return `${base}:${String(seq).padStart(SEQ_WIDTH, "0")}`;
}

/** A durable outbox record enumerated across all windows for a lane. */
export type OutboxRecord<T> = {
  key: string;
  store: T;
  // Seconds since epoch when the edit was queued (0 for a legacy entry written
  // before per-window keys, which therefore never wins a whole-blob tie).
  queuedAt: number;
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
 * Persist this window's unpublished edit under a fresh write-once key.
 *
 * Allocates the next `seq` for this window and `setItem`s the record there (a
 * single unconditional write — no read, no merge, no shared-key contention),
 * THEN deletes this window's older own keys. Write-before-delete: a crash
 * between the two leaves ≥1 record for replay to coalesce, never zero. Because
 * a key is written exactly once and never rewritten, a peer's boot-time reclaim
 * of a proven-stale foreign key can never race a rewrite. Best-effort: the
 * in-memory pending edit still drives this session's publish even if the
 * persisted copy could not be written.
 */
export function writeOwnOutbox(
  prefix: string,
  pubkey: string,
  relayUrl: string,
  store: unknown,
  nowSecs: number = Math.floor(Date.now() / 1_000),
): void {
  const base = ownKeyBase(prefix, pubkey, relayUrl);
  try {
    const key = nextOwnKey(base);
    window.localStorage.setItem(
      key,
      JSON.stringify({ store, queuedAt: nowSecs }),
    );
    // Drop this window's now-superseded own keys (all but the one just written).
    for (const k of ownKeys(base)) {
      if (k !== key) window.localStorage.removeItem(k);
    }
  } catch {
    // Best-effort durability.
  }
}

/** Remove all of this window's own outbox keys (its edit published or a no-op). */
export function clearOwnOutbox(
  prefix: string,
  pubkey: string,
  relayUrl: string,
): void {
  try {
    for (const k of ownKeys(ownKeyBase(prefix, pubkey, relayUrl))) {
      window.localStorage.removeItem(k);
    }
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
 * an edit persisted by a prior build still resumes; never reclaimed — see
 * `reclaimOutbox`).
 */
export function enumerateOutbox<T>(
  prefix: string,
  legacyKey: string,
  pubkey: string,
  relayUrl: string,
  parseStore: (json: unknown) => T | null,
): OutboxRecord<T>[] {
  const scopePrefix = outboxScopePrefix(prefix, pubkey, relayUrl);
  const ownPrefix = `${ownKeyBase(prefix, pubkey, relayUrl)}:`;
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
          isOwn: key.startsWith(ownPrefix),
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
 * shows are safe to drop (`shouldReclaim`). Records are write-once, so a proven
 * key cannot have changed since enumeration — the delete needs no recheck and
 * cannot destroy a peer's fresh edit (a new edit lives under a new key). Never
 * touches this window's own keys, and never touches the legacy v1 shared key:
 * that key is mutable and `queuedAt=0`, so no gating makes deleting it safe;
 * v2 only ever replays it. Call only after a successful head fetch.
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
    if (record.isOwn || record.key === legacyKey) continue;
    if (!shouldReclaim(record)) continue;
    try {
      window.localStorage.removeItem(record.key);
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
