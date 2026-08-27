import assert from "node:assert/strict";
import test from "node:test";

// Multi-window durable-outbox safety (Carl's CHANGES_REQUESTED, finding P1).
//
// All four sidebar-sync lanes persist an unpublished edit so it survives a
// quit/community-switch inside the 2s publish debounce. localStorage offers no
// atomic compare-and-delete or transactional read-modify-write, so neither a
// single shared key nor a per-window key a window OVERWRITES can be reclaimed
// by a peer safely: the value can change between the reclaim decision-read and
// the delete (the recheck race a byte-compare narrows but cannot close).
//
// The fix keys the outbox per window AND write-once:
// `<prefix>:<pubkey>:<relay>:<nonce>:<seq>`, where the nonce is stable per
// window (sessionStorage) and `seq` is a per-window monotonic counter. A window
// NEVER rewrites a key: a new edit writes a NEW key, then deletes its own older
// keys (write-before-delete, so a crash leaves ≥1 record, never zero). Because
// records are immutable, a booting peer that proves a foreign key reclaimable
// against durable relay evidence can delete it with no recheck — nothing can
// have changed at that key since the proof. Resume enumerates ALL windows'
// keys: merge lanes (stars/mutes) fold every record (order-independent);
// whole-blob lanes (sort/sections) replay the max-`queuedAt` record, ties broken
// by key. Reclamation runs AFTER replay so a same-second record the head appears
// to supersede is consumed into pending first. Whole-blob supersession is STRICT
// (`queuedAt` < head `created_at`) so a same-second record is never dropped, and
// the legacy v1 shared key is never deleted by v2 (it is mutable; only replayed).
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
// this process's own, plus a zero-padded `seq`. `legacyKey` is the
// pre-per-window shared key (no nonce/seq).
const SEQ_WIDTH = 12;
const pad = (seq) => String(seq).padStart(SEQ_WIDTH, "0");
const foreignKey = (lane, nonce, seq) =>
  `${PREFIX[lane]}:${SCOPE}:${nonce}:${pad(seq)}`;
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

// ── (i) Reclaim never deletes a foreign edit written in the decision→delete gap ─
//
// Records are write-once: an owner's fresh edit lands on a NEW key, never a
// rewrite of the enumerated one. reclaimOutbox proves the enumerated (stale)
// key reclaimable and deletes it; a peer edit injected during enumeration lives
// under its own key and is evaluated on its own merits (kept when the head does
// not subsume/supersede it). We interpose that fresh write via the read-mutate
// seam to prove GC removes only the proven-stale key and never the fresh one.

test("(i) stars: reclaim deletes the proven-stale key and keeps a fresh edit written in the gap", () => {
  withStorage((ls) => {
    const stale = foreignKey("stars", "peerB", 0);
    // Foreign edit the fetched head has already absorbed → decision = reclaim.
    writeAt(ls, stale, starStore({ a: starEntry(true, 100, 1) }), 100);
    // During enumeration (read of the stale key), the peer commits a FRESH edit
    // to a NEW key the head does not reflect — the write-once analogue of the
    // owner rewriting in the gap.
    const fresh = foreignKey("stars", "peerB", 1);
    ls.onReadMutate(stale, 1, (map) =>
      map.set(
        fresh,
        JSON.stringify({
          store: starStore({ z: starEntry(true, 300, 9) }),
          queuedAt: 300,
        }),
      ),
    );
    // Head carries `a` at (100,1) — subsumes the stale value, not the fresh one.
    stars.reclaimSubsumedStarsOutbox(
      PK,
      RELAY,
      starStore({ a: starEntry(true, 100, 1) }),
    );
    assert.ok(!ls.has(stale), "proven-stale key is reclaimed");
    assert.ok(ls.has(fresh), "peer's fresh edit under a new key survives");
    assert.deepEqual(
      stars.readChannelStarsOutbox(PK, RELAY).channels.z,
      starEntry(true, 300, 9),
    );
  });
});

