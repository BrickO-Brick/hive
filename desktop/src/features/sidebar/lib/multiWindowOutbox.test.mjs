import assert from "node:assert/strict";
import test from "node:test";

// Multi-window durable-outbox safety (Carl's CHANGES_REQUESTED, finding P1).
//
// All four sidebar-sync lanes persist an unpublished edit so it survives a
// quit/community-switch inside the 2s publish debounce. localStorage offers no
// atomic compare-and-delete or transactional read-modify-write, so a single key
// shared across windows can never be mutated safely: one window's read→write or
// read→remove races a peer's write and drops its still-unpublished edit.
//
// The fix keys the outbox PER WINDOW: `<prefix>:<pubkey>:<relay>:<nonce>`, where
// the nonce is stable per window (sessionStorage). Each window is the sole
// writer of its own key, so a hot-path write is one unconditional `setItem` — no
// read, no shared-key contention (prong b is designed out, not guarded). Resume
// enumerates ALL windows' keys: merge lanes (stars/mutes) fold every record
// (order-independent); whole-blob lanes (sort/sections) replay the max-`queuedAt`
// record, ties broken by key. Redundant FOREIGN keys are reclaimed at boot,
// gated on durable relay evidence and re-read immediately before removal so a
// live peer's fresh write in the recheck gap is never destroyed. A window never
// removes another window's key on the hot path and never touches its own key
// during reclamation.
//
// This matrix drives the shared helpers directly through a mock Storage seam —
// no relay, no timers — so each interleaving is deterministic. The seam mocks
// both localStorage (with a read-then-mutate hook to interpose a foreign write
// between the reclaim decision-read and the delete) and sessionStorage (for the
// per-window nonce). Manager- and hook-level behavior is covered by their own
// suites; this file isolates the cross-window storage contract.

// A mock Storage. `onReadMutate(key, afterReads, fn)` runs `fn(map)` right after
// the Nth getItem of `key` returns its captured value — used to simulate a peer
// window rewriting a key in the reclaim recheck gap.
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const reads = new Map();
  const hooks = [];
  return {
    getItem(k) {
      const n = (reads.get(k) ?? 0) + 1;
      reads.set(k, n);
      const val = map.has(k) ? map.get(k) : null;
      for (const h of hooks) if (h.key === k && h.afterReads === n) h.fn(map);
      return val;
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
    clear() {
      map.clear();
    },
    get length() {
      return map.size;
    },
    key(i) {
      return [...map.keys()][i] ?? null;
    },
    onReadMutate(key, afterReads, fn) {
      hooks.push({ key, afterReads, fn });
    },
    has: (k) => map.has(k),
  };
}

// Run `fn(localStorage)` with fresh mock local + session storage installed.
function withStorage(fn) {
  const ls = makeStorage();
  const ss = makeStorage();
  const priorWindow = globalThis.window;
  globalThis.window = {
    ...(priorWindow ?? {}),
    localStorage: ls,
    sessionStorage: ss,
  };
  try {
    return fn(ls);
  } finally {
    if (priorWindow !== undefined) globalThis.window = priorWindow;
    else delete globalThis.window;
  }
}

const { normalizeRelayUrl } = await import("@/shared/lib/normalizeRelayUrl");
const { outboxWindowNonce } = await import("./sidebarSyncWatermark.ts");
const stars = await import("./channelStarsStorage.ts");
const mutes = await import("./channelMutesStorage.ts");
const sort = await import("./channelSortPreference.ts");
const sections = await import("./channelSectionsStorage.ts");

const PK = "pk";
const RELAY = "wss://relay.example.com";
const SCOPE = `${PK}:${encodeURIComponent(normalizeRelayUrl(RELAY))}`;

const PREFIX = {
  stars: "buzz-channel-stars-outbox.v1",
  mutes: "buzz-channel-mutes-outbox.v1",
  sort: "buzz-channel-sort-outbox.v1",
  sections: "buzz-channel-sections-outbox.v1",
};

