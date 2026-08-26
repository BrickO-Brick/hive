import { relayClient } from "@/shared/api/relayClient";
import {
  nip44DecryptFromSelf,
  nip44EncryptToSelf,
  signRelayEvent,
} from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_CHANNEL_SORT } from "@/shared/constants/kinds";
import {
  clearChannelSortOutbox,
  parseChannelSortPayload,
  writeChannelSortOutbox,
  type ChannelSortStore,
} from "./channelSortPreference";
import {
  advanceWatermark,
  clampPublishCreatedAt,
  mintOutboxToken,
  readWatermark,
  runBootstrap,
  type FetchResult,
} from "./sidebarSyncWatermark";

const D_TAG = "channel-sort";
const BLOB_TYPE = D_TAG;
const DEBOUNCE_MS = 2_000;

// Bounded backoff for a retained pending edit whose publish failed transiently
// (timeout / socket error) on an otherwise-healthy socket, so it does not wait
// for a reconnect that may never fire.
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

export type RemoteSortPrefs = {
  store: ChannelSortStore;
  createdAt: number;
  eventId: string;
};

/**
 * Outcome of the pre-publish head check.
 *
 * - `publish` — local edit is at or ahead of the head; publish it.
 * - `adopt`   — a newer remote head exists; the local edit lost whole-blob LWW
 *               and must be discarded in favour of the remote store so UI and
 *               relay converge. The manager hands the remote back to the hook
 *               and never publishes.
 */
type PublishDecision =
  | { kind: "publish"; store: ChannelSortStore }
  | { kind: "adopt"; remote: RemoteSortPrefs };

/**
 * The canonical remote head as it stood when an edit was queued. The pre-publish
 * check compares the fetched head against this frozen baseline — never against
 * the mutable in-memory watermark, which a live event observed during the
 * debounce window may already have advanced to that same head (silently
 * suppressing the adopt).
 */
type PublishBaseline = { createdAt: number; eventId: string };

/**
 * True when `head` is the canonical winner over the baseline the edit was queued
 * against — i.e. the head advanced since the edit began. Canonical order is
 * `created_at DESC, id ASC`: a strictly-later head wins, and a same-second head
 * wins only with a strictly-lower id. A same-second head is comparable only once
 * the baseline id is known (empty id = no prior head seen → not superseded).
 */
function remoteAdvancedSince(
  head: RemoteSortPrefs,
  baseline: PublishBaseline,
): boolean {
  if (head.createdAt > baseline.createdAt) return true;
  return (
    head.createdAt === baseline.createdAt &&
    baseline.eventId !== "" &&
    head.eventId < baseline.eventId
  );
}

/**
 * True when tuple `a` is the canonical winner over `b` (`created_at DESC,
 * id ASC`). An empty id means "no head seen yet" and always loses.
 */
function canonicalGreater(a: PublishBaseline, b: PublishBaseline): boolean {
  if (a.eventId === "") return false;
  if (b.eventId === "") return true;
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  return a.eventId < b.eventId;
}

/** The canonical-greater of two head tuples (`created_at DESC, id ASC`). */
function canonicalMax(a: PublishBaseline, b: PublishBaseline): PublishBaseline {
  return canonicalGreater(a, b) ? a : b;
}

async function decryptAndParse(
  event: RelayEvent,
): Promise<RemoteSortPrefs | null> {
  try {
    const plaintext = await nip44DecryptFromSelf(event.content);
    const store = parseChannelSortPayload(JSON.parse(plaintext));
    if (!store) return null;
    return { store, createdAt: event.created_at, eventId: event.id };
  } catch {
    return null;
  }
}

/**
 * Syncs the per-group sidebar sort preferences across clients via encrypted
 * NIP-78 app data (kind 30078, d-tag `channel-sort`), following the same
 * pattern as channel sections: NIP-44 encrypted-to-self content, debounced
 * writes, and whole-blob last-write-wins. The sort map is a compact,
 * low-frequency preference blob, so whole-blob LWW (like sections) is
 * sufficient — per-key merge (like stars/mutes) would be unnecessary
 * complexity here.
 *
 * The durable lane (outbox + generation/CAS + bounded retry) is mirrored from
 * sections so a sort edit made just before quit/community-switch, or one whose
 * publish times out, self-heals rather than being silently dropped.
 */
