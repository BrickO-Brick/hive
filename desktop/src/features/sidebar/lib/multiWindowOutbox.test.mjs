import assert from "node:assert/strict";
import test from "node:test";

// Multi-window durable-outbox safety (Carl's CHANGES_REQUESTED, finding P1).
//
// The fix keys the outbox per window AND write-once:
// `<prefix>:<pubkey>:<relay>:<nonce>:<seq>`. A window NEVER rewrites a key:
// a new edit writes a NEW key then deletes its own older keys (write-before-delete).
// Because records are immutable, a booting peer that proves a foreign key
// reclaimable against durable relay evidence can delete it with no recheck.
// Resume enumerates ALL windows' keys: merge lanes fold every record; whole-blob
// lanes replay the max-queuedAt record, ties broken by key. Reclamation runs
// AFTER replay so a same-second record appears to supersede is consumed into
// pending first. Whole-blob supersession is STRICT (queuedAt < head created_at)
// so a same-second record is never dropped, and the legacy v1 shared key is
// never deleted by v2.
//
// This suite drives the shared helpers through a mock Storage seam — no relay,
// no timers — so each interleaving is deterministic. Manager/hook-level behavior
// is covered by their own suites; this file isolates the cross-window storage
// contract.

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
const sort = await import("./channelSortPreference.ts");
const sections = await import("./channelSectionsStorage.ts");

const PK = "pk";
const RELAY = "wss://relay.example.com";
const SCOPE = `${PK}:${encodeURIComponent(normalizeRelayUrl(RELAY))}`;

const PREFIX = {
  stars: "buzz-channel-stars-outbox.v1",
  sort: "buzz-channel-sort-outbox.v1",
  sections: "buzz-channel-sections-outbox.v1",
};

const SEQ_WIDTH = 12;
const pad = (seq) => String(seq).padStart(SEQ_WIDTH, "0");
const foreignKey = (lane, nonce, seq) =>
  `${PREFIX[lane]}:${SCOPE}:${nonce}:${pad(seq)}`;
const legacyKey = (lane) => `${PREFIX[lane]}:${SCOPE}`;
const writeAt = (ls, key, store, queuedAt) =>
  ls.setItem(key, JSON.stringify({ store, queuedAt }));

const starStore = (channels) => ({ version: 1, channels });
const starEntry = (starred, updatedAt, rev) => ({ starred, updatedAt, rev });
const sortStore = (groups) => ({ version: 1, groups });
const sectionStore = (secs, assignments = {}) => ({
  version: 1,
  sections: secs,
  assignments,
});

// ── (i) Reclaim never deletes a foreign edit written in the decision→delete gap ──
// Records are write-once: an owner's fresh edit lands on a NEW key, never a
// rewrite. reclaimOutbox proves the enumerated (stale) key reclaimable and deletes
// it; a peer edit injected during enumeration lives under its own key.

test("(i) stars: reclaim deletes the proven-stale key and keeps a fresh edit written in the gap", () => {
  withStorage((ls) => {
    const stale = foreignKey("stars", "peerB", 0);
    writeAt(ls, stale, starStore({ a: starEntry(true, 100, 1) }), 100);
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
    sort.reclaimSupersededSortOutbox(PK, RELAY, 200);
    assert.ok(!ls.has(stale), "proven-stale key is reclaimed");
    assert.ok(ls.has(fresh), "peer's fresh edit under a new key survives");
    assert.equal(
      sort.readChannelSortOutbox(PK, RELAY).store.groups.dms,
      "recent",
    );
  });
});

// ── (ii) Two windows teardown/remount: every unpublished intent preserved ───────

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

test("(ii) sort (whole-blob): newest queued window resumes; older is LWW-superseded", () => {
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
      sort.readChannelSortOutbox(PK, RELAY).store.groups.channels,
      "recent",
    );
  });
});

// ── (iii) Same-second whole-blob: head at t keeps a record queued at t ──────────

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
    assert.ok(ls.has(sameSecond), "same-second record kept");
    assert.ok(!ls.has(earlier), "strictly-earlier record reclaimed");
  });
});

// ── (iv) Legacy v1 shared key: replays, and is NEVER deleted by v2 ─────────────