// A foreign window's key: same (pubkey, relay) scope, a different nonce than
// this process's own. `legacyKey` is the pre-per-window shared key (no nonce).
const foreignKey = (lane, nonce) => `${PREFIX[lane]}:${SCOPE}:${nonce}`;
const legacyKey = (lane) => `${PREFIX[lane]}:${SCOPE}`;
const writeAt = (ls, key, store, queuedAt) =>
  ls.setItem(key, JSON.stringify({ store, queuedAt }));

const starStore = (channels) => ({ version: 1, channels });
const starEntry = (starred, updatedAt, rev) => ({ starred, updatedAt, rev });
const muteStore = (channels) => ({ version: 1, channels });
const muteEntry = (muted, updatedAt, rev) => ({ muted, updatedAt, rev });
const sortStore = (groups) => ({ version: 1, groups });
const sectionStore = (secs, assignments = {}) => ({
  version: 1,
  sections: secs,
  assignments,
});

// ── (i) Recheck skips a foreign write injected between decision-read and delete ─
//
// reclaimOutbox re-reads each foreign key immediately before removing it and
// skips when the value changed since the reclaim decision. A peer that rewrote
// its key in that gap owns a fresh edit that must survive. Merge lane (stars):
// the head subsumes the enumerated value, so reclaim would fire — but the peer's
// interposed write must be preserved.

test("(i) stars: reclaim recheck skips a foreign key rewritten in the decision→delete gap", () => {
  withStorage((ls) => {
    const key = foreignKey("stars", "peerB");
    // Foreign edit the fetched head has already absorbed → decision = reclaim.
    writeAt(ls, key, starStore({ a: starEntry(true, 100, 1) }), 100);
    // Between the enumerate read (#1) and the recheck read (#2), the peer writes
    // a FRESH edit the head does not reflect.
    ls.onReadMutate(key, 1, (map) =>
      map.set(
        key,
        JSON.stringify({
          store: starStore({ a: starEntry(false, 300, 9) }),
          queuedAt: 300,
        }),
      ),
    );
    // Head carries `a` at (100,1) — subsumes the enumerated value.
    stars.reclaimSubsumedStarsOutbox(
      PK,
      RELAY,
      starStore({ a: starEntry(true, 100, 1) }),
    );
    assert.ok(ls.has(key), "peer's fresh edit must survive the recheck");
    const survived = stars.readChannelStarsOutbox(PK, RELAY);
    assert.deepEqual(survived.channels.a, starEntry(false, 300, 9));
  });
});

test("(i) sort: reclaim recheck skips a foreign key rewritten in the decision→delete gap", () => {
  withStorage((ls) => {
    const key = foreignKey("sort", "peerB");
    writeAt(ls, key, sortStore({ dms: "alpha" }), 100);
    ls.onReadMutate(key, 1, (map) =>
      map.set(
        key,
        JSON.stringify({ store: sortStore({ dms: "recent" }), queuedAt: 500 }),
      ),
    );
    // Head created_at 200 supersedes the queuedAt=100 decision, but not the
    // interposed queuedAt=500 write.
    sort.reclaimSupersededSortOutbox(PK, RELAY, 200);
    assert.ok(ls.has(key), "peer's fresh edit must survive the recheck");
    assert.equal(sort.readChannelSortOutbox(PK, RELAY).groups.dms, "recent");
  });
});

// ── (ii) Two windows teardown/remount: every unpublished intent preserved ──────
//
// Windows A and B each persist an edit and quit; a fresh window remounts and
// enumerates both keys. Merge lanes keep BOTH; whole-blob lanes keep the newest
// (an older peer blob is LWW-superseded by definition, the documented residual).

test("(ii) stars (merge): both windows' distinct-channel edits resume", () => {
  withStorage((ls) => {
    writeAt(
      ls,
      foreignKey("stars", "A"),
      starStore({ a: starEntry(true, 100, 1) }),
      100,
    );
    writeAt(
      ls,
      foreignKey("stars", "B"),
      starStore({ b: starEntry(true, 200, 1) }),
      200,
    );
    const resumed = stars.readChannelStarsOutbox(PK, RELAY);
    assert.deepEqual(resumed.channels.a, starEntry(true, 100, 1));
    assert.deepEqual(resumed.channels.b, starEntry(true, 200, 1));
  });
});

