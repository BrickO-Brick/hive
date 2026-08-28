import { normalizeRelayUrl } from "@/shared/lib/normalizeRelayUrl";
import {
  clearOwnOutbox,
  enumerateOutbox,
  reclaimOutbox,
  writeOwnOutbox,
} from "./sidebarSyncWatermark";

const STORAGE_KEY_PREFIX = "buzz-channel-stars.v1";
export const MAX_CHANNEL_STAR_ENTRIES = 500;

export type ChannelStarEntry = {
  starred: boolean;
  updatedAt: number;
  // Per-channel Lamport revision. Breaks a same-second `updatedAt` tie that the
  // integer clock cannot resolve. Absent in blobs from an older build ⇒ read as
  // 0 (a valid, mergeable value), so the payload stays `version: 1` and older
  // builds still parse our blobs.
  rev: number;
};

export type ChannelStarStore = {
  version: 1;
  channels: Record<string, ChannelStarEntry>;
};

export const DEFAULT_STORE: ChannelStarStore = Object.freeze({
  version: 1,
  channels: {},
});

/**
 * Returns the localStorage key for channel stars.
 *
 * When `relayUrl` is provided the key is scoped to that relay (normalized via
 * the same `normalizeRelayUrl` used by all relay-scoped local stores) so stars
 * from different communities/relays don't bleed across each other — in
 * particular so a non-empty store from relay A can never seed-publish onto a
 * first-visited relay B (Carl P1). When omitted the legacy pubkey-only key is
 * returned (used only during one-time migration in `readChannelStarsStore`).
 */
export function storageKey(pubkey: string, relayUrl?: string): string {
  if (!relayUrl) return `${STORAGE_KEY_PREFIX}:${pubkey}`;
  const normalized = normalizeRelayUrl(relayUrl);
  // Encode the normalized relay so it can't contain the `:` delimiter.
  return `${STORAGE_KEY_PREFIX}:${pubkey}:${encodeURIComponent(normalized)}`;
}

export function parseStarPayload(json: unknown): ChannelStarStore | null {
  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;
  if (obj.version !== 1) return null;
  const channels: Record<string, ChannelStarEntry> =
    typeof obj.channels === "object" &&
    obj.channels !== null &&
    !Array.isArray(obj.channels)
      ? Object.fromEntries(
          Object.entries(obj.channels as Record<string, unknown>)
            .filter((entry): entry is [string, Record<string, unknown>] => {
              const v = entry[1];
              return (
                typeof v === "object" &&
                v !== null &&
                typeof (v as Record<string, unknown>).starred === "boolean" &&
                typeof (v as Record<string, unknown>).updatedAt === "number" &&
                Number.isSafeInteger(
                  (v as Record<string, unknown>).updatedAt as number,
                ) &&
                ((v as Record<string, unknown>).updatedAt as number) >= 0
              );
            })
            // Normalize `rev`: accept a non-negative integer with headroom for
            // one mint, otherwise 0. An entry is never dropped solely because
            // `rev` is absent (older build) or malformed — absence is a valid
            // mergeable value. `rev >= Number.MAX_SAFE_INTEGER` is rejected:
            // the click path mints `maxRev + 1`, so accepting the boundary
            // itself would overflow to the same unsafe value and stop
            // advancing, wedging every later toggle. Requiring strictly-below
            // keeps `maxRev + 1` safe. Treating an out-of-range value as rev 0
            // lets a real later click win the same-second tie instead (Carl P2).
            .map(([id, v]) => {
              const rawRev = v.rev;
              const rev =
                typeof rawRev === "number" &&
                Number.isSafeInteger(rawRev) &&
                rawRev >= 0 &&
                rawRev < Number.MAX_SAFE_INTEGER
                  ? rawRev
                  : 0;
              return [
                id,
                {
                  starred: v.starred as boolean,
                  updatedAt: v.updatedAt as number,
                  rev,
                },
              ];
            }),
        )
      : {};
  return boundStarStore({ version: 1, channels });
}

function parseRaw(raw: string | null): ChannelStarStore | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || parsed.version !== 1) {
      return null;
    }
    return parseStarPayload(parsed);
  } catch {
    return null;
  }
}