test("(iv) stars: legacy shared key resumes and is never reclaimed", () => {
  withStorage((ls) => {
    ls.setItem(
      legacyKey("stars"),
      JSON.stringify(starStore({ a: starEntry(true, 100, 1) })),
    );
    assert.deepEqual(
      stars.readChannelStarsOutbox(PK, RELAY).channels.a,
      starEntry(true, 100, 1),
      "legacy entry resumes",
    );
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
    writeAt(
      ls,
      legacyKey("sections"),
      sectionStore([{ id: "s1", name: "One", order: 0 }]),
      100,
    );
    assert.deepEqual(
      sections.readChannelSectionsOutbox(PK, RELAY).store.sections,
      [{ id: "s1", name: "One", order: 0 }],
    );
    sections.reclaimSupersededSectionsOutbox(PK, RELAY, 999);
    assert.ok(
      ls.has(legacyKey("sections")),
      "legacy v1 key is never deleted by v2",
    );
  });
});

// ── (v) Owner crash between write-new and delete-old → both replay-coalesce ─────

test("(v) stars: two own records from a write-new/delete-old crash merge-coalesce", () => {
  withStorage((ls) => {
    const base = `${PREFIX.stars}:${SCOPE}:${outboxWindowNonce()}`;
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

test("(v) sort: two own records resume the newer seq (padded key order)", () => {
  withStorage((ls) => {
    const base = `${PREFIX.sort}:${SCOPE}:${outboxWindowNonce()}`;
    writeAt(ls, `${base}:${pad(9)}`, sortStore({ dms: "alpha" }), 100);
    writeAt(ls, `${base}:${pad(10)}`, sortStore({ dms: "recent" }), 100);
    assert.equal(
      sort.readChannelSortOutbox(PK, RELAY).store.groups.dms,
      "recent",
      "newer seq resumes",
    );
  });
});

// ── (vi) Reload seeds seq above surviving own keys → no key reuse/overwrite ─────

test("(vi) reload: write after surviving own keys allocates a strictly-higher key", () => {
  withStorage((ls) => {
    const base = `${PREFIX.stars}:${SCOPE}:${outboxWindowNonce()}`;
    writeAt(
      ls,
      `${base}:${pad(5)}`,
      starStore({ a: starEntry(true, 50, 1) }),
      50,
    );
    stars.writeChannelStarsOutbox(
      PK,
      starStore({ b: starEntry(true, 100, 1) }),
      RELAY,
    );
    const ownKeys = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k?.startsWith(`${base}:`)) ownKeys.push(k);
    }
    assert.equal(ownKeys.length, 1, "delete-old leaves exactly one own key");
    assert.ok(
      ownKeys[0] > `${base}:${pad(5)}`,
      "new key seq is strictly above surviving key",
    );
    assert.deepEqual(
      stars.readChannelStarsOutbox(PK, RELAY).channels.b,
      starEntry(true, 100, 1),
    );
  });
});

// ── (vii) Whole-blob replay tie → deterministic key tiebreak ─────────────────

test("(vii) sort: equal-queuedAt records resolve by key (deterministic)", () => {
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
    assert.equal(
      sort.readChannelSortOutbox(PK, RELAY).store.groups.forums,
      "recent",
    );
  });
});

// ── (viii) Merge-lane replay is order-independent ──────────────────────────────

test("(viii) stars: same-channel records fold to max entry regardless of key order", () => {
  withStorage((ls) => {
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
    assert.deepEqual(
      stars.readChannelStarsOutbox(PK, RELAY).channels.c,
      starEntry(true, 100, 5),
      "higher rev wins",
    );
  });
});

// ── (ix) GC no-op when head subsumes/supersedes nothing ──────────────────────

test("(ix) stars: head that subsumes nothing reclaims nothing", () => {
  withStorage((ls) => {
    const key = foreignKey("stars", "B", 0);
    writeAt(ls, key, starStore({ a: starEntry(true, 300, 2) }), 300);
    stars.reclaimSubsumedStarsOutbox(PK, RELAY, starStore({}));
    assert.ok(ls.has(key), "unsubsumed foreign edit is kept");
  });
});

test("(ix) sort: head older than queued edit supersedes nothing", () => {
  withStorage((ls) => {
    const key = foreignKey("sort", "B", 0);
    writeAt(ls, key, sortStore({ dms: "recent" }), 300);
    sort.reclaimSupersededSortOutbox(PK, RELAY, 0);
    assert.ok(ls.has(key), "edit queued after the head is kept");
  });
});