test("(ii) mutes (merge): both windows' distinct-channel edits resume", () => {
  withStorage((ls) => {
    writeAt(
      ls,
      foreignKey("mutes", "A"),
      muteStore({ a: muteEntry(true, 100, 1) }),
      100,
    );
    writeAt(
      ls,
      foreignKey("mutes", "B"),
      muteStore({ b: muteEntry(true, 200, 1) }),
      200,
    );
    const resumed = mutes.readChannelMutesOutbox(PK, RELAY);
    assert.deepEqual(resumed.channels.a, muteEntry(true, 100, 1));
    assert.deepEqual(resumed.channels.b, muteEntry(true, 200, 1));
  });
});

test("(ii) sort (whole-blob): the newest queued window resumes; older is LWW-superseded", () => {
  withStorage((ls) => {
    writeAt(ls, foreignKey("sort", "A"), sortStore({ channels: "alpha" }), 100);
    writeAt(
      ls,
      foreignKey("sort", "B"),
      sortStore({ channels: "recent" }),
      200,
    );
    assert.equal(
      sort.readChannelSortOutbox(PK, RELAY).groups.channels,
      "recent",
    );
  });
});

test("(ii) sections (whole-blob): the newest queued window resumes; older is LWW-superseded", () => {
  withStorage((ls) => {
    writeAt(
      ls,
      foreignKey("sections", "A"),
      sectionStore([{ id: "s1", name: "One", order: 0 }]),
      100,
    );
    writeAt(
      ls,
      foreignKey("sections", "B"),
      sectionStore([{ id: "s2", name: "Two", order: 0 }]),
      200,
    );
    assert.deepEqual(sections.readChannelSectionsOutbox(PK, RELAY).sections, [
      { id: "s2", name: "Two", order: 0 },
    ]);
  });
});

// ── (iii) Legacy v1 shared key: replays, then reclaimed only by relay gating ───
//
// A pre-per-window build wrote one shared key. It enumerates as one more record
// (queuedAt 0 for a bare store), resumes, and is reclaimed by the same relay-
// gated rule — never dropped on replay alone (mixed dev/DMG fleet residual).

test("(iii) stars: legacy shared key resumes, then is reclaimed once the head subsumes it", () => {
  withStorage((ls) => {
    // Legacy bare store (no envelope) from a pre-per-window build.
    ls.setItem(
      legacyKey("stars"),
      JSON.stringify(starStore({ a: starEntry(true, 100, 1) })),
    );
    const resumed = stars.readChannelStarsOutbox(PK, RELAY);
    assert.deepEqual(
      resumed.channels.a,
      starEntry(true, 100, 1),
      "legacy entry resumes",
    );
    // A head that does NOT subsume it (older rev) keeps it.
    stars.reclaimSubsumedStarsOutbox(
      PK,
      RELAY,
      starStore({ a: starEntry(true, 50, 0) }),
    );
    assert.ok(ls.has(legacyKey("stars")), "unsubsumed legacy entry is kept");
    // A head that subsumes it reclaims it.
    stars.reclaimSubsumedStarsOutbox(
      PK,
      RELAY,
      starStore({ a: starEntry(true, 100, 1) }),
    );
    assert.ok(
      !ls.has(legacyKey("stars")),
      "subsumed legacy entry is reclaimed",
    );
  });
});

test("(iii) sections: legacy shared key resumes, then is reclaimed once the head supersedes it", () => {
  withStorage((ls) => {
    // Legacy entry as a {store, queuedAt} envelope from an interim build.
    writeAt(
      ls,
      legacyKey("sections"),
      sectionStore([{ id: "s1", name: "One", order: 0 }]),
      100,
    );
    assert.deepEqual(sections.readChannelSectionsOutbox(PK, RELAY).sections, [
      { id: "s1", name: "One", order: 0 },
    ]);
    // Head created_at before the queued stamp keeps it (not yet superseded).
    sections.reclaimSupersededSectionsOutbox(PK, RELAY, 50);
    assert.ok(
      ls.has(legacyKey("sections")),
      "un-superseded legacy entry is kept",
    );
    // Head created_at at/after the queued stamp supersedes and reclaims it.
    sections.reclaimSupersededSectionsOutbox(PK, RELAY, 100);
    assert.ok(
      !ls.has(legacyKey("sections")),
      "superseded legacy entry is reclaimed",
    );
  });
});

