import { normalizeRelayUrl } from "@/shared/lib/normalizeRelayUrl";
import {
  clearOutboxEntry,
  readOutboxEntry,
  writeOutboxEntry,
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

export function storageKey(pubkey: string): string {
  return `${STORAGE_KEY_PREFIX}:${pubkey}`;
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
                Number.isFinite(
                  (v as Record<string, unknown>).updatedAt as number,
                ) &&
                ((v as Record<string, unknown>).updatedAt as number) >= 0
              );
            })
            // Normalize `rev`: accept a non-negative integer, otherwise 0. An
            // entry is never dropped solely because `rev` is absent (older
            // build) or malformed — absence is a valid mergeable value.
            .map(([id, v]) => {
              const rawRev = v.rev;
              const rev =
                typeof rawRev === "number" &&
                Number.isInteger(rawRev) &&
                rawRev >= 0
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

export function readChannelStarsStore(pubkey: string): ChannelStarStore {
  try {
    const raw = window.localStorage.getItem(storageKey(pubkey));
    if (!raw) {
      return DEFAULT_STORE;
    }
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || parsed.version !== 1) {
      return DEFAULT_STORE;
    }
    return parseStarPayload(parsed) ?? DEFAULT_STORE;
  } catch {
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
 * Read-merge-write the main store: fold `incoming` into whatever is currently
 * persisted (which a peer window may have advanced since this window last read)
 * and persist + return the merged result, so a concurrent click in another
 * window is carried forward instead of clobbered. Returns the merged store, or
 * `null` on write failure. Uses the same per-entry `mergeStores` as every other
 * observation path, so the write is order-independent and idempotent.
 */
export function writeChannelStarsStore(
  pubkey: string,
  incoming: ChannelStarStore,
  preservedKey?: string,
): ChannelStarStore | null {
  try {
    const persisted = readChannelStarsStore(pubkey);
    const merged = mergeStores(persisted, incoming, preservedKey);
    window.localStorage.setItem(storageKey(pubkey), JSON.stringify(merged));
    return merged;
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
 * clock cannot resolve, where a click that minted `rev = maxSeen + 1` dominates
 * any same-second state it observed. On a full tie (equal `updatedAt` AND equal
 * `rev`) `true` wins as the deterministic leaf.
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

// The outbox is a per-relay sync-lane structure (like the watermark), so it is
// relay-scoped even though the main store stays pubkey-only: an edit made
// against relay A must never resume-publish onto relay B after a community
// switch.
function outboxKey(pubkey: string, relayUrl: string): string {
  return `${OUTBOX_KEY_PREFIX}:${pubkey}:${encodeURIComponent(normalizeRelayUrl(relayUrl))}`;
}

/**
 * Persist an unpublished edit so it survives quit/community-switch within the
 * 2s publish debounce. Written synchronously on every click; cleared once the
 * edit is published or found identical to the last published store. Resumed on
 * next mount so a durable intent is never silently dropped at teardown.
 *
 * Read-merge-write: the incoming edit is folded (via `mergeStores`) into
 * whatever a peer window may have already persisted under the shared key, so
 * two windows clicking different channels before their `storage` events deliver
 * both survive in the durable outbox. `token` gives this write cross-window
 * ownership so a peer's older completing publish cannot clear the merged entry.
 */
export function writeChannelStarsOutbox(
  pubkey: string,
  store: ChannelStarStore,
  relayUrl: string,
  token: string,
): void {
  const key = outboxKey(pubkey, relayUrl);
  const existing = readOutboxEntry(key, parseStarPayload)?.store;
  const merged = existing
    ? mergeStores(existing, store)
    : boundStarStore(store);
  writeOutboxEntry(key, merged, token);
}

/** Read a persisted unpublished edit, or null when none/unparseable. */
export function readChannelStarsOutbox(
  pubkey: string,
  relayUrl: string,
): ChannelStarStore | null {
  return (
    readOutboxEntry(outboxKey(pubkey, relayUrl), parseStarPayload)?.store ??
    null
  );
}

/**
 * Clear the persisted outbox (edit published or a no-op). Compare-and-clear on
 * `token`: a peer window that overwrote the entry replaced the token, so an
 * older window's completion no-ops and the peer's edit survives. Omit `token`
 * to clear unconditionally.
 */
export function clearChannelStarsOutbox(
  pubkey: string,
  relayUrl: string,
  token?: string,
): void {
  clearOutboxEntry(outboxKey(pubkey, relayUrl), token);
}
