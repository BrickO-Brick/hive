import assert from "node:assert/strict";
import test from "node:test";

// Multi-window durable-outbox safety (Carl's CHANGES_REQUESTED, finding P1).
//
// All four sidebar-sync lanes share one localStorage outbox key per
// (identity, relay), but generation ownership is in-memory per window. Without
// a per-write ownership token, window A's completing publish can clear window
// B's still-unpublished edit (stale-clear, prong a), and — for the merge lanes
// — B's write can overwrite A's still-unpublished payload (overwrite, prong b).
//
// The fix: every outbox write mints a token and stores a `{store, token}`
// envelope; a completing publish compare-and-clears only when the stored token
// still matches its own. Merge lanes (stars/mutes) additionally read-merge-write
// so two windows editing different channels both survive. Replace lanes
// (sort/sections) resolve whole-blob LWW: the last writer's token owns the entry.
//
// This matrix drives the shared helpers directly through localStorage — no
// relay, no timers — so each interleaving is deterministic. Manager-level and
// hook-level behavior is covered by their own suites; this file isolates the
// cross-window contract the token exists to hold.

function withFreshStorage(fn) {
  const store = new Map();
  const ls = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  const orig = globalThis.window?.localStorage;
  if (typeof globalThis.window === "undefined") globalThis.window = {};
  globalThis.window.localStorage = ls;
  try {
    fn(ls);
  } finally {
    if (orig !== undefined) globalThis.window.localStorage = orig;
    else delete globalThis.window.localStorage;
  }
}

const { mintOutboxToken } = await import("./sidebarSyncWatermark.ts");
const stars = await import("./channelStarsStorage.ts");
const mutes = await import("./channelMutesStorage.ts");
const sort = await import("./channelSortPreference.ts");
const sections = await import("./channelSectionsStorage.ts");

const PK = "pk";
const RELAY = "wss://relay.example.com";

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

// ── (a) stale-clear: A queues → B queues → A completes and clears → B survives ─
//
// Applies to every lane: A's completion carries A's token; B's later write
// replaced the token, so A's compare-and-clear must no-op and B's edit stays.

test("(a) stars: A's completing clear does not erase B's later queued edit", () => {
  withFreshStorage(() => {
    const tokenA = mintOutboxToken();
    stars.writeChannelStarsOutbox(
      PK,
      starStore({ a: starEntry(true, 100, 1) }),
      RELAY,
      tokenA,
    );
    const tokenB = mintOutboxToken();
    stars.writeChannelStarsOutbox(
      PK,
      starStore({ b: starEntry(true, 200, 1) }),
      RELAY,
      tokenB,
    );
    // A completes and tries to clear with its own (now-stale) token.
    stars.clearChannelStarsOutbox(PK, RELAY, tokenA);
    const survived = stars.readChannelStarsOutbox(PK, RELAY);
    assert.ok(survived, "B's edit must survive A's stale clear");
    assert.deepEqual(survived.channels.b, starEntry(true, 200, 1));
    // B's own completion clears cleanly.
    stars.clearChannelStarsOutbox(PK, RELAY, tokenB);
    assert.equal(stars.readChannelStarsOutbox(PK, RELAY), null);
  });
});

test("(a) mutes: A's completing clear does not erase B's later queued edit", () => {
  withFreshStorage(() => {
    const tokenA = mintOutboxToken();
    mutes.writeChannelMutesOutbox(
      PK,
      muteStore({ a: muteEntry(true, 100, 1) }),
      RELAY,
      tokenA,
    );
    const tokenB = mintOutboxToken();
    mutes.writeChannelMutesOutbox(
      PK,
      muteStore({ b: muteEntry(true, 200, 1) }),
      RELAY,
      tokenB,
    );
    mutes.clearChannelMutesOutbox(PK, RELAY, tokenA);
    const survived = mutes.readChannelMutesOutbox(PK, RELAY);
    assert.ok(survived, "B's edit must survive A's stale clear");
    assert.deepEqual(survived.channels.b, muteEntry(true, 200, 1));
    mutes.clearChannelMutesOutbox(PK, RELAY, tokenB);
    assert.equal(mutes.readChannelMutesOutbox(PK, RELAY), null);
  });
});

test("(a) sort: A's completing clear does not erase B's later queued edit", () => {
  withFreshStorage(() => {
    const tokenA = mintOutboxToken();
    sort.writeChannelSortOutbox(
      PK,
      sortStore({ channels: "alpha" }),
      RELAY,
      tokenA,
    );
    const tokenB = mintOutboxToken();
    sort.writeChannelSortOutbox(
      PK,
      sortStore({ channels: "recent" }),
      RELAY,
      tokenB,
    );
    sort.clearChannelSortOutbox(PK, RELAY, tokenA);
    const survived = sort.readChannelSortOutbox(PK, RELAY);
    assert.ok(survived, "B's edit must survive A's stale clear");
    assert.equal(survived.groups.channels, "recent");
    sort.clearChannelSortOutbox(PK, RELAY, tokenB);
    assert.equal(sort.readChannelSortOutbox(PK, RELAY), null);
  });
});

