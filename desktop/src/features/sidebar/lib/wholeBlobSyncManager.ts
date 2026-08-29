import { relayClient } from "@/shared/api/relayClient";
import {
  nip44DecryptFromSelf,
  nip44EncryptToSelf,
  signRelayEvent,
} from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import {
  advanceWatermark,
  clampPublishCreatedAt,
  readWatermark,
  runBootstrap,
  type FetchResult,
} from "./sidebarSyncWatermark";

const DEBOUNCE_MS = 2_000;

// Bounded backoff for a retained pending edit whose publish failed transiently
// (timeout / socket error) on an otherwise-healthy socket, so it does not wait
// for a reconnect that may never fire.
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

export type RemoteBlob<S> = {
  store: S;
  createdAt: number;
  eventId: string;
};

/**
 * Outcome of the pre-publish head check.
 *
 * - `publish` — local edit is at or ahead of the head; publish it.
 * - `adopt`   — a newer remote head exists; the local edit lost whole-blob
 *               LWW and must be discarded in favour of the remote store so UI
 *               and relay converge (see the fix-2 design note). The manager
 *               hands the remote back to the hook and never publishes.
 * - `retain`  — a head event exists but could not be decrypted/parsed (future
 *               schema, transient keychain/decrypt fault, malformed payload).
 *               The client cannot inspect it to decide adopt-or-publish, so
 *               overwriting it would be blind data loss (Carl P1). Keep the
 *               durable pending edit and retry rather than clobber authoritative
 *               state the client could not read.
 */
type PublishDecision<S> =
  | { kind: "publish"; store: S }
  | { kind: "adopt"; remote: RemoteBlob<S> }
  | { kind: "retain" };

/**
 * The canonical remote head as it stood when an edit was queued. The
 * pre-publish check compares the fetched head against this frozen baseline —
 * never against the mutable in-memory watermark, which a live event observed
 * during the debounce window may already have advanced to that same head
 * (silently suppressing the adopt).
 */
type PublishBaseline = { createdAt: number; eventId: string };

/**
 * Outcome of the post-publish retained-head confirmation (Carl P1).
 *
 * - `confirmed` — the retained head is exactly our event; the write won LWW.
 * - `adopt`     — a different, readable event is the head; our write was
 *                 superseded (a peer's same-second blob with a lower id won, or
 *                 a strictly-newer head landed). The caller adopts the winner.
 * - `retain`    — the fetch failed, returned no/foreign head, or the head was
 *                 unreadable; retention cannot be proven, so keep the durable
 *                 edit and retry.
 */
type RetentionConfirmation<S> =
  | { kind: "confirmed" }
  | { kind: "adopt"; remote: RemoteBlob<S> }
  | { kind: "retain" };

/**
 * True when `head` is the canonical winner over the baseline the edit was
 * queued against — i.e. the head advanced since the edit began. Canonical order
 * is `created_at DESC, id ASC`: a strictly-later head wins, and a same-second
 * head wins only with a strictly-lower id. A same-second head is comparable
 * only once the baseline id is known (empty id = no prior head seen → not
 * superseded).
 */