test("(i) sort: reclaim deletes the proven-stale key and keeps a fresh edit written in the gap", () => {
  withStorage((ls) => {
    const stale = foreignKey("sort", "peerB", 0);
    writeAt(ls, stale, sortStore({ dms: "alpha" }), 100);
    const fresh = foreignKey("sort", "peerB", 1);
    ls.onReadMutate(stale, 1, (map) =>
      map.set(
        fresh,
        JSON.stringify({ store: sortStore({ dms: "recent" }), queuedAt: 500 }),
      ),
    );
    // Head created_at 200 strictly supersedes the queuedAt=100 stale record,
    // not the interposed queuedAt=500 fresh key.
    sort.reclaimSupersededSortOutbox(PK, RELAY, 200);
    assert.ok(!ls.has(stale), "proven-stale key is reclaimed");
    assert.ok(ls.has(fresh), "peer's fresh edit under a new key survives");
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
      foreignKey("stars", "A", 0),
      starStore({ a: starEntry(true, 100, 1) }),
      100,
    );
    writeAt(
      ls,
      foreignKey("stars", "B", 0),
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
      foreignKey("mutes", "A", 0),
      muteStore({ a: muteEntry(true, 100, 1) }),
      100,
    );
    writeAt(
      ls,
      foreignKey("mutes", "B", 0),
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
    writeAt(
      ls,
      foreignKey("sort", "A", 0),
      sortStore({ channels: "alpha" }),
      100,
    );
    writeAt(
      ls,
      foreignKey("sort", "B", 0),
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
      foreignKey("sections", "A", 0),
      sectionStore([{ id: "s1", name: "One", order: 0 }]),
      100,
    );
    writeAt(
      ls,
      foreignKey("sections", "B", 0),
      sectionStore([{ id: "s2", name: "Two", order: 0 }]),
      200,
    );
    assert.deepEqual(sections.readChannelSectionsOutbox(PK, RELAY).sections, [
      { id: "s2", name: "Two", order: 0 },
    ]);
  });
});

// ── (iii) Same-second whole-blob: head at t keeps a record queued at t ─────────
//
// One-second clock granularity means a record queued in the same second as the
// head cannot be proven to have lost LWW. Strict supersession (`queuedAt` <
// head `created_at`) keeps it; a strictly-earlier record is reclaimed.

test("(iii) sort: same-second record kept, strictly-earlier reclaimed", () => {
  withStorage((ls) => {
    const sameSecond = foreignKey("sort", "same", 0);
    const earlier = foreignKey("sort", "old", 0);
    writeAt(ls, sameSecond, sortStore({ dms: "recent" }), 100);
    writeAt(ls, earlier, sortStore({ dms: "alpha" }), 99);
    sort.reclaimSupersededSortOutbox(PK, RELAY, 100);
    assert.ok(ls.has(sameSecond), "same-second record (queuedAt == head) kept");
    assert.ok(!ls.has(earlier), "strictly-earlier record reclaimed");
  });
});

test("(iii) sections: same-second record kept, strictly-earlier reclaimed", () => {
  withStorage((ls) => {
    const sameSecond = foreignKey("sections", "same", 0);
    const earlier = foreignKey("sections", "old", 0);
    writeAt(
      ls,
      sameSecond,
      sectionStore([{ id: "s2", name: "Two", order: 0 }]),
      100,
    );
    writeAt(
      ls,
      earlier,
      sectionStore([{ id: "s1", name: "One", order: 0 }]),
      99,
    );
    sections.reclaimSupersededSectionsOutbox(PK, RELAY, 100);
    assert.ok(ls.has(sameSecond), "same-second record (queuedAt == head) kept");
    assert.ok(!ls.has(earlier), "strictly-earlier record reclaimed");
  });
});

// ── (iv) Legacy v1 shared key: replays, and is NEVER deleted by v2 ─────────────
//
// A pre-per-window build wrote one shared, MUTABLE key. v2 enumerates it as one
// more record (queuedAt 0 for a bare store) so it resumes, but never deletes it
// under any relay gating — a live old-build window may be rewriting it, and
// queuedAt 0 makes supersession meaningless (mixed dev/DMG fleet residual).