test("(a) sections: A's completing clear does not erase B's later queued edit", () => {
  withFreshStorage(() => {
    const tokenA = mintOutboxToken();
    sections.writeChannelSectionsOutbox(
      PK,
      sectionStore([{ id: "s1", name: "One", order: 0 }]),
      RELAY,
      tokenA,
    );
    const tokenB = mintOutboxToken();
    sections.writeChannelSectionsOutbox(
      PK,
      sectionStore([{ id: "s2", name: "Two", order: 0 }]),
      RELAY,
      tokenB,
    );
    sections.clearChannelSectionsOutbox(PK, RELAY, tokenA);
    const survived = sections.readChannelSectionsOutbox(PK, RELAY);
    assert.ok(survived, "B's edit must survive A's stale clear");
    assert.deepEqual(survived.sections, [{ id: "s2", name: "Two", order: 0 }]);
    sections.clearChannelSectionsOutbox(PK, RELAY, tokenB);
    assert.equal(sections.readChannelSectionsOutbox(PK, RELAY), null);
  });
});

// ── (b) overwrite (merge lanes only): two windows click DIFFERENT channels →
//        both survive in the durable outbox. This is the read-merge-write that
//        distinguishes stars/mutes from the replace lanes.

test("(b) stars: two windows clicking different channels both survive in the outbox", () => {
  withFreshStorage(() => {
    stars.writeChannelStarsOutbox(
      PK,
      starStore({ a: starEntry(true, 100, 1) }),
      RELAY,
      mintOutboxToken(),
    );
    // Window B does not read A first; its write must fold, not clobber.
    stars.writeChannelStarsOutbox(
      PK,
      starStore({ b: starEntry(true, 200, 1) }),
      RELAY,
      mintOutboxToken(),
    );
    const merged = stars.readChannelStarsOutbox(PK, RELAY);
    assert.deepEqual(
      merged.channels.a,
      starEntry(true, 100, 1),
      "A's click retained",
    );
    assert.deepEqual(
      merged.channels.b,
      starEntry(true, 200, 1),
      "B's click retained",
    );
  });
});

test("(b) mutes: two windows clicking different channels both survive in the outbox", () => {
  withFreshStorage(() => {
    mutes.writeChannelMutesOutbox(
      PK,
      muteStore({ a: muteEntry(true, 100, 1) }),
      RELAY,
      mintOutboxToken(),
    );
    mutes.writeChannelMutesOutbox(
      PK,
      muteStore({ b: muteEntry(true, 200, 1) }),
      RELAY,
      mintOutboxToken(),
    );
    const merged = mutes.readChannelMutesOutbox(PK, RELAY);
    assert.deepEqual(
      merged.channels.a,
      muteEntry(true, 100, 1),
      "A's click retained",
    );
    assert.deepEqual(
      merged.channels.b,
      muteEntry(true, 200, 1),
      "B's click retained",
    );
  });
});

test("(b) stars: same-channel concurrent writes resolve by merge order (higher rev wins)", () => {
  withFreshStorage(() => {
    stars.writeChannelStarsOutbox(
      PK,
      starStore({ c: starEntry(true, 100, 5) }),
      RELAY,
      mintOutboxToken(),
    );
    // A stale same-second peer write for the same channel folds and loses on rev.
    stars.writeChannelStarsOutbox(
      PK,
      starStore({ c: starEntry(false, 100, 2) }),
      RELAY,
      mintOutboxToken(),
    );
    const merged = stars.readChannelStarsOutbox(PK, RELAY);
    assert.deepEqual(
      merged.channels.c,
      starEntry(true, 100, 5),
      "higher rev wins the same-second tie",
    );
  });
});

// ── (c) teardown-in-debounce → remount resumes a merged outbox. Window A edits
//        and tears down before its debounce fires (edit persisted, not cleared);
//        window B edits a different channel meanwhile. On remount the resume
//        reads one merged outbox carrying both — no edit is lost across the
//        teardown boundary. (Merge lanes; replace lanes resolve whole-blob LWW.)

test("(c) stars: an edit persisted before teardown resumes merged with a peer's concurrent edit", () => {
  withFreshStorage(() => {
    // Window A persists its debounce-window edit, then tears down (no clear).
    stars.writeChannelStarsOutbox(
      PK,
      starStore({ a: starEntry(true, 100, 1) }),
      RELAY,
      mintOutboxToken(),
    );
    // Window B persists a different channel before A's remount.
    stars.writeChannelStarsOutbox(
      PK,
      starStore({ b: starEntry(true, 200, 1) }),
      RELAY,
      mintOutboxToken(),
    );
    // Remount reads the durable outbox (the hook's resume path); both survive.
    const resumed = stars.readChannelStarsOutbox(PK, RELAY);
    assert.deepEqual(resumed.channels.a, starEntry(true, 100, 1));
    assert.deepEqual(resumed.channels.b, starEntry(true, 200, 1));
  });
});