/**
 * Read the star store for `pubkey` scoped to `relayUrl`.
 *
 * Enforces one invariant on every read: a scoped copy is exposed only while no
 * importable legacy (pubkey-only) key remains. If a non-empty legacy key still
 * exists — whether because this is the first scoped read or because a prior
 * migration wrote the scoped copy but could not delete the legacy key — we
 * finish the claim inline: write the scoped copy if absent, delete the legacy
 * key, and expose the value only once that delete provably took. On any storage
 * failure we return `DEFAULT_STORE`, which cannot seed-publish (bootstrap gates
 * on a non-empty local store), leaving the claim to complete on a later read
 * once storage recovers. This makes "scoped data is owned only when the legacy
 * key is gone" a property the reader proves every read, not a promise a
 * one-shot migration hopes to keep under failing storage — so relay A's stars
 * can never seed-publish onto a first-visited relay B (Carl P1).
 *
 * Concurrent windows are safe without an atomic claim. Each window (main and
 * huddle) takes its scope from the app-wide active community at mount, so the
 * first scoped read for a live legacy key runs before any second relay scope
 * can exist; that read either claims the legacy key or hits the failure path
 * above. A race migrates the identical legacy value to the identical scoped key
 * (idempotent), and the loser's post-delete confirmation fails and exposes
 * `DEFAULT_STORE`.
 */
export function readChannelStarsStore(
  pubkey: string,
  relayUrl?: string,
): ChannelStarStore {
  try {
    const key = storageKey(pubkey, relayUrl);
    const scoped = parseRaw(window.localStorage.getItem(key));

    // Unscoped read: the key IS the legacy key, so there is nothing to claim.
    if (!relayUrl) return scoped ?? DEFAULT_STORE;

    const legacyKey = storageKey(pubkey);
    const legacy = parseRaw(window.localStorage.getItem(legacyKey));
    const legacyHasData =
      legacy !== null && Object.keys(legacy.channels).length > 0;

    // No importable legacy value remains — an existing scoped copy is proven
    // owned. This short-circuits every read after a completed claim.
    if (!legacyHasData) return scoped ?? DEFAULT_STORE;

    // A consumable legacy key still coexists with (or would seed) the scoped
    // key; neither is safe to expose until that legacy key is provably gone.
    return claimLegacy(key, legacyKey, scoped ?? legacy, scoped !== null);
  } catch {
    return DEFAULT_STORE;
  }
}

/**
 * Enforce the ownership invariant: expose `owned` only once the legacy key is
 * provably gone. Write the scoped copy when it is not already present, delete
 * the legacy key, and confirm the delete took. On any failure return
 * `DEFAULT_STORE`, rolling back only a scoped copy WE just wrote — never a
 * pre-existing one, whose deletion could itself throw and lose owned data. An
 * unproven copy is thus never exposed while the legacy key can still be
 * imported by another relay; the next read re-attempts once storage recovers.
 */
function claimLegacy(
  key: string,
  legacyKey: string,
  owned: ChannelStarStore,
  scopedExists: boolean,
): ChannelStarStore {
  try {
    if (!scopedExists) window.localStorage.setItem(key, JSON.stringify(owned));
    window.localStorage.removeItem(legacyKey);
    if (window.localStorage.getItem(legacyKey) !== null) {
      // Delete did not take — do not expose data another relay could import.
      if (!scopedExists) window.localStorage.removeItem(key);
      return DEFAULT_STORE;
    }
    return owned;
  } catch {
    if (!scopedExists) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Best effort. A stuck scoped copy is re-exposed only by a future read
        // that proves the legacy key gone, so it can never seed early.
      }
    }
    return DEFAULT_STORE;
  }
}