test("(iv) stars: legacy shared key resumes and is never reclaimed", () => {
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
    // Even a head that fully subsumes it must not delete the mutable v1 key.
    stars.reclaimSubsumedStarsOutbox(
      PK,
      RELAY,
      starStore({ a: starEntry(true, 100, 1) }),
    );
    assert.ok(
      ls.has(legacyKey("stars")),
      "legacy v1 key is never deleted by v2",
    );
  });
});

test("(iv) sections: legacy shared key resumes and is never reclaimed", () => {
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
    // A head strictly past the queued stamp still must not delete the v1 key.
    sections.reclaimSupersededSectionsOutbox(PK, RELAY, 999);
    assert.ok(
      ls.has(legacyKey("sections")),
      "legacy v1 key is never deleted by v2",
    );
  });
});

// ── (v) Owner crash between write-new and delete-old → both replay-coalesce ────
//
// writeOwnOutbox writes the new key BEFORE deleting older own keys. A crash in
// that gap leaves two own records for the same window; replay coalesces them
// (merge fold / whole-blob max) with no loss and no duplicate publish.

test("(v) stars: two own records from a write-new/delete-old crash merge-coalesce", () => {
  withStorage((ls) => {
    const base = `${PREFIX.stars}:${SCOPE}:${outboxWindowNonce()}`;
    // Simulate the crash residue: the pre-crash key (seq 0) plus the freshly
    // written key (seq 1) both present. Merge must keep both channels.
    writeAt(
      ls,
      `${base}:${pad(0)}`,
      starStore({ a: starEntry(true, 100, 1) }),
      100,
    );
    writeAt(
      ls,
      `${base}:${pad(1)}`,
      starStore({ b: starEntry(true, 200, 1) }),
      200,
    );
    const resumed = stars.readChannelStarsOutbox(PK, RELAY);
    assert.deepEqual(resumed.channels.a, starEntry(true, 100, 1));
    assert.deepEqual(resumed.channels.b, starEntry(true, 200, 1));
  });
});

test("(v) sort: two own records from a crash resume the newer seq (padded key order)", () => {
  withStorage((ls) => {
    const base = `${PREFIX.sort}:${SCOPE}:${outboxWindowNonce()}`;
    // Same-second seqs crossing a digit boundary: unpadded, "9" > "10"
    // lexically and would wrongly resume the OLDER edit. Zero-padding makes the
    // higher seq win the whole-blob tiebreak.
    writeAt(ls, `${base}:${pad(9)}`, sortStore({ dms: "alpha" }), 100);
    writeAt(ls, `${base}:${pad(10)}`, sortStore({ dms: "recent" }), 100);
    assert.equal(
      sort.readChannelSortOutbox(PK, RELAY).groups.dms,
      "recent",
      "newer seq resumes despite the digit-boundary crossing",
    );
  });
});

// ── (vi) Reload seeds seq above surviving own keys → no key reuse/overwrite ────
//
// After a reload the sessionStorage nonce survives but the in-memory seq counter
// restarts. A fresh write must allocate a seq ABOVE the max surviving own key so
// it never overwrites (and thus mutates) an existing immutable record.

test("(vi) reload: a write after surviving own keys allocates a strictly-higher key", () => {
  withStorage((ls) => {
    const base = `${PREFIX.stars}:${SCOPE}:${outboxWindowNonce()}`;
    // A surviving own key from before the (simulated) reload.
    writeAt(
      ls,
      `${base}:${pad(5)}`,
      starStore({ a: starEntry(true, 50, 1) }),
      50,
    );
    // First write of the "new session" — seq counter cold, must seed above 5.
    stars.writeChannelStarsOutbox(
      PK,
      starStore({ b: starEntry(true, 100, 1) }),
      RELAY,
    );
    // The pre-reload key must NOT have been overwritten; the new write lands on
    // a strictly-higher key, and delete-old drops the seq-5 key.
    const ownKeys = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k?.startsWith(`${base}:`)) ownKeys.push(k);
    }
    assert.equal(ownKeys.length, 1, "delete-old leaves exactly one own key");
    assert.ok(
      ownKeys[0] > `${base}:${pad(5)}`,
      "new key seq is strictly above the surviving key",
    );
    // No data loss: the newest edit resumes.
    assert.deepEqual(
      stars.readChannelStarsOutbox(PK, RELAY).channels.b,
      starEntry(true, 100, 1),
    );
  });
});