test("(c) mutes: an edit persisted before teardown resumes merged with a peer's concurrent edit", () => {
  withFreshStorage(() => {
    mutes.writeChannelMutesOutbox(
      PK,
      muteStore({ a: muteEntry(true, 100, 1) }),
      RELAY,
      mintOutboxToken(),
    );
    mutes.writeChannelMutesOutbox(
      PK,
      muteStore({ b: muteEntry(true, 200, 1) }),
      RELAY,
      mintOutboxToken(),
    );
    const resumed = mutes.readChannelMutesOutbox(PK, RELAY);
    assert.deepEqual(resumed.channels.a, muteEntry(true, 100, 1));
    assert.deepEqual(resumed.channels.b, muteEntry(true, 200, 1));
  });
});

// ── (d) adopt-path clear no-ops on a mismatched token (sort/sections). The
//        adopt path clears the outbox after applying a newer remote head; it
//        must not erase a peer window's fresher local edit.

test("(d) sort: adopt-path clear with a stale token leaves the peer's fresher edit", () => {
  withFreshStorage(() => {
    // Window A adopted a remote head and holds tokenA (its last write).
    const tokenA = mintOutboxToken();
    sort.writeChannelSortOutbox(PK, sortStore({ dms: "alpha" }), RELAY, tokenA);
    // Window B queues a fresher edit, replacing the token.
    const tokenB = mintOutboxToken();
    sort.writeChannelSortOutbox(
      PK,
      sortStore({ dms: "recent" }),
      RELAY,
      tokenB,
    );
    // A's adopt-path clear fires with its now-stale token → must no-op.
    sort.clearChannelSortOutbox(PK, RELAY, tokenA);
    assert.equal(sort.readChannelSortOutbox(PK, RELAY).groups.dms, "recent");
  });
});

test("(d) sections: adopt-path clear with a stale token leaves the peer's fresher edit", () => {
  withFreshStorage(() => {
    const tokenA = mintOutboxToken();
    sections.writeChannelSectionsOutbox(
      PK,
      sectionStore([{ id: "s1", name: "One", order: 0 }]),
      RELAY,
      tokenA,
    );
    const tokenB = mintOutboxToken();
    sections.writeChannelSectionsOutbox(
      PK,
      sectionStore([{ id: "s1", name: "Renamed", order: 0 }]),
      RELAY,
      tokenB,
    );
    sections.clearChannelSectionsOutbox(PK, RELAY, tokenA);
    assert.deepEqual(sections.readChannelSectionsOutbox(PK, RELAY).sections, [
      { id: "s1", name: "Renamed", order: 0 },
    ]);
  });
});

// ── (e) legacy token-less resume: an outbox entry written by a prior (pre-token)
//        build is a bare store, not a `{store, token}` envelope. It must still
//        parse, resume, and be unconditionally clearable.

test("(e) stars: a legacy bare-store outbox entry parses and is clearable", () => {
  withFreshStorage((ls) => {
    // Simulate a pre-token build's write: bare store under the outbox key.
    const key = `buzz-channel-stars-outbox.v1:${PK}:${encodeURIComponent(RELAY)}`;
    ls.setItem(key, JSON.stringify(starStore({ a: starEntry(true, 100, 0) })));
    const resumed = stars.readChannelStarsOutbox(PK, RELAY);
    assert.ok(resumed, "legacy bare-store entry must parse");
    assert.deepEqual(resumed.channels.a, starEntry(true, 100, 0));
    // A token-carrying clear must still remove a legacy (token-less) entry.
    stars.clearChannelStarsOutbox(PK, RELAY, mintOutboxToken());
    assert.equal(stars.readChannelStarsOutbox(PK, RELAY), null);
  });
});

test("(e) sort: a legacy bare-store outbox entry parses and is clearable", () => {
  withFreshStorage((ls) => {
    const key = `buzz-channel-sort-outbox.v1:${PK}:${encodeURIComponent(RELAY)}`;
    ls.setItem(key, JSON.stringify(sortStore({ forums: "recent" })));
    const resumed = sort.readChannelSortOutbox(PK, RELAY);
    assert.ok(resumed, "legacy bare-store entry must parse");
    assert.equal(resumed.groups.forums, "recent");
    sort.clearChannelSortOutbox(PK, RELAY, mintOutboxToken());
    assert.equal(sort.readChannelSortOutbox(PK, RELAY), null);
  });
});

// ── Token-envelope round-trip + omitted-token unconditional clear ──────────────

test("write/read/clear: envelope round-trips and an omitted token clears unconditionally", () => {
  withFreshStorage(() => {
    const token = mintOutboxToken();
    stars.writeChannelStarsOutbox(
      PK,
      starStore({ a: starEntry(true, 100, 1) }),
      RELAY,
      token,
    );
    assert.deepEqual(
      stars.readChannelStarsOutbox(PK, RELAY).channels.a,
      starEntry(true, 100, 1),
    );
    // Omitted token = unconditional clear (bootstrap "nothing to resume" path).
    stars.clearChannelStarsOutbox(PK, RELAY);
    assert.equal(stars.readChannelStarsOutbox(PK, RELAY), null);
  });
});

test("mintOutboxToken: successive mints are distinct", () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(mintOutboxToken());
  assert.equal(seen.size, 1000, "every minted token must be unique");
});