export class ChannelSortSyncManager {
  private pubkey: string;
  private relayUrl: string;
  private debounceTimer: number | null = null;
  private retryTimer: number | null = null;
  private retryDelayMs = RETRY_BASE_MS;
  private lastRemoteCreatedAt: number;
  // Canonical best head observed so far (`created_at DESC, id ASC`). Frozen into
  // a per-edit baseline at publishSortPrefs so the pre-publish check can tell
  // whether the head advanced *since the edit was queued*, independent of the
  // mutable watermark that a live event during the debounce window may advance.
  private lastRemoteHead: PublishBaseline = { createdAt: 0, eventId: "" };
  // The canonical head this pending edit is racing against, frozen when the edit
  // was queued and advanced ONLY by our own successful publishes.
  private publishBaseline: PublishBaseline = { createdAt: 0, eventId: "" };
  private pendingStore: ChannelSortStore | null = null;
  // Monotonic id for the current pending edit. Every publishSortPrefs() bumps
  // it; every scheduled publish/retry captures the value it was queued for. A
  // completion (success, adopt, or no-op) may only clear pending state via
  // compare-and-swap on this generation, so an older in-flight publish can
  // never erase a newer edit that arrived while it was in flight.
  private pendingGeneration = 0;
  // The ownership token of the durable outbox entry this window most recently
  // wrote. A completion (publish/adopt/no-op) clears the shared outbox only when
  // its stored token still matches this one, so a peer window that overwrote the
  // entry (replacing the token) keeps its still-unpublished edit. Reset to null
  // once cleared so a stale token can never authorize a later clear.
  private pendingOutboxToken: string | null = null;
  // Publish cycles are serialized: at most one runs at a time. A newer edit
  // queued while a cycle is in flight defers; the in-flight cycle's completion
  // re-drives it. This kills the cross-generation race class by construction.
  private publishInFlight = false;
  // Event ids we signed and sent to the relay but whose ACK never arrived. The
  // relay MAY have accepted such a write, so if a later cycle's pre-publish
  // fetch returns a head whose id is in this set, that head is OUR OWN accepted
  // predecessor — fold it forward and publish above it, rather than adopting it
  // and erasing the queued edit.
  private ambiguousAttemptIds = new Set<string>();
  private lastPublishedStore: ChannelSortStore | null = null;
  private destroyed = false;
  // Set by the hook so an adopted remote head (local edit lost whole-blob LWW)
  // is written through to React state + localStorage.
  private onRemoteAdopted: ((remote: RemoteSortPrefs) => void) | null = null;

  constructor(pubkey: string, relayUrl: string) {
    this.pubkey = pubkey;
    this.relayUrl = relayUrl;
    this.lastRemoteCreatedAt = readWatermark(pubkey, BLOB_TYPE, relayUrl);
  }

  /** Register the hook's adopt-remote sink (write-through to UI + storage). */
  setOnRemoteAdopted(cb: (remote: RemoteSortPrefs) => void): void {
    this.onRemoteAdopted = cb;
  }

  async fetchRemoteSortPrefs(): Promise<FetchResult<RemoteSortPrefs>> {
    try {
      const events = await relayClient.fetchEvents({
        kinds: [KIND_CHANNEL_SORT],
        authors: [this.pubkey],
        "#d": [D_TAG],
        limit: 1,
      });
      if (events.length === 0 || events[0].pubkey !== this.pubkey) {
        return { status: "absent" };
      }
      const event = events[0];
      // An event exists — record its created_at regardless of whether we can
      // decrypt it, so seed-publish is blocked even when the payload is
      // unreadable (e.g. wrong key).
      this.recordRemoteHead(event.created_at, event.id);
      const result = await decryptAndParse(event);
      if (!result) {
        return { status: "failed", createdAt: event.created_at };
      }
      return {
        status: "found",
        data: result,
        createdAt: result.createdAt,
        eventId: result.eventId,
      };
    } catch {
      return { status: "failed" };
    }
  }