// ── (x) Legacy whole-blob replay is one-shot and value-sensitive ───────────────
// Without a consumption marker, resumeWholeBlobOutbox would return the legacy blob
// on EVERY boot and the hook would republish the stale blob forever. The per-value
// marker records the exact legacy raw a prior boot replayed.

test("(x) sort: retained legacy blob replays once, then is skipped across later boots", () => {
  withStorage((ls) => {
    ls.setItem(legacyKey("sort"), JSON.stringify(sortStore({ dms: "recent" })));
    const boot1 = sort.readChannelSortOutbox(PK, RELAY);
    assert.equal(boot1.store.groups.dms, "recent", "legacy blob resumes");
    assert.equal(
      boot1.legacyRawToConsume,
      JSON.stringify(sortStore({ dms: "recent" })),
      "reports exact legacy raw",
    );
    sort.markChannelSortLegacyConsumed(PK, RELAY, boot1.legacyRawToConsume);
    assert.ok(ls.has(legacyKey("sort")), "legacy key never deleted");
    assert.equal(
      sort.readChannelSortOutbox(PK, RELAY),
      null,
      "consumed blob not replayed again",
    );
    assert.equal(
      sort.readChannelSortOutbox(PK, RELAY),
      null,
      "still skipped on third boot",
    );
  });
});

test("(x) sections: a rewritten legacy blob (live old build) is replayed again", () => {
  withStorage((ls) => {
    writeAt(
      ls,
      legacyKey("sections"),
      sectionStore([{ id: "s1", name: "One", order: 0 }]),
      0,
    );
    const boot1 = sections.readChannelSectionsOutbox(PK, RELAY);
    assert.deepEqual(boot1.store.sections, [
      { id: "s1", name: "One", order: 0 },
    ]);
    sections.markChannelSectionsLegacyConsumed(
      PK,
      RELAY,
      boot1.legacyRawToConsume,
    );
    assert.equal(
      sections.readChannelSectionsOutbox(PK, RELAY),
      null,
      "consumed blob skipped",
    );
    writeAt(
      ls,
      legacyKey("sections"),
      sectionStore([{ id: "s2", name: "Two", order: 0 }]),
      0,
    );
    const boot3 = sections.readChannelSectionsOutbox(PK, RELAY);
    assert.deepEqual(
      boot3.store.sections,
      [{ id: "s2", name: "Two", order: 0 }],
      "changed legacy value replayed",
    );
    assert.ok(boot3.legacyRawToConsume !== null);
  });
});

test("(x) sort: crash after v2 transfer but before the marker resumes from the v2 key", () => {
  withStorage((ls) => {
    ls.setItem(legacyKey("sort"), JSON.stringify(sortStore({ dms: "recent" })));
    const boot1 = sort.readChannelSortOutbox(PK, RELAY);
    sort.writeChannelSortOutbox(PK, boot1.store, RELAY); // transfer to v2; crash before mark
    const boot2 = sort.readChannelSortOutbox(PK, RELAY);
    assert.equal(boot2.store.groups.dms, "recent", "intent survives in v2 key");
    assert.equal(
      boot2.legacyRawToConsume,
      null,
      "winner is the v2 key, not legacy",
    );
  });
});

test("(x) stars (merge lane): head-subsumed legacy fold needs no replay publish", () => {
  withStorage((ls) => {
    ls.setItem(
      legacyKey("stars"),
      JSON.stringify(starStore({ a: starEntry(true, 100, 1) })),
    );
    const outbox = stars.readChannelStarsOutbox(PK, RELAY);
    assert.ok(
      stars.isStarsStoreSubsumedBy(
        outbox,
        starStore({ a: starEntry(true, 100, 1) }),
      ),
      "head-subsumed legacy fold is publish-free",
    );
    assert.ok(
      !stars.isStarsStoreSubsumedBy(outbox, starStore({})),
      "unsubsumed legacy click still needs a publish",
    );
  });
});

// ── Own-key round trip: write, read, clear ────────────────────────────────────

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
    assert.ok(hasOwn(), "own edit written under this window's nonce");
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