// ── (iv) Whole-blob replay tie → deterministic nonce (key) tiebreak ────────────

test("(iv) sort: equal-queuedAt records resolve by key so replay is deterministic", () => {
  withStorage((ls) => {
    writeAt(ls, foreignKey("sort", "aaa"), sortStore({ forums: "alpha" }), 100);
    writeAt(
      ls,
      foreignKey("sort", "zzz"),
      sortStore({ forums: "recent" }),
      100,
    );
    // Same queuedAt → the lexicographically-greater key wins (…:zzz).
    assert.equal(sort.readChannelSortOutbox(PK, RELAY).groups.forums, "recent");
  });
});

// ── (v) Merge-lane replay is order-independent ─────────────────────────────────

test("(v) stars: same-channel records fold to the max entry regardless of key order", () => {
  withStorage((ls) => {
    // Lower-rev record under a lexicographically-greater key (enumerated later)
    // must still lose to the higher-rev record — merge is order-independent.
    writeAt(
      ls,
      foreignKey("stars", "aaa"),
      starStore({ c: starEntry(true, 100, 5) }),
      100,
    );
    writeAt(
      ls,
      foreignKey("stars", "zzz"),
      starStore({ c: starEntry(false, 100, 2) }),
      200,
    );
    const merged = stars.readChannelStarsOutbox(PK, RELAY);
    assert.deepEqual(
      merged.channels.c,
      starEntry(true, 100, 5),
      "higher rev wins the tie",
    );
  });
});

// ── (vi) GC no-op when the head subsumes/supersedes nothing ────────────────────
//
// The hook calls reclaim only inside the `apply-remote` branch, so a `failed`
// head fetch (or `absent`) never invokes it — that guard is structural in the
// hook. At the storage layer the matching invariant is that a head which
// subsumes/supersedes nothing removes nothing: a foreign edit newer than the
// head is live intent and is kept, so a stale/empty head can never over-collect.

test("(vi) stars: a head that subsumes nothing reclaims nothing", () => {
  withStorage((ls) => {
    const key = foreignKey("stars", "B");
    writeAt(ls, key, starStore({ a: starEntry(true, 300, 2) }), 300);
    // Empty head subsumes no channel → keep everything.
    stars.reclaimSubsumedStarsOutbox(PK, RELAY, starStore({}));
    assert.ok(ls.has(key), "unsubsumed foreign edit is kept");
  });
});

test("(vi) sort: a head older than the queued edit supersedes nothing", () => {
  withStorage((ls) => {
    const key = foreignKey("sort", "B");
    writeAt(ls, key, sortStore({ dms: "recent" }), 300);
    // headCreatedAt=0 (absent-equivalent) < queuedAt → keep.
    sort.reclaimSupersededSortOutbox(PK, RELAY, 0);
    assert.ok(ls.has(key), "edit queued after the head is kept");
  });
});

// ── Own-key round trip: write, read, clear (single-window baseline) ────────────

test("own key: write resumes, clear removes only this window's own key", () => {
  withStorage((ls) => {
    stars.writeChannelStarsOutbox(
      PK,
      starStore({ a: starEntry(true, 100, 1) }),
      RELAY,
    );
    const ownKey = `${PREFIX.stars}:${SCOPE}:${outboxWindowNonce()}`;
    assert.ok(ls.has(ownKey), "own edit is written under this window's nonce");
    // A foreign peer key is untouched by an own-key clear.
    writeAt(
      ls,
      foreignKey("stars", "peer"),
      starStore({ z: starEntry(true, 9, 1) }),
      9,
    );
    stars.clearChannelStarsOutbox(PK, RELAY);
    assert.ok(!ls.has(ownKey), "own key cleared");
    assert.ok(
      ls.has(foreignKey("stars", "peer")),
      "foreign key untouched by own clear",
    );
  });
});