  /** Update in-memory + persisted watermark and the canonical head tuple. */
  private recordRemoteHead(createdAt: number, eventId: string): void {
    if (createdAt > this.lastRemoteCreatedAt) {
      this.lastRemoteCreatedAt = createdAt;
    }
    // Track the canonical-best head (`created_at DESC, id ASC`): a later head
    // always wins; a same-second head wins only with a strictly-lower id.
    if (
      createdAt > this.lastRemoteHead.createdAt ||
      (createdAt === this.lastRemoteHead.createdAt &&
        (this.lastRemoteHead.eventId === "" ||
          eventId < this.lastRemoteHead.eventId))
    ) {
      this.lastRemoteHead = { createdAt, eventId };
    }
    advanceWatermark(this.pubkey, BLOB_TYPE, this.relayUrl, createdAt);
  }

  cancelPendingPublish(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  getPendingStore(): ChannelSortStore | null {
    return this.pendingStore;
  }

  /** True while an unpublished local edit is queued (debouncing or retrying). */
  hasPendingEdit(): boolean {
    return this.pendingStore !== null;
  }

  /**
   * Adopt a remote store that superseded a local edit: hand it to the hook for
   * write-through, advance the watermark, and drop the losing pending edit —
   * including the durable outbox, so the outbox can never replay an edit that
   * adopt just decided lost.
   *
   * Compare-and-swap on `gen`: if a newer edit arrived while this publish was in
   * flight, the generation has moved on and that newer edit is the latest writer
   * — a stale adopt must not clear its pending state or overwrite its optimistic
   * UI. We still advance the watermark (monotonic and always safe).
   */
  private adoptRemote(remote: RemoteSortPrefs, gen: number): void {
    this.recordRemoteHead(remote.createdAt, remote.eventId);
    if (gen !== this.pendingGeneration) return;
    this.pendingStore = null;
    this.clearOwnedOutbox();
    this.lastPublishedStore = remote.store;
    if (this.destroyed) return;
    this.onRemoteAdopted?.(remote);
  }

  /**
   * Clear the in-memory pending edit and its durable outbox — but only if the
   * completing publish still owns the current generation. A publish for an older
   * edit that finishes after a newer edit was queued must leave the newer edit
   * (and its retry state) untouched.
   */
  private discardPending(gen: number): void {
    if (gen !== this.pendingGeneration) return;
    this.pendingStore = null;
    this.clearOwnedOutbox();
  }

  /**
   * Compare-and-clear the shared outbox against the token this window wrote, so
   * a peer window that overwrote the entry (replacing the token) keeps its
   * still-unpublished edit. Reset the token so a stale value cannot authorize a
   * later clear.
   */
  private clearOwnedOutbox(): void {
    clearChannelSortOutbox(
      this.pubkey,
      this.relayUrl,
      this.pendingOutboxToken ?? undefined,
    );
    this.pendingOutboxToken = null;
  }

  publishSortPrefs(store: ChannelSortStore): void {
    this.pendingStore = store;
    ++this.pendingGeneration;
    // Freeze the canonical head this edit is racing against at queue time so a
    // live event applied during the debounce window (which advances the mutable
    // watermark) cannot make the pre-publish comparison see equality and fall
    // through to a publish that overwrites a remote that became head after this
    // edit was queued. The baseline only advances via our own successful
    // publishes, so a prior generation's own accepted write is folded in rather
    // than mistaken for a competing remote.
    this.publishBaseline = { ...this.lastRemoteHead };
    // Persist synchronously so an edit made <2s before quit/community-switch
    // survives teardown and resumes on next mount (durable outbox). Mint a fresh
    // ownership token: whole-blob LWW means this write REPLACES the shared entry,
    // and the token lets a later completion clear only what it still owns.
    this.pendingOutboxToken = mintOutboxToken();
    writeChannelSortOutbox(
      this.pubkey,
      store,
      this.relayUrl,
      this.pendingOutboxToken,
    );
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    // A fresh edit supersedes any retry scheduled for the previous generation.
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryDelayMs = RETRY_BASE_MS;
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      this.startCycle();
    }, DEBOUNCE_MS);
  }

  /**
   * Serialize publish cycles: at most one runs at a time. A debounce/retry timer
   * that fires while a cycle is in flight defers — the in-flight cycle's
   * completion re-drives if a pending edit still needs publishing.
   */
  private startCycle(): void {
    if (this.destroyed || this.pendingStore === null) return;
    if (this.publishInFlight) return;
    const store = this.pendingStore;
    const gen = this.pendingGeneration;
    this.publishInFlight = true;
    void this.doPublish(store, gen).finally(() => {
      this.publishInFlight = false;
      if (
        !this.destroyed &&
        this.pendingStore !== null &&
        this.debounceTimer === null &&
        this.retryTimer === null
      ) {
        this.startCycle();
      }
    });
  }

  private async fetchOwnBlobBeforePublish(
    store: ChannelSortStore,
  ): Promise<PublishDecision> {
    try {
      const events = await relayClient.fetchEvents({
        kinds: [KIND_CHANNEL_SORT],
        authors: [this.pubkey],
        "#d": [D_TAG],
        limit: 1,
      });
      if (events.length === 0 || events[0].pubkey !== this.pubkey)
        return { kind: "publish", store };
      const event = events[0];
      const remote = await decryptAndParse(event);
      // Record the head after decrypt attempt so the watermark/head-tuple
      // advance even for an undecryptable payload.
      this.recordRemoteHead(event.created_at, event.id);
      if (!remote) return { kind: "publish", store };
      // Sort prefs use whole-blob LWW. Compare the fetched head against the
      // baseline frozen when this edit was queued — NOT the live watermark. If
      // the canonical head advanced since the edit began, the local edit lost
      // and is adopted-away rather than republished over it.
      if (remoteAdvancedSince(remote, this.publishBaseline)) {
        // Unless the advancing head is a prior publish of OURS whose ACK was
        // lost: it is our own accepted predecessor, not a competing remote.
        // Fold it into the baseline and publish above it so the queued edit
        // survives instead of adopting our own stale write away.
        if (this.ambiguousAttemptIds.has(remote.eventId)) {
          this.publishBaseline = canonicalMax(this.publishBaseline, {
            createdAt: remote.createdAt,
            eventId: remote.eventId,
          });
          return { kind: "publish", store };
        }
        return { kind: "adopt", remote };
      }
      return { kind: "publish", store };
    } catch {
      return { kind: "publish", store };
    }
  }

  private isIdenticalToLastPublished(store: ChannelSortStore): boolean {
    if (!this.lastPublishedStore) return false;
    const lastGroups = this.lastPublishedStore.groups;
    const currentGroups = store.groups;
    const lastKeys = Object.keys(lastGroups);
    const currentKeys = Object.keys(currentGroups);
    if (lastKeys.length !== currentKeys.length) return false;
    for (const key of currentKeys) {
      if (lastGroups[key] !== currentGroups[key]) return false;
    }
    return true;
  }

  /** Schedule a bounded-backoff retry of the retained pending edit. */
  private scheduleRetry(gen: number): void {
    if (this.destroyed || this.pendingStore === null) return;
    // A newer edit has superseded this one; its own timer owns the retry.
    if (gen !== this.pendingGeneration) return;
    if (this.retryTimer !== null) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, RETRY_MAX_MS);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.startCycle();
    }, delay);
  }

  private async doPublish(store: ChannelSortStore, gen: number): Promise<void> {
    // A newer edit was queued after this publish was scheduled; it owns the
    // pending state and will publish the latest store — abandon this stale run.
    if (gen !== this.pendingGeneration) return;
    try {
      const decision = await this.fetchOwnBlobBeforePublish(store);
      // Guard: manager may have been destroyed while fetchOwnBlobBeforePublish
      // was awaited (community switch during in-flight fetch).
      if (this.destroyed) return;
      // A newer edit was queued while we awaited the pre-publish fetch. It owns
      // convergence now; the serialized cycle re-drives for it once this run
      // unwinds.
      if (gen !== this.pendingGeneration) return;
      if (decision.kind === "adopt") {
        this.adoptRemote(decision.remote, gen);
        return;
      }
      const merged = decision.store;
      if (this.isIdenticalToLastPublished(merged)) {
        this.discardPending(gen);
        return;
      }
      const payload = {
        version: 1,
        groups: merged.groups,
      };
      const ciphertext = await nip44EncryptToSelf(JSON.stringify(payload));
      // Clamp inside the relay's future-drift window so a skewed remote head
      // can never make us stamp an unbounded future timestamp that wedges every
      // subsequent publish; we adopt such a head on the next fetch instead.
      const createdAt = clampPublishCreatedAt(this.lastRemoteCreatedAt);
      const event = await signRelayEvent({
        kind: KIND_CHANNEL_SORT,
        content: ciphertext,
        createdAt,
        tags: [
          ["d", D_TAG],
          ["t", D_TAG], // relay discoverability; not used in our filters
        ],
      });
      // Final guard immediately before the network call — a newer edit may have
      // been queued during the encrypt/sign await, or the manager destroyed.
      if (this.destroyed || gen !== this.pendingGeneration) return;
      // Record this signed id as an in-flight attempt of unknown fate before we
      // send it. If the ACK is lost below, a later cycle that fetches this id as
      // the head recognises it as our own accepted write and folds it forward
      // rather than adopting it away.
      this.ambiguousAttemptIds.add(event.id);
      await relayClient.publishEvent(
        event,
        "Timed out publishing channel sort preferences.",
        "Failed to publish channel sort preferences.",
      );
      this.recordRemoteHead(event.created_at, event.id);
      // This write is now the confirmed accepted head; it dominates every prior
      // attempt (`created_at DESC, id ASC`), so no earlier ambiguous id can ever
      // be the canonical head again. Clear the set to keep it bounded.
      this.ambiguousAttemptIds.clear();
      // Fold our own accepted head into the pending edit's baseline —
      // unconditional across generations so a newer edit's pre-publish check
      // does not mistake OUR prior publish for a competing remote and adopt it
      // away. Genuine remotes never fold in here.
      this.publishBaseline = canonicalMax(this.publishBaseline, {
        createdAt: event.created_at,
        eventId: event.id,
      });
      // Only claim this store as the published head if it is still the current
      // edit; a newer edit queued mid-flight owns lastPublishedStore now.
      if (gen === this.pendingGeneration) {
        this.lastPublishedStore = merged;
        this.retryDelayMs = RETRY_BASE_MS;
      }
      this.discardPending(gen);
    } catch (error) {
      if (this.destroyed) return;
      // Ambiguous outcome: the publish promise rejected (timeout / socket
      // error), but the relay may already have accepted the write before the
      // ACK was lost. Keep the pending edit and retry with backoff. The attempt
      // id stays in ambiguousAttemptIds: if the relay did accept it, a later
      // cycle that fetches this id as the head folds it forward as our own
      // accepted predecessor instead of adopting it away.
      console.warn("[channelSortSync] publish failed:", error);
      this.scheduleRetry(gen);
    }
  }

  async subscribeToSortPrefs(
    onUpdate: (remote: RemoteSortPrefs) => void,
  ): Promise<() => Promise<void>> {
    return relayClient.subscribeLive(
      {
        kinds: [KIND_CHANNEL_SORT],
        authors: [this.pubkey],
        "#d": [D_TAG],
        limit: 0,
      },
      (event: RelayEvent) => {
        if (event.pubkey !== this.pubkey) return;
        // Record the raw head before decrypt so an undecryptable live event
        // still advances the watermark and blocks future seed-publish.
        this.recordRemoteHead(event.created_at, event.id);
        void decryptAndParse(event).then((result) => {
          if (result) {
            onUpdate(result);
          }
        });
      },
    );
  }

  /**
   * Fetches the remote blob on first mount, records the remote head, and
   * delegates the seed/hold/apply-remote decision to `runBootstrap`.
   */
  async bootstrap(localStore: ChannelSortStore) {
    const fetchResult = await this.fetchRemoteSortPrefs();
    return runBootstrap({
      fetchResult,
      lastHead: this.lastRemoteCreatedAt,
      localStore,
      isLocalNonEmpty: (s) => Object.keys(s.groups).length > 0,
      publishFn: (s) => this.publishSortPrefs(s),
    });
  }

  destroy(): void {
    // Cancel any pending publish and mark this manager as destroyed so any
    // in-flight doPublish() calls abort before reaching relayClient.
    // Debounce-window changes are NOT lost: publishSortPrefs persisted them to
    // the durable outbox synchronously, and the next mount resumes them.
    // Flushing here is still avoided — it could publish relay A's sort prefs to
    // relay B via the shared relayClient singleton.
    this.destroyed = true;
    this.cancelPendingPublish();
    this.pendingStore = null;
  }
}
