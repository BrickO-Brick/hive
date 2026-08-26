import * as React from "react";

import { relayClient } from "@/shared/api/relayClient";
import {
  boundChannelSortStore,
  clearChannelSortOutbox,
  DEFAULT_STORE,
  readChannelSortOutbox,
  readChannelSortStore,
  sortModeForGroup,
  storageKey,
  stripOrphanedSectionModes,
  writeChannelSortStore,
  type ChannelSortGroupKey,
  type ChannelSortMode,
  type ChannelSortStore,
} from "./channelSortPreference";
import { ChannelSortSyncManager } from "./channelSortSync";
import type { RemoteSortPrefs } from "./channelSortSync";

// Reconciliation cadence (mirrors sections). Steady interval re-fetches the head
// on a healthy socket so divergence self-heals without a reconnect; the retry
// window backs off from base to max while the fetch keeps failing.
const RECONCILE_STEADY_MS = 60_000;
const RECONCILE_RETRY_BASE_MS = 3_000;
const RECONCILE_RETRY_MAX_MS = 60_000;

/**
 * Persistent per-group sidebar sort preferences, scoped by pubkey + relay so
 * they don't bleed across identities or communities (same scoping as channel
 * sections). Each sidebar grouping (starred, channels, forums, dms, and each
 * custom section) carries its own saved Recent/A–Z mode; unset groups default
 * to A–Z. Mirrors changes made in other windows via the storage event.
 *
 * Preferences sync across clients via encrypted NIP-78 app data (kind 30078,
 * d-tag `channel-sort`), following the channel-sections pattern: localStorage
 * stays the instant/offline cache, the relay blob is the cross-client source
 * of truth, and conflicts resolve with whole-blob last-write-wins.
 *
 * When `liveSectionIds` is provided, writes also prune `section:<id>` entries
 * whose custom section no longer exists, so deleted sections don't leave
 * stale keys in localStorage.
 */