// ── (vii) Whole-blob replay tie → deterministic nonce (key) tiebreak ───────────

test("(vii) sort: equal-queuedAt records resolve by key so replay is deterministic", () => {
  withStorage((ls) => {
    writeAt(
      ls,
      foreignKey("sort", "aaa", 0),
      sortStore({ forums: "alpha" }),
      100,
    );
    writeAt(
      ls,
      foreignKey("sort", "zzz", 0),
      sortStore({ forums: "recent" }),
      100,
    );
    // Same queuedAt → the lexicographically-greater key wins (…:zzz:…).
    assert.equal(sort.readChannelSortOutbox(PK, RELAY).groups.forums, "recent");
  });
});

// ── (viii) Merge-lane replay is order-independent ──────────────────────────────

test("(viii) stars: same-channel records fold to the max entry regardless of key order", () => {
  withStorage((ls) => {
    // Lower-rev record under a lexicographically-greater key (enumerated later)
    // must still lose to the higher-rev record — merge is order-independent.
    writeAt(
      ls,
      foreignKey("stars", "aaa", 0),
      starStore({ c: starEntry(true, 100, 5) }),
      100,
    );
    writeAt(
      ls,
      foreignKey("stars", "zzz", 0),
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

// ── (ix) GC no-op when the head subsumes/supersedes nothing ────────────────────
//
// The hook calls reclaim only inside the `apply-remote` branch, so a `failed`
// head fetch (or `absent`) never invokes it — that guard is structural in the
// hook. At the storage layer the matching invariant is that a head which
// subsumes/supersedes nothing removes nothing: a foreign edit newer than the
// head is live intent and is kept, so a stale/empty head can never over-collect.

test("(ix) stars: a head that subsumes nothing reclaims nothing", () => {
  withStorage((ls) => {
    const key = foreignKey("stars", "B", 0);
    writeAt(ls, key, starStore({ a: starEntry(true, 300, 2) }), 300);
    // Empty head subsumes no channel → keep everything.
    stars.reclaimSubsumedStarsOutbox(PK, RELAY, starStore({}));
    assert.ok(ls.has(key), "unsubsumed foreign edit is kept");
  });
});

test("(ix) sort: a head older than the queued edit supersedes nothing", () => {
  withStorage((ls) => {
    const key = foreignKey("sort", "B", 0);
    writeAt(ls, key, sortStore({ dms: "recent" }), 300);
    // headCreatedAt=0 (absent-equivalent) < queuedAt → keep.
    sort.reclaimSupersededSortOutbox(PK, RELAY, 0);
    assert.ok(ls.has(key), "edit queued after the head is kept");
  });
});

// ── Own-key round trip: write, read, clear (single-window baseline) ────────────

test("own key: write resumes, clear removes only this window's own keys", () => {
  withStorage((ls) => {
    stars.writeChannelStarsOutbox(
      PK,
      starStore({ a: starEntry(true, 100, 1) }),
      RELAY,
    );
    const ownBase = `${PREFIX.stars}:${SCOPE}:${outboxWindowNonce()}`;
    const hasOwn = () => {
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k?.startsWith(`${ownBase}:`)) return true;
      }
      return false;
    };
    assert.ok(hasOwn(), "own edit is written under this window's nonce");
    // A foreign peer key is untouched by an own-key clear.
    writeAt(
      ls,
      foreignKey("stars", "peer", 0),
      starStore({ z: starEntry(true, 9, 1) }),
      9,
    );
    stars.clearChannelStarsOutbox(PK, RELAY);
    assert.ok(!hasOwn(), "own keys cleared");
    assert.ok(
      ls.has(foreignKey("stars", "peer", 0)),
      "foreign key untouched by own clear",
    );
  });
});
