import { normalizeRelayUrl } from "@/shared/lib/normalizeRelayUrl";
import {
  clearOwnOutbox,
  enumerateOutbox,
  reclaimOutbox,
  writeOwnOutbox,
} from "./sidebarSyncWatermark";

const STORAGE_KEY_PREFIX = "buzz-channel-mutes.v1";
export const MAX_CHANNEL_MUTE_ENTRIES = 500;

export type ChannelMuteEntry = {
  muted: boolean;
  updatedAt: number;
  // Per-channel Lamport revision. Breaks a same-second `updatedAt` tie that the
  // integer clock cannot resolve. Absent in blobs from an older build ⇒ read as
  // 0 (a valid, mergeable value), so the payload stays `version: 1` and older
  // builds still parse our blobs.
  rev: number;
};

export type ChannelMuteStore = {
  version: 1;
  channels: Record<string, ChannelMuteEntry>;
};

export const DEFAULT_STORE: ChannelMuteStore = Object.freeze({
  version: 1,
  channels: {},
});

export function storageKey(pubkey: string): string {
  return `${STORAGE_KEY_PREFIX}:${pubkey}`;
}

export function parseMutePayload(json: unknown): ChannelMuteStore | null {
  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;
  if (obj.version !== 1) return null;
  const channels: Record<string, ChannelMuteEntry> =
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
                typeof (v as Record<string, unknown>).muted === "boolean" &&
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
                  muted: v.muted as boolean,
                  updatedAt: v.updatedAt as number,
                  rev,
                },
              ];
            }),
        )
      : {};
  return boundMuteStore({ version: 1, channels });
}

export function readChannelMutesStore(pubkey: string): ChannelMuteStore {
  try {
    const raw = window.localStorage.getItem(storageKey(pubkey));
    if (!raw) {
      return DEFAULT_STORE;
    }
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || parsed.version !== 1) {
      return DEFAULT_STORE;
    }
    return parseMutePayload(parsed) ?? DEFAULT_STORE;
  } catch {
    return DEFAULT_STORE;
  }
}

export function boundMuteStore(
  store: ChannelMuteStore,
  preservedKey?: string,
): ChannelMuteStore {
  const preservedEntry =
    preservedKey === undefined ? undefined : store.channels[preservedKey];
  const entries = Object.entries(store.channels).filter(
    ([channelId]) => channelId !== preservedKey,
  );
  if (entries.length + (preservedEntry ? 1 : 0) <= MAX_CHANNEL_MUTE_ENTRIES)
    return store;
  entries.sort(([leftId, left], [rightId, right]) => {
    if (left.updatedAt !== right.updatedAt)
      return left.updatedAt - right.updatedAt;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  const retainedEntries = entries.slice(
    -(MAX_CHANNEL_MUTE_ENTRIES - (preservedEntry ? 1 : 0)),
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
export function writeChannelMutesStore(
  pubkey: string,
  store: ChannelMuteStore,
  preservedKey?: string,
): ChannelMuteStore | null {
  try {
    const bounded = boundMuteStore(store, preservedKey);
    window.localStorage.setItem(storageKey(pubkey), JSON.stringify(bounded));
    return bounded;
  } catch {
    return null;
  }
}

/**
 * Merge two mute stores by a per-channel total order:
 * `updatedAt` DESC → `rev` DESC → `muted === true` wins. This order is
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
  a: ChannelMuteStore,
  b: ChannelMuteStore,
  preservedKey?: string,
): ChannelMuteStore {
  const allIds = new Set([
    ...Object.keys(a.channels),
    ...Object.keys(b.channels),
  ]);
  const merged: Record<string, ChannelMuteEntry> = {};
  for (const id of allIds) {
    const l = a.channels[id];
    const r = b.channels[id];
    merged[id] = l && r ? pickMuteEntry(l, r) : ((l ?? r) as ChannelMuteEntry);
  }
  return boundMuteStore({ version: 1, channels: merged }, preservedKey);
}

/** The winner of two entries under `updatedAt` → `rev` → `muted` order. */
function pickMuteEntry(
  l: ChannelMuteEntry,
  r: ChannelMuteEntry,
): ChannelMuteEntry {
  if (l.updatedAt !== r.updatedAt) return l.updatedAt > r.updatedAt ? l : r;
  if (l.rev !== r.rev) return l.rev > r.rev ? l : r;
  if (l.muted !== r.muted) return l.muted ? l : r;
  return l;
}

export function mutedChannelIdsFromStore(store: ChannelMuteStore): Set<string> {
  return new Set(
    Object.entries(store.channels)
      .filter(([, entry]) => entry.muted)
      .map(([id]) => id),
  );
}

const OUTBOX_KEY_PREFIX = "buzz-channel-mutes-outbox.v1";

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
export function writeChannelMutesOutbox(
  pubkey: string,
  store: ChannelMuteStore,
  relayUrl: string,
): void {
  writeOwnOutbox(OUTBOX_KEY_PREFIX, pubkey, relayUrl, boundMuteStore(store));
}

/**
 * Merge every window's persisted unpublished edit into one store for resume, or
 * null when none exists. Per-entry `mergeStores` is order-independent, so two
 * windows' concurrent clicks on different channels both survive.
 */
export function readChannelMutesOutbox(
  pubkey: string,
  relayUrl: string,
): ChannelMuteStore | null {
  const records = enumerateOutbox(
    OUTBOX_KEY_PREFIX,
    legacyOutboxKey(pubkey, relayUrl),
    pubkey,
    relayUrl,
    parseMutePayload,
  );
  if (records.length === 0) return null;
  return records.reduce<ChannelMuteStore>(
    (acc, r) => mergeStores(acc, r.store),
    DEFAULT_STORE,
  );
}

/** Clear this window's own outbox key (its edit published or is a no-op). */
export function clearChannelMutesOutbox(
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
export function isMutesStoreSubsumedBy(
  candidate: ChannelMuteStore,
  head: ChannelMuteStore,
): boolean {
  return muteStoresEqual(mergeStores(head, candidate), head);
}

/**
 * Reclaim foreign outbox keys the fetched relay head already subsumes: a record
 * is redundant when merging it into `head` yields `head` unchanged (the head
 * carries an entry at least as new for every channel). Never touches this
 * window's own key; a still-unpublished peer edit the head does not yet reflect
 * is kept. Call only after a successful head fetch.
 */
export function reclaimSubsumedMutesOutbox(
  pubkey: string,
  relayUrl: string,
  head: ChannelMuteStore,
): void {
  reclaimOutbox(
    OUTBOX_KEY_PREFIX,
    legacyOutboxKey(pubkey, relayUrl),
    pubkey,
    relayUrl,
    parseMutePayload,
    (record) => isMutesStoreSubsumedBy(record.store, head),
  );
}

/** Deep per-channel equality of two mute stores (order-independent). */
function muteStoresEqual(a: ChannelMuteStore, b: ChannelMuteStore): boolean {
  const aKeys = Object.keys(a.channels);
  const bKeys = Object.keys(b.channels);
  if (aKeys.length !== bKeys.length) return false;
  for (const id of aKeys) {
    const l = a.channels[id];
    const r = b.channels[id];
    if (
      !r ||
      l.muted !== r.muted ||
      l.updatedAt !== r.updatedAt ||
      l.rev !== r.rev
    )
      return false;
  }
  return true;
}