export function boundStarStore(
  store: ChannelStarStore,
  preservedKey?: string,
): ChannelStarStore {
  const preservedEntry =
    preservedKey === undefined ? undefined : store.channels[preservedKey];
  const entries = Object.entries(store.channels).filter(
    ([channelId]) => channelId !== preservedKey,
  );
  if (entries.length + (preservedEntry ? 1 : 0) <= MAX_CHANNEL_STAR_ENTRIES)
    return store;
  entries.sort(([leftId, left], [rightId, right]) => {
    if (left.updatedAt !== right.updatedAt)
      return left.updatedAt - right.updatedAt;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  const retainedEntries = entries.slice(
    -(MAX_CHANNEL_STAR_ENTRIES - (preservedEntry ? 1 : 0)),
  );
  if (preservedEntry && preservedKey !== undefined) {
    retainedEntries.push([preservedKey, preservedEntry]);
  }
  return {
    ...store,
    channels: Object.fromEntries(retainedEntries),
  };
}

/**
 * Persist the main store. Writes the passed store as-is (bounded) — no read of
 * the shared key, so it is never a shared-key read-modify-write. Callers merge
 * peer state into the window's OWN React state (via the storage-event handler
 * and applyRemote) before calling here, so the write carries an owned, merged
 * value. Returns the bounded store, or `null` on write failure.
 *
 * Cross-window convergence of the on-disk cache is eventual: a peer's storage
 * event folds into this window's state, and the relay reconcile writes the
 * merged head back. Durable no-loss of an unpublished click is held by the
 * per-window outbox, not this cache.
 */
export function writeChannelStarsStore(
  pubkey: string,
  store: ChannelStarStore,
  relayUrl?: string,
  preservedKey?: string,
): ChannelStarStore | null {
  try {
    const bounded = boundStarStore(store, preservedKey);
    window.localStorage.setItem(
      storageKey(pubkey, relayUrl),
      JSON.stringify(bounded),
    );
    return bounded;
  } catch {
    return null;
  }
}

/**
 * Merge two star stores by a per-channel total order:
 * `updatedAt` DESC → `rev` DESC → `starred === true` wins. This order is
 * commutative, associative, and idempotent (before bounding), so every
 * observation path (bootstrap, live, reconnect, reconcile, pre-publish,
 * cross-window storage) applies it with no ordering or ownership overlay and
 * all replicas converge.
 *
 * `updatedAt` is primary so a strictly-later edit — from any build, whether it
 * carries `rev` or (older build) reads `rev: 0` — wins outright. `rev` breaks
 * only a same-second `updatedAt` tie: the ambiguous integer-second window the
 * clock cannot resolve, where a NEW-build click that minted `rev = maxSeen + 1`
 * dominates same-second state it observed. On a full tie (equal `updatedAt` AND
 * equal `rev`) `true` wins as the deterministic leaf.
 *
 * ACCEPTED MIXED-FLEET RESIDUAL (Carl P1 #5, no protocol change): an OLD build
 * mints no `rev`, so its click reads `rev: 0`. A later old-build click that
 * lands in the SAME integer second as an earlier new-build write carrying
 * `rev >= 1` therefore loses that same-second tie — the old click's intent is
 * suppressed until the user clicks again in a strictly-later second, when the
 * primary `updatedAt` key carries it. This is bounded (one integer second,
 * old-build writer only, self-heals on the next later-second click) and is no
 * worse than the shipped LWW behavior; closing it would need a version
 * migration we deliberately do not build. `mergeStores: same-second old-build
 * click (rev 0) loses to an earlier new-build rev, heals next second` pins the
 * exact current outcome.
 */
export function mergeStores(
  a: ChannelStarStore,
  b: ChannelStarStore,
  preservedKey?: string,
): ChannelStarStore {
  const allIds = new Set([
    ...Object.keys(a.channels),
    ...Object.keys(b.channels),
  ]);
  const merged: Record<string, ChannelStarEntry> = {};
  for (const id of allIds) {
    const l = a.channels[id];
    const r = b.channels[id];
    merged[id] = l && r ? pickStarEntry(l, r) : ((l ?? r) as ChannelStarEntry);
  }
  return boundStarStore({ version: 1, channels: merged }, preservedKey);
}

/** The winner of two entries under `updatedAt` → `rev` → `starred` order. */
function pickStarEntry(
  l: ChannelStarEntry,
  r: ChannelStarEntry,
): ChannelStarEntry {
  if (l.updatedAt !== r.updatedAt) return l.updatedAt > r.updatedAt ? l : r;
  if (l.rev !== r.rev) return l.rev > r.rev ? l : r;
  if (l.starred !== r.starred) return l.starred ? l : r;
  return l;
}

export function starredChannelIdsFromStore(
  store: ChannelStarStore,
): Set<string> {
  return new Set(
    Object.entries(store.channels)
      .filter(([, entry]) => entry.starred)
      .map(([id]) => id),
  );
}

const OUTBOX_KEY_PREFIX = "buzz-channel-stars-outbox.v1";

// The single shared key written by builds before the outbox was keyed
// per-window. Enumerated as one more record so an edit persisted by a prior
// build still resumes, and reclaimed by the same relay-gated rule.
function legacyOutboxKey(pubkey: string, relayUrl: string): string {
  return `${OUTBOX_KEY_PREFIX}:${pubkey}:${encodeURIComponent(normalizeRelayUrl(relayUrl))}`;
}

/**
 * Persist this window's unpublished edit under its own outbox key. Written
 * synchronously on every click as a single unconditional `setItem` (no shared-
 * key read-modify-write); resumed by merging every window's record on next
 * mount so a click made <2s before quit/community-switch is never dropped.
 */
export function writeChannelStarsOutbox(
  pubkey: string,
  store: ChannelStarStore,
  relayUrl: string,
): void {
  writeOwnOutbox(OUTBOX_KEY_PREFIX, pubkey, relayUrl, boundStarStore(store));
}

/**
 * Merge every window's persisted unpublished edit into one store for resume, or
 * null when none exists. Per-entry `mergeStores` is order-independent, so two
 * windows' concurrent clicks on different channels both survive.
 */
export function readChannelStarsOutbox(
  pubkey: string,
  relayUrl: string,
): ChannelStarStore | null {
  const records = enumerateOutbox(
    OUTBOX_KEY_PREFIX,
    legacyOutboxKey(pubkey, relayUrl),
    pubkey,
    relayUrl,
    parseStarPayload,
  );
  if (records.length === 0) return null;
  return records.reduce<ChannelStarStore>(
    (acc, r) => mergeStores(acc, r.store),
    DEFAULT_STORE,
  );
}

/** Clear this window's own outbox key (its edit published or is a no-op). */
export function clearChannelStarsOutbox(
  pubkey: string,
  relayUrl: string,
): void {
  clearOwnOutbox(OUTBOX_KEY_PREFIX, pubkey, relayUrl);
}

/**
 * True when the fetched relay `head` already reflects every entry in
 * `candidate` — merging the candidate into the head leaves it unchanged. Used
 * both to reclaim a subsumed foreign key and to skip a redundant boot-time
 * replay publish of a fold the head already carries (e.g. only the
 * never-deleted legacy key lingers).
 */
export function isStarsStoreSubsumedBy(
  candidate: ChannelStarStore,
  head: ChannelStarStore,
): boolean {
  return starStoresEqual(mergeStores(head, candidate), head);
}

/**
 * Reclaim foreign outbox keys the fetched relay head already subsumes: a record
 * is redundant when merging it into `head` yields `head` unchanged (the head
 * carries an entry at least as new for every channel). Never touches this
 * window's own key; a still-unpublished peer edit the head does not yet reflect
 * is kept. Call only after a successful head fetch.
 */
export function reclaimSubsumedStarsOutbox(
  pubkey: string,
  relayUrl: string,
  head: ChannelStarStore,
): void {
  reclaimOutbox(
    OUTBOX_KEY_PREFIX,
    legacyOutboxKey(pubkey, relayUrl),
    pubkey,
    relayUrl,
    parseStarPayload,
    (record) => isStarsStoreSubsumedBy(record.store, head),
  );
}

/** Deep per-channel equality of two star stores (order-independent). */
function starStoresEqual(a: ChannelStarStore, b: ChannelStarStore): boolean {
  const aKeys = Object.keys(a.channels);
  const bKeys = Object.keys(b.channels);
  if (aKeys.length !== bKeys.length) return false;
  for (const id of aKeys) {
    const l = a.channels[id];
    const r = b.channels[id];
    if (
      !r ||
      l.starred !== r.starred ||
      l.updatedAt !== r.updatedAt ||
      l.rev !== r.rev
    )
      return false;
  }
  return true;
}