export function useChannelSortPreference(
  pubkey: string | undefined,
  relayUrl?: string,
  liveSectionIds?: string[],
): {
  sortModeFor: (group: ChannelSortGroupKey) => ChannelSortMode;
  setSortModeFor: (group: ChannelSortGroupKey, mode: ChannelSortMode) => void;
} {
  const [store, setStore] = React.useState<ChannelSortStore>(() => {
    if (!pubkey) return DEFAULT_STORE;
    return readChannelSortStore(pubkey, relayUrl);
  });

  const managerRef = React.useRef<ChannelSortSyncManager | null>(null);
  const lastAppliedRemoteTs = React.useRef(0);
  const lastAppliedEventId = React.useRef("");

  React.useEffect(() => {
    if (!pubkey || !relayUrl) {
      setStore(DEFAULT_STORE);
      lastAppliedRemoteTs.current = 0;
      lastAppliedEventId.current = "";
      return;
    }
    setStore(readChannelSortStore(pubkey, relayUrl));
    lastAppliedRemoteTs.current = 0;
    lastAppliedEventId.current = "";
    managerRef.current = new ChannelSortSyncManager(pubkey, relayUrl);
    return () => {
      managerRef.current?.destroy();
      managerRef.current = null;
    };
  }, [pubkey, relayUrl]);

  React.useEffect(() => {
    if (!pubkey) return;
    const key = storageKey(pubkey, relayUrl);
    const handler = (e: StorageEvent) => {
      if (e.key !== key) return;
      setStore(readChannelSortStore(pubkey, relayUrl));
    };
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener("storage", handler);
    };
  }, [pubkey, relayUrl]);

  const applyRemote = React.useCallback(
    (
      remote: RemoteSortPrefs,
    ): ((prev: ChannelSortStore) => ChannelSortStore) => {
      return (prev) => {
        if (!pubkey) return prev;
        // A pending local edit owns convergence: its debounced publish re-checks
        // the head and either wins (publish) or loses (adopt, which routes back
        // through onRemoteAdopted with pending already cleared). Never let a
        // passive remote arrival clobber the optimistic edit or strand its
        // durable outbox. The adopt path clears pending before calling us, so
        // this guard is false there and the winning remote still writes through.
        if (managerRef.current?.hasPendingEdit()) return prev;
        if (remote.createdAt < lastAppliedRemoteTs.current) return prev;
        // Equal timestamps: the relay/database break ties by `id ASC` — the
        // LOWEST event id is the canonical winner. Apply a strictly-lower id and
        // ignore any id >= the last applied, so the UI converges on the same
        // event the relay stored rather than the largest id seen.
        if (
          remote.createdAt === lastAppliedRemoteTs.current &&
          remote.eventId >= lastAppliedEventId.current
        )
          return prev;
        lastAppliedRemoteTs.current = remote.createdAt;
        lastAppliedEventId.current = remote.eventId;
        if (!writeChannelSortStore(pubkey, remote.store, relayUrl)) return prev;
        return remote.store;
      };
    },
    [pubkey, relayUrl],
  );

  React.useEffect(() => {
    if (!pubkey || !relayUrl) return;
    const manager = managerRef.current;
    if (!manager) return;
    // When a local edit loses whole-blob LWW (pre-publish head is newer), the
    // manager adopts the winning remote store. Write it through to React state +
    // localStorage so the UI and relay never diverge; applyRemote also advances
    // the applied-ts guard.
    manager.setOnRemoteAdopted((remote) => {
      setStore(applyRemote(remote));
    });
  }, [pubkey, relayUrl, applyRemote]);

  React.useEffect(() => {
    if (!pubkey || !relayUrl) return;
    let cancelled = false;
    const local = readChannelSortStore(pubkey, relayUrl);
    void managerRef.current?.bootstrap(local).then((result) => {
      if (cancelled) return;
      if (result.action === "apply-remote") {
        setStore(applyRemote(result.data));
      }
      // "hold": seed already performed by bootstrap (if first-sync), or blocked
      // (failed fetch / prior watermark). Resume any edit persisted to the
      // durable outbox before a prior quit/community-switch.
      const outbox = readChannelSortOutbox(pubkey, relayUrl);
      if (outbox) {
        managerRef.current?.publishSortPrefs(outbox);
      } else {
        clearChannelSortOutbox(pubkey, relayUrl);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pubkey, relayUrl, applyRemote]);

  // Reconciliation loop (mirrors sections): a single scheduler that both retries
  // a failed bootstrap with bounded backoff and periodically re-fetches the
  // head, so stale-at-open state converges without waiting for a reconnect event
  // a healthy socket never fires. Also refreshes when the window becomes visible.
  React.useEffect(() => {
    if (!pubkey || !relayUrl) return;
    let cancelled = false;
    let timer: number | null = null;
    let delayMs = RECONCILE_RETRY_BASE_MS;

    const schedule = (ms: number) => {
      if (cancelled) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(tick, ms);
    };

    const tick = () => {
      void managerRef.current?.fetchRemoteSortPrefs().then((result) => {
        if (cancelled) return;
        if (result.status === "found") {
          // applyRemote defers to a pending local edit (whose own debounced
          // publish converges via publish-or-adopt), so a periodic reconcile
          // can never drop it — no re-queue needed.
          setStore(applyRemote(result.data));
          delayMs = RECONCILE_STEADY_MS; // relay answered → steady cadence
        } else if (result.status === "absent") {
          delayMs = RECONCILE_STEADY_MS; // answered (no blob) → steady cadence
        } else {
          delayMs = Math.min(delayMs * 2, RECONCILE_RETRY_MAX_MS); // fetch failed → back off
        }
        schedule(delayMs);
      });
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        delayMs = RECONCILE_RETRY_BASE_MS;
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    schedule(delayMs);

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pubkey, relayUrl, applyRemote]);

  React.useEffect(() => {
    if (!pubkey) return;
    let unsub: (() => Promise<void>) | null = null;
    let cancelled = false;
    void managerRef.current
      ?.subscribeToSortPrefs((remote) => {
        if (cancelled) return;
        setStore(applyRemote(remote));
      })
      .then((dispose) => {
        if (cancelled) {
          void dispose();
        } else {
          unsub = dispose;
        }
      });
    return () => {
      cancelled = true;
      if (unsub) void unsub();
    };
  }, [pubkey, applyRemote]);

  React.useEffect(() => {
    if (!pubkey) return;
    let cancelled = false;
    const unsub = relayClient.subscribeToReconnects(() => {
      void managerRef.current?.fetchRemoteSortPrefs().then((result) => {
        if (cancelled) return;
        if (result.status === "found") {
          setStore(applyRemote(result.data));
        }
        const pending = managerRef.current?.getPendingStore();
        if (pending) {
          managerRef.current?.publishSortPrefs(pending);
        }
      });
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [pubkey, applyRemote]);

  const sortModeFor = React.useCallback(
    (group: ChannelSortGroupKey) => sortModeForGroup(store, group),
    [store],
  );

  const setSortModeFor = React.useCallback(
    (group: ChannelSortGroupKey, mode: ChannelSortMode) => {
      if (!pubkey) return;
      setStore((prev) => {
        const withUpdate: ChannelSortStore = {
          ...prev,
          groups: { ...prev.groups, [group]: mode },
        };
        // Prune sort modes left behind by deleted custom sections on write so
        // the stored map can't grow unboundedly with stale `section:` keys.
        const next = boundChannelSortStore(
          liveSectionIds
            ? stripOrphanedSectionModes(withUpdate, liveSectionIds)
            : withUpdate,
        );
        if (!writeChannelSortStore(pubkey, next, relayUrl)) return prev;
        managerRef.current?.publishSortPrefs(next);
        return next;
      });
    },
    [pubkey, relayUrl, liveSectionIds],
  );

  return { sortModeFor, setSortModeFor };
}