function remoteAdvancedSince(
  head: RemoteBlob<unknown>,
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

/**
 * Per-lane configuration injected into the shared whole-blob sync engine.
 *
 * `S` is the store type (ChannelSectionStore, ChannelSortStore, …).
 */
export type WholeBlobLaneConfig<S> = {
  /** NIP-78 event kind for this lane (e.g. KIND_CHANNEL_SECTIONS). */
  kind: number;
  /** NIP-78 `d` tag value used to scope the lane's blob. */
  dTag: string;
  /** Human-readable prefix for console.warn messages. */
  logPrefix: string;
  /** Parse decrypted JSON into a typed store, or null for unreadable payloads. */
  parse: (json: unknown) => S | null;
  /** Serialize a store into the JSON object to be encrypted and published. */
  serializePayload: (store: S) => unknown;
  /** Persist this window's pending edit to the durable outbox. */
  writeOutbox: (pubkey: string, store: S, relayUrl: string) => boolean;
  /** Clear this window's own outbox key. */
  clearOutbox: (pubkey: string, relayUrl: string) => void;
  /** True when `store` is semantically identical to `last`. Used to skip no-op publishes. */
  storesEqual: (store: S, last: S) => boolean;
  /** True when the local store is non-empty and eligible for a first-sync seed-publish. */
  isLocalNonEmpty: (store: S) => boolean;
};

/**
 * Shared whole-blob LWW sync engine used by ChannelSectionSyncManager and
 * ChannelSortSyncManager. Both lanes use the same generation-CAS, outbox,
 * watermark, retained-head confirmation, prior-gen fold, and bounded-retry
 * machinery — only lane config (kind, d-tag, store type, parse/serialize,
 * outbox functions) differs.
 *
 * ### Invariants preserved across all passes
 *
 * **pass-2 (genuine-remote adoption):** A remote observed passively during the
 * debounce window still gets adopted because the pending edit's
 * `publishBaseline` is frozen at queue time and only advances via our own
 * successful publishes — not via passive remote observations.
 *
 * **pass-3 (own-confirmed fold):** A prior publish of ours that was confirmed
 * is folded into `publishBaseline` so a later edit's pre-publish check does not
 * mistake our own accepted write for a competing remote and adopt it away.
 *
 * **pass-4 (conditional catch rollback):** The `claimLegacy` logic lives in the
 * storage layer (lane-specific) and is not affected by this shared engine.
 *
 * **r7 prior-gen fold:** When a same-second lower-id peer wins a LWW collision
 * and a newer edit (gen B) was queued after A's ACK but before confirmation
 * resolved, `adoptRemote`'s stale-gen path repairs the poisoned baseline via
 * `foldSupersedingAttemptWinner` so B publishes above the true retained head
 * rather than adopting the winner away. The generation guard requires the
 * baseline attempt to be prior-generation (`attempt < pendingGeneration`).
 */
export class WholeBlobSyncManager<S> {
  private pubkey: string;
  private relayUrl: string;
  private config: WholeBlobLaneConfig<S>;

  private debounceTimer: number | null = null;
  private retryTimer: number | null = null;
  private retryDelayMs = RETRY_BASE_MS;
  private lastRemoteCreatedAt: number;
  // Canonical best head observed so far (`created_at DESC, id ASC`). Frozen into
  // a per-edit baseline at publish time so the pre-publish check can tell
  // whether the head advanced *since the edit was queued*, independent of the
  // mutable watermark that a live event during the debounce window may advance.
  private lastRemoteHead: PublishBaseline = { createdAt: 0, eventId: "" };
  // The canonical head this pending edit is racing against, frozen when the
  // edit was queued and advanced ONLY by our own successful publishes. Freezing
  // at queue time is what makes a genuine remote observed during the debounce
  // window still adopt-worthy (pass-2): the mutable watermark advanced to that
  // remote, but the baseline did not. Folding our own published head forward is
  // what stops a newer edit from adopting an older generation's own accepted
  // write (pass-3): our prior publish is our baseline, not a competing remote.
  private publishBaseline: PublishBaseline = { createdAt: 0, eventId: "" };
  private pendingStore: S | null = null;
  // Monotonic id for the current pending edit. Every publish() bumps it; every
  // scheduled publish/retry captures the value it was queued for. A completion
  // (success, adopt, or no-op) may only clear pending state via compare-and-swap
  // on this generation, so an older in-flight publish can never erase a newer
  // edit that arrived while it was in flight.
  private pendingGeneration = 0;
  // Publish cycles are serialized: at most one runs at a time. A newer edit
  // queued while a cycle is in flight does NOT start its own concurrent cycle;
  // it defers, and the in-flight cycle's completion schedules it. Serialization
  // guarantees there is never more than one baseline/fetch/publish sequence
  // touching shared manager state, so a stale generation can never sign or
  // publish after a newer edit exists.
  private publishInFlight = false;
  // Event ids we signed and sent to the relay but whose ACK never arrived (the
  // publish promise rejected as a timeout/socket error after the frame left).
  // The relay MAY have accepted such a write, so if a later cycle's pre-publish
  // fetch returns a head whose id is in this map, that head is OUR OWN accepted
  // predecessor — fold it forward and publish above it, rather than adopting it
  // and erasing the queued edit. An attempt the relay never accepted can never
  // surface as the head, so an id match is proof of our own accepted write.
  // Maps attempt id → pendingGeneration at the time of signing, so
  // foldSupersedingAttemptWinner can require the baseline was poisoned by a
  // strictly prior generation (gen < pendingGeneration).
  private ambiguousAttemptIds = new Map<string, number>();
  private lastPublishedStore: S | null = null;
  protected destroyed = false;
  // Set by the hook so an adopted remote head (local edit lost whole-blob LWW)
  // is written through to React state + localStorage.
  private onRemoteAdopted: ((remote: RemoteBlob<S>) => void) | null = null;

  constructor(
    pubkey: string,
    relayUrl: string,
    config: WholeBlobLaneConfig<S>,
  ) {
    this.pubkey = pubkey;
    this.relayUrl = relayUrl;
    this.config = config;
    // Hydrate from localStorage so we never seed-publish if a remote blob has
    // been seen in a prior session.
    this.lastRemoteCreatedAt = readWatermark(pubkey, config.dTag, relayUrl);
  }

  /** Register the hook's adopt-remote sink (write-through to UI + storage). */
  setOnRemoteAdopted(cb: (remote: RemoteBlob<S>) => void): void {
    this.onRemoteAdopted = cb;
  }

  async fetchRemoteBlob(): Promise<FetchResult<RemoteBlob<S>>> {
    try {
      const events = await relayClient.fetchEvents({
        kinds: [this.config.kind],
        authors: [this.pubkey],
        "#d": [this.config.dTag],
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
      const result = await this.decryptAndParse(event);
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

  private async decryptAndParse(
    event: RelayEvent,
  ): Promise<RemoteBlob<S> | null> {
    try {
      const plaintext = await nip44DecryptFromSelf(event.content);
      const store = this.config.parse(JSON.parse(plaintext));
      if (!store) return null;
      return { store, createdAt: event.created_at, eventId: event.id };
    } catch {
      return null;
    }
  }

  /** Update in-memory + persisted watermark and the canonical head tuple. */
  private recordRemoteHead(createdAt: number, eventId: string): void {
    if (createdAt > this.lastRemoteCreatedAt) {
      this.lastRemoteCreatedAt = createdAt;
    }
    // Track the canonical-best head (`created_at DESC, id ASC`): a later head
    // always wins; a same-second head wins only with a strictly-lower id. This
    // mirrors the relay's stored winner so a frozen baseline reflects reality.
    if (
      createdAt > this.lastRemoteHead.createdAt ||
      (createdAt === this.lastRemoteHead.createdAt &&
        (this.lastRemoteHead.eventId === "" ||
          eventId < this.lastRemoteHead.eventId))
    ) {
      this.lastRemoteHead = { createdAt, eventId };
    }
    advanceWatermark(this.pubkey, this.config.dTag, this.relayUrl, createdAt);
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

  getPendingStore(): S | null {
    return this.pendingStore;
  }

  /**
   * Re-drive the CURRENT pending edit's publish immediately without opening a
   * new generation — used by the reconnect handler. Calling the public
   * `publish()` there would bump the generation and reset `publishBaseline` to
   * the just-fetched head, so a remote that won LWW while the edit was pending
   * would be published over instead of adopted (Carl P1). Waking the existing
   * generation keeps the frozen baseline, so the debounced cycle's pre-publish
   * check still adopts a genuinely-advanced remote. No-op when nothing is
   * pending.
   */
  retryPendingPublish(): void {
    if (this.pendingStore === null) return;
    this.cancelPendingPublish();
    this.startCycle();
  }

  /** True while an unpublished local edit is queued (debouncing or retrying). */
  hasPendingEdit(): boolean {
    return this.pendingStore !== null;
  }

  /**
   * When the current `publishBaseline` was frozen against one of our own
   * attempted (but non-retained) event ids and `remote` is the same-second
   * lower-id peer that won the collision, the baseline is poisoned: the next
   * pre-publish check would see the winner as having advanced past our phantom
   * attempt and adopt the edit away (Carl P1 / same-second variants). Folding
   * the winner in repairs the baseline so the pre-publish check sees the true
   * retained head and publishes above it.
   *
   * Scoped to same-second lower-id only: a strictly-later remote is a genuine
   * advance that the pending edit must still adopt (pass-2 invariant).
   *
   * Requires the baseline attempt to be prior-generation (gen <
   * pendingGeneration): if no newer edit was queued, the current generation's
   * own in-flight attempt cannot trigger the fold — the loser must adopt (LWW
   * correctness). The post-ACK ordering is load-bearing for causal soundness:
   * because A's ACK returned before B queued, the peer winner pre-existed B, so
   * preserving B is causally justified. If B queues while A's ACK is pending,
   * the peer may have been accepted after B and is a genuine remote advance B
   * must adopt — B's baseline will not equal A's attempt id in that case, so
   * the fold does not fire (correct behaviour, by the causal argument above).
   *
   * Returns true when the fold was applied (caller may use for branching).
   */
  private foldSupersedingAttemptWinner(remote: {
    createdAt: number;
    eventId: string;
  }): boolean {
    const attempt = this.ambiguousAttemptIds.get(this.publishBaseline.eventId);
    if (
      this.publishBaseline.eventId !== "" &&
      attempt !== undefined &&
      attempt < this.pendingGeneration &&
      remote.createdAt === this.publishBaseline.createdAt &&
      remote.eventId < this.publishBaseline.eventId
    ) {
      this.publishBaseline = canonicalMax(this.publishBaseline, {
        createdAt: remote.createdAt,
        eventId: remote.eventId,
      });
      return true;
    }
    return false;
  }

  /**
   * Adopt a remote store that superseded a local edit: hand it to the hook for
   * write-through, advance the watermark, and drop the losing pending edit —
   * including the durable outbox, so the outbox can never replay an edit that
   * adopt just decided lost (which would reintroduce divergence).
   *
   * Compare-and-swap on `gen`: this adopt was decided against the edit queued
   * at generation `gen`. If a newer edit arrived while this publish was in
   * flight, the generation has moved on and that newer edit is the latest writer
   * — it will publish and win LWW — so a stale adopt must not clear its pending
   * state or overwrite its optimistic UI. We still advance the watermark
   * (monotonic and always safe) so the newer edit stamps above this head.
   */
  private adoptRemote(remote: RemoteBlob<S>, gen: number): void {
    this.recordRemoteHead(remote.createdAt, remote.eventId);
    if (gen !== this.pendingGeneration) {
      // A newer edit is pending. Its baseline may have been frozen against our
      // own attempted (non-retained) event id if it was queued after the ACK
      // but before confirmation resolved. Repair any poisoned baseline so the
      // newer edit's pre-publish check publishes above the true retained head
      // rather than adopting the winner away (Carl P1).
      this.foldSupersedingAttemptWinner(remote);
      return;
    }
    this.pendingStore = null;
    this.config.clearOutbox(this.pubkey, this.relayUrl);
    this.lastPublishedStore = remote.store;
    if (this.destroyed) return;
    this.onRemoteAdopted?.(remote);
  }

  /**
   * Clear the in-memory pending edit and this window's own durable outbox key —
   * but only if the completing publish still owns the current generation. A
   * publish for an older edit that finishes after a newer edit was queued must
   * leave the newer edit (and its retry state) untouched.
   */
  private discardPending(gen: number): void {
    if (gen !== this.pendingGeneration) return;
    this.pendingStore = null;
    this.config.clearOutbox(this.pubkey, this.relayUrl);
  }

  publish(store: S): boolean {
    this.pendingStore = store;
    ++this.pendingGeneration;
    // Freeze the canonical head this edit is racing against at queue time. The
    // pre-publish check compares the fetched head against this baseline, not the
    // mutable watermark — a live event applied during the debounce window
    // advances the watermark to a new remote head, which would otherwise make
    // the pre-publish comparison see equality and fall through to a publish that
    // overwrites a remote that became head *after* this edit was queued. The
    // baseline only advances via our own successful publishes (see doPublish),
    // so a prior generation's own accepted write is folded in rather than
    // mistaken for a competing remote.
    this.publishBaseline = { ...this.lastRemoteHead };
    // Persist synchronously so an edit made <2s before quit/community-switch
    // survives teardown and resumes on next mount (durable outbox). This
    // window's own key is the only one written — a single unconditional setItem,
    // never a shared-key read-modify-write; `queuedAt` stamps it so resume
    // replays only the newest queued blob (whole-blob LWW). The returned flag
    // reports whether the intent is now durably held, so a legacy replay can
    // gate its consumption marker on a proven transfer.
    const durable = this.config.writeOutbox(this.pubkey, store, this.relayUrl);
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
    return durable;
  }

  /**
   * Serialize publish cycles: at most one runs at a time. A debounce/retry
   * timer that fires while a cycle is in flight defers — the in-flight cycle's
   * completion re-drives if a pending edit still needs publishing. This kills
   * the cross-generation race class by construction: a newer edit queued during
   * a cycle cannot start its own concurrent cycle, so there is never more than
   * one baseline/fetch/publish sequence competing over shared manager state.
   */
  private startCycle(): void {
    if (this.destroyed || this.pendingStore === null) return;
    if (this.publishInFlight) return;
    const store = this.pendingStore;
    const gen = this.pendingGeneration;
    this.publishInFlight = true;
    void this.doPublish(store, gen).finally(() => {
      this.publishInFlight = false;
      // A newer edit queued during the cycle (or a cycle that ended without
      // clearing its pending edit) still needs publishing and has no timer
      // pending to drive it — drive the next cycle now that the lane is free.
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
    store: S,
  ): Promise<PublishDecision<S>> {
    try {
      const events = await relayClient.fetchEvents({
        kinds: [this.config.kind],
        authors: [this.pubkey],
        "#d": [this.config.dTag],
        limit: 1,
      });
      if (events.length === 0 || events[0].pubkey !== this.pubkey)
        return { kind: "publish", store };
      const event = events[0];
      const remote = await this.decryptAndParse(event);
      // Record the head after decrypt attempt so the watermark/head-tuple
      // advance even for an undecryptable payload.
      this.recordRemoteHead(event.created_at, event.id);
      // A head event exists but we could not read it (future schema, transient
      // decrypt fault, malformed payload). We cannot decide adopt-or-publish
      // against state we cannot inspect, so retain the pending edit and retry
      // rather than blindly overwrite authoritative state (Carl P1).
      if (!remote) return { kind: "retain" };
      // Whole-blob LWW. Compare the fetched head against the baseline frozen
      // when this edit was queued — NOT the live watermark, which a passive live
      // event during debounce may already have advanced to this same head. If
      // the canonical head advanced since the edit began, the local edit lost
      // and is adopted-away rather than republished over it.
      if (remoteAdvancedSince(remote, this.publishBaseline)) {
        // Unless the advancing head is a prior publish of OURS whose ACK was
        // lost: the relay accepted it, but our promise rejected before we could
        // fold it forward, so it is our own accepted predecessor — not a
        // competing remote. Fold it into the baseline and publish above it so
        // the queued edit survives instead of adopting our own stale write away.
        if (this.ambiguousAttemptIds.has(remote.eventId)) {
          this.publishBaseline = canonicalMax(this.publishBaseline, {
            createdAt: remote.createdAt,
            eventId: remote.eventId,
          });
          return { kind: "publish", store };
        }
        // Same-second lower-id peer winner that superseded our own attempted
        // head: baseline.eventId is our attempted id (still in
        // ambiguousAttemptIds because the adopt path never clears it) and the
        // relay retained the peer's lower-id blob instead. This arises when
        // confirmation returned retain/failed and the retry pre-publish fetch
        // sees the winner directly with the original poisoned baseline still in
        // place. Fold the winner in so this edit publishes above the true
        // retained head rather than adopting it away (Carl P1).
        if (this.foldSupersedingAttemptWinner(remote)) {
          return { kind: "publish", store };
        }
        return { kind: "adopt", remote };
      }
      return { kind: "publish", store };
    } catch {
      // The pre-publish fetch itself failed (timeout / auth / socket) — this is
      // NOT proof that no head exists. Publishing here would sign above a stale
      // watermark and could erase an unseen newer head during a transient
      // outage. Retain the durable pending edit and retry rather than overwrite
      // state we could not read (Carl P1).
      return { kind: "retain" };
    }
  }

  /**
   * After a publish OK, fetch the authoritative retained head and decide whether
   * our event actually became it. The relay OKs a superseded NIP-33 write as a
   * no-op (`Duplicate`), so a resolved publish is NOT proof of retention: two
   * windows stamping the same `created_at` both get OK while only the lower
   * event id is retained (Carl P1). Only an exact event-id match proves our
   * whole-blob write won LWW.
   *
   *  - head id === ours               → `confirmed`
   *  - head is our own accepted prior  → `retain` (a lost-ACK / same-second
   *    attempt (ambiguousAttemptIds)     lower-id attempt of ours won; the retry
   *                                      folds it forward and republishes above)
   *  - head is a different readable    → `adopt` (our blob lost; adopt the
   *    event                             winner so UI and relay converge)
   *  - fetch failed / no head / head   → `retain` (retention unprovable or the
   *    unreadable                        winner unreadable — keep the durable
   *                                      edit and retry)
   */
  private async confirmRetainedHead(
    ourEventId: string,
  ): Promise<RetentionConfirmation<S>> {
    try {
      const events = await relayClient.fetchEvents({
        kinds: [this.config.kind],
        authors: [this.pubkey],
        "#d": [this.config.dTag],
        limit: 1,
      });
      if (events.length === 0 || events[0].pubkey !== this.pubkey)
        return { kind: "retain" };
      const event = events[0];
      this.recordRemoteHead(event.created_at, event.id);
      if (event.id === ourEventId) return { kind: "confirmed" };
      // A different event is the head. If it is one of OUR OWN accepted prior
      // attempts (a lost-ACK write the relay retained, or a same-second lower-id
      // attempt that won over this one), it is not a competing remote — retain
      // so the retry's pre-publish folds it forward and publishes above it,
      // rather than adopting our own older blob and dropping the current edit.
      if (this.ambiguousAttemptIds.has(event.id)) return { kind: "retain" };
      const remote = await this.decryptAndParse(event);
      if (!remote) return { kind: "retain" };
      return { kind: "adopt", remote };
    } catch {
      return { kind: "retain" };
    }
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

  private async doPublish(store: S, gen: number): Promise<void> {
    // A newer edit was queued after this publish was scheduled; it owns the
    // pending state and will publish the latest store — abandon this stale run.
    if (gen !== this.pendingGeneration) return;
    try {
      const decision = await this.fetchOwnBlobBeforePublish(store);
      // Guard: manager may have been destroyed while fetchOwnBlobBeforePublish
      // was awaited (community switch during in-flight fetch). If so, abort
      // before touching the relay.
      if (this.destroyed) return;
      // A newer edit was queued while we awaited the pre-publish fetch. It owns
      // convergence now; abort so we neither publish this stale store nor adopt
      // over the newer pending edit. The serialized cycle re-drives for the
      // newer generation once this one unwinds.
      if (gen !== this.pendingGeneration) return;
      if (decision.kind === "adopt") {
        this.adoptRemote(decision.remote, gen);
        return;
      }
      if (decision.kind === "retain") {
        // Head exists but is unreadable — keep the durable pending edit and
        // retry with backoff rather than overwrite state we could not inspect.
        this.scheduleRetry(gen);
        return;
      }
      const merged = decision.store;
      if (
        this.lastPublishedStore !== null &&
        this.config.storesEqual(merged, this.lastPublishedStore)
      ) {
        this.discardPending(gen);
        return;
      }
      const ciphertext = await nip44EncryptToSelf(
        JSON.stringify(this.config.serializePayload(merged)),
      );
      // Clamp inside the relay's future-drift window: never manufacture a
      // timestamp so far ahead that this or a later publish is rejected for
      // drift and wedges. If a skewed remote head sits beyond the window we
      // will lose LWW and adopt it on the next pre-publish fetch rather than
      // walking past it.
      const createdAt = clampPublishCreatedAt(this.lastRemoteCreatedAt);
      const event = await signRelayEvent({
        kind: this.config.kind,
        content: ciphertext,
        createdAt,
        tags: [
          ["d", this.config.dTag],
          ["t", this.config.dTag], // relay discoverability; not used in our filters
        ],
      });
      // Final guard immediately before the network call — sign/encrypt are
      // synchronous-ish but cheap; the relay socket may have moved to a
      // different community by the time we reach this point, or a newer edit
      // may have been queued during the encrypt/sign await (invariant: a stale
      // generation never signs/publishes after a newer edit exists).
      if (this.destroyed || gen !== this.pendingGeneration) return;
      // Record this signed id as an in-flight attempt of unknown fate before we
      // send it. If the ACK is lost below, a later cycle that fetches this id as
      // the head recognises it as our own accepted write and folds it forward
      // rather than adopting it away.
      this.ambiguousAttemptIds.set(event.id, gen);
      await relayClient.publishEvent(
        event,
        `Timed out publishing ${this.config.dTag}.`,
        `Failed to publish ${this.config.dTag}.`,
      );
      this.recordRemoteHead(event.created_at, event.id);
      // A publish OK is NOT proof of retention: the relay OKs a superseded
      // NIP-33 write as a no-op (`Duplicate`), so two windows stamping the same
      // `created_at` both get OK while only the lower event id is retained (Carl
      // P1). Fetch the authoritative head; only an exact id match proves our
      // whole-blob write won. Anything else must keep the durable edit — never
      // fold a nonexistent head into the baseline, which would poison the next
      // edit into adopting the true winner away.
      if (this.destroyed) return;
      const confirmation = await this.confirmRetainedHead(event.id);
      if (this.destroyed) return;
      if (confirmation.kind === "adopt") {
        // A different readable event is the head — our blob lost the same-second
        // collision. Adopt the winner so UI and relay converge (CAS on gen
        // inside adoptRemote leaves a newer edit untouched).
        this.adoptRemote(confirmation.remote, gen);
        return;
      }
      if (confirmation.kind === "retain") {
        // Retention unprovable (fetch failed / no head), or the head is our own
        // accepted prior attempt whose ACK was lost. Keep the durable edit and
        // retry: the retry's pre-publish folds our own accepted predecessor
        // forward (ambiguousAttemptIds) and republishes above it. Leave
        // ambiguousAttemptIds intact so that fold still recognises our writes.
        this.scheduleRetry(gen);
        return;
      }
      // Confirmed: our event is the retained head. It dominates every prior
      // attempt (`created_at DESC, id ASC`), so no earlier ambiguous id can ever
      // be the canonical head again — clear the set to keep it bounded.
      this.ambiguousAttemptIds.clear();
      // Fold our own accepted head into the pending edit's baseline. This is
      // unconditional across generations: even a stale generation's own
      // confirmed write must advance the current pending baseline so the newer
      // edit's pre-publish check does not mistake OUR prior publish for a
      // competing remote and adopt it away (pass-3). Genuine remotes never fold
      // in here — they only advance the watermark — so a remote that became head
      // during the debounce window still adopts (pass-2). canonicalMax keeps the
      // advance monotonic (`created_at DESC, id ASC`).
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
      // ACK was lost. Keep the pending edit and retry with backoff rather than
      // waiting for a reconnect that a healthy socket never fires. The attempt
      // id stays in ambiguousAttemptIds: if the relay did accept it, a later
      // cycle that fetches this id as the head folds it forward as our own
      // accepted predecessor (see fetchOwnBlobBeforePublish) instead of
      // adopting it away and erasing the queued edit.
      console.warn(`[${this.config.logPrefix}] publish failed:`, error);
      this.scheduleRetry(gen);
    }
  }

  async subscribeLive(
    onUpdate: (remote: RemoteBlob<S>) => void,
  ): Promise<() => Promise<void>> {
    return relayClient.subscribeLive(
      {
        kinds: [this.config.kind],
        authors: [this.pubkey],
        "#d": [this.config.dTag],
        limit: 0,
      },
      (event: RelayEvent) => {
        if (event.pubkey !== this.pubkey) return;
        // Record the raw head before decrypt so an undecryptable live event
        // still advances the watermark and blocks future seed-publish.
        this.recordRemoteHead(event.created_at, event.id);
        void this.decryptAndParse(event).then((result) => {
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
  async bootstrap(localStore: S) {
    const fetchResult = await this.fetchRemoteBlob();
    return runBootstrap({
      fetchResult,
      lastHead: this.lastRemoteCreatedAt,
      localStore,
      isLocalNonEmpty: this.config.isLocalNonEmpty,
      publishFn: (s) => this.publish(s),
    });
  }

  destroy(): void {
    // Cancel any pending publish and mark this manager as destroyed so any
    // in-flight doPublish() calls abort before reaching relayClient.
    // Debounce-window changes are NOT lost: publish() persisted them to the
    // durable outbox synchronously, and the next mount resumes them.
    // Flushing here is still avoided — it could publish relay A's data to
    // relay B via the shared relayClient singleton.
    this.destroyed = true;
    this.cancelPendingPublish();
    this.pendingStore = null;
  }
}
