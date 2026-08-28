import assert from "node:assert/strict";
import test from "node:test";

import {
  boundStarStore,
  DEFAULT_STORE,
  MAX_CHANNEL_STAR_ENTRIES,
  mergeStores,
  parseStarPayload,
  readChannelStarsStore,
  starredChannelIdsFromStore,
  storageKey,
  writeChannelStarsStore,
} from "./channelStarsStorage.ts";
import { normalizeRelayUrl } from "@/shared/lib/normalizeRelayUrl";

if (typeof globalThis.window === "undefined") {
  const storage = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
  };
}

function makeStarStore(channels = {}) {
  return { version: 1, channels };
}

// ── parseStarPayload ──────────────────────────────────────────────────────────

test("parseStarPayload: valid payload with channels returns store (rev preserved)", () => {
  const payload = {
    version: 1,
    channels: {
      "chan-1": { starred: true, updatedAt: 1000, rev: 3 },
      "chan-2": { starred: false, updatedAt: 2000, rev: 0 },
    },
  };
  assert.deepEqual(parseStarPayload(payload), payload);
});

test("parseStarPayload: missing rev normalizes to 0 (old-build blob, entry kept)", () => {
  const result = parseStarPayload({
    version: 1,
    channels: { "chan-1": { starred: true, updatedAt: 1000 } },
  });
  assert.deepEqual(result.channels["chan-1"], {
    starred: true,
    updatedAt: 1000,
    rev: 0,
  });
});

test("parseStarPayload: malformed rev (string / negative / non-integer / NaN / unsafe) normalizes to 0", () => {
  const result = parseStarPayload({
    version: 1,
    channels: {
      str: { starred: true, updatedAt: 1, rev: "5" },
      neg: { starred: true, updatedAt: 1, rev: -2 },
      frac: { starred: true, updatedAt: 1, rev: 1.5 },
      nan: { starred: true, updatedAt: 1, rev: NaN },
      // At or above Number.MAX_SAFE_INTEGER: `maxRev + 1` cannot advance past
      // Number.MAX_SAFE_INTEGER, so an entry at the boundary itself (or beyond)
      // would wedge later toggles forever unless rejected here (Carl P2 /
      // Thufir off-by-one). The bound is exclusive, so the boundary normalizes.
      boundary: { starred: true, updatedAt: 1, rev: Number.MAX_SAFE_INTEGER },
      huge: { starred: true, updatedAt: 1, rev: Number.MAX_SAFE_INTEGER + 1 },
    },
  });
  for (const id of ["str", "neg", "frac", "nan", "boundary", "huge"]) {
    assert.equal(result.channels[id].rev, 0, `${id} rev normalized to 0`);
    assert.equal(result.channels[id].starred, true, `${id} entry kept`);
  }
});

test("parseStarPayload: missing version returns null", () => {
  assert.equal(
    parseStarPayload({
      channels: { "chan-1": { starred: true, updatedAt: 1 } },
    }),
    null,
  );
});

test("parseStarPayload: wrong version returns null", () => {
  assert.equal(
    parseStarPayload({
      version: 2,
      channels: { "chan-1": { starred: true, updatedAt: 1 } },
    }),
    null,
  );
});

test("parseStarPayload: null / non-object input returns null", () => {
  assert.equal(parseStarPayload(null), null);
  assert.equal(parseStarPayload("string"), null);
  assert.equal(parseStarPayload(42), null);
  assert.equal(parseStarPayload(true), null);
});

test("parseStarPayload: malformed channel entries missing starred/updatedAt are filtered out", () => {
  const result = parseStarPayload({
    version: 1,
    channels: {
      "no-starred": { updatedAt: 1000 },
      "no-updated-at": { starred: true },
      valid: { starred: false, updatedAt: 500 },
      "starred-wrong-type": { starred: "yes", updatedAt: 1000 },
      "updated-at-wrong-type": { starred: true, updatedAt: "now" },
      null: null,
    },
  });
  assert.deepEqual(result, {
    version: 1,
    channels: { valid: { starred: false, updatedAt: 500, rev: 0 } },
  });
});

test("parseStarPayload: NaN/Infinity/negative/unsafe updatedAt entries are filtered out", () => {
  const result = parseStarPayload({
    version: 1,
    channels: {
      nan: { starred: true, updatedAt: NaN },
      inf: { starred: true, updatedAt: Infinity },
      "neg-inf": { starred: true, updatedAt: -Infinity },
      neg: { starred: true, updatedAt: -1 },
      // Beyond Number.MAX_SAFE_INTEGER: an unrepresentable second is not a
      // trustworthy watermark, so the entry is dropped rather than kept (Carl
      // P2 — same bound as `rev`).
      unsafe: { starred: true, updatedAt: Number.MAX_SAFE_INTEGER + 1 },
      valid: { starred: true, updatedAt: 100, rev: 2 },
    },
  });
  assert.deepEqual(result, {
    version: 1,
    channels: { valid: { starred: true, updatedAt: 100, rev: 2 } },
  });
});

test("parseStarPayload: empty channels / no channels key returns empty store", () => {
  assert.deepEqual(parseStarPayload({ version: 1, channels: {} }), {
    version: 1,
    channels: {},
  });
  assert.deepEqual(parseStarPayload({ version: 1 }), {
    version: 1,
    channels: {},
  });
});

// ── mergeStores: tuple order (updatedAt → rev → value) ────────────────────────

const E = (starred, updatedAt, rev) => ({ starred, updatedAt, rev });
const S = (entry) => ({ version: 1, channels: { c: entry } });

test("mergeStores: non-overlapping channels returns union", () => {
  const result = mergeStores(
    { version: 1, channels: { a: E(true, 100, 1) } },
    { version: 1, channels: { b: E(false, 200, 1) } },
  );
  assert.deepEqual(result, {
    version: 1,
    channels: { a: E(true, 100, 1), b: E(false, 200, 1) },
  });
});

test("mergeStores: strictly-later updatedAt wins regardless of rev (primary key)", () => {
  // Later updatedAt with LOWER rev still wins — updatedAt is primary. This is
  // the old-build interop case: an old build's rev-0 fresh edit beats a stale
  // rev-bearing new-build entry.
  const result = mergeStores(S(E(false, 200, 0)), S(E(true, 100, 7)));
  assert.deepEqual(result.channels.c, E(false, 200, 0));
});

test("mergeStores: equal updatedAt → higher rev wins (same-second tiebreak)", () => {
  const result = mergeStores(S(E(false, 100, 5)), S(E(true, 100, 2)));
  assert.deepEqual(result.channels.c, E(false, 100, 5));
});

test("mergeStores: equal updatedAt AND equal rev → starred=true wins (leaf)", () => {
  const result = mergeStores(S(E(false, 100, 3)), S(E(true, 100, 3)));
  assert.deepEqual(result.channels.c, E(true, 100, 3));
});

test("mergeStores: same-second old-build click (rev 0) loses to an earlier new-build rev, heals next second", () => {
  // ACCEPTED MIXED-FLEET RESIDUAL (Carl P1 #5). A new build wrote {starred:true,
  // rev:2} at second 100; an old build then UNSTARS in the SAME second — old
  // builds mint no rev, so its click reads rev:0. It loses the same-second tie
  // to the earlier rev-2 entry: the later intent is suppressed until a
  // strictly-later second carries it on the primary updatedAt key. This pins the
  // current deterministic outcome; it is not a regression to fix here.
  const newBuildStar = S(E(true, 100, 2));
  const oldBuildUnstarSameSecond = S(E(false, 100, 0));
  assert.deepEqual(
    mergeStores(newBuildStar, oldBuildUnstarSameSecond).channels.c,
    E(true, 100, 2),
    "the earlier new-build rev-2 star wins the same-second tie — old click's unstar is lost",
  );

  // The same old-build unstar one second later wins outright on updatedAt: the
  // residual self-heals the moment the user clicks again in a later second.
  const oldBuildUnstarNextSecond = S(E(false, 101, 0));
  assert.deepEqual(
    mergeStores(newBuildStar, oldBuildUnstarNextSecond).channels.c,
    E(false, 101, 0),
    "a strictly-later-second old-build unstar wins — the residual is transient",
  );
});

test("mergeStores: a boundary (MAX_SAFE_INTEGER) rev cannot wedge later same-second toggles", () => {
  // Carl P2 / Thufir off-by-one regression. A malformed blob carries a
  // same-second rev of exactly Number.MAX_SAFE_INTEGER on a `starred:true`
  // entry — the largest value the pre-fix `Number.isSafeInteger` guard still
  // ACCEPTED. Had it survived, the click path (`rev = max(seen) + 1`) would
  // mint Number.MAX_SAFE_INTEGER + 1, an unsafe integer that never advances,
  // so the true entry would win every same-second tie forever. The parser now
  // rejects `rev >= Number.MAX_SAFE_INTEGER` (exclusive), normalizing it to 0
  // and preserving headroom for `maxRev + 1`. Drive the production mint
  // (`Math.max(localRev, maxRevSeen) + 1`) through alternating same-second
  // toggles and assert each later toggle mints a strictly-advancing rev and wins.
  const wedged = parseStarPayload({
    version: 1,
    channels: {
      c: { starred: true, updatedAt: 100, rev: Number.MAX_SAFE_INTEGER },
    },
  });
  assert.equal(wedged.channels.c.rev, 0, "boundary rev is normalized to 0");

  // Production mint: same fixed second (100), rev = max(local, seen) + 1.
  const mint = (store, starred) => {
    const local = store.channels.c;
    const rev = Math.max(local?.rev ?? 0, 0) + 1;
    return { store: S(E(starred, 100, rev)), rev };
  };

  let state = wedged;
  let prevRev = state.channels.c.rev; // 0
  for (const starred of [false, true, false, true]) {
    const { store: click, rev } = mint(state, starred);
    assert.ok(
      rev > prevRev,
      `mint rev ${rev} strictly advances past ${prevRev}`,
    );
    state = mergeStores(state, click);
    assert.deepEqual(
      state.channels.c,
      E(starred, 100, rev),
      `same-second toggle to ${starred} (rev ${rev}) wins — no wedge`,
    );
    prevRev = rev;
  }
});

test("mergeStores: unstar with higher updatedAt overrides star", () => {
  const result = mergeStores(S(E(true, 100, 9)), S(E(false, 999, 1)));
  assert.deepEqual(result.channels.c, E(false, 999, 1));
});

test("mergeStores: empty local / empty remote / both empty", () => {
  assert.deepEqual(
    mergeStores({ version: 1, channels: {} }, S(E(true, 42, 1))).channels.c,
    E(true, 42, 1),
  );
  assert.deepEqual(
    mergeStores(S(E(false, 10, 2)), { version: 1, channels: {} }).channels.c,
    E(false, 10, 2),
  );
  assert.deepEqual(
    mergeStores({ version: 1, channels: {} }, { version: 1, channels: {} }),
    { version: 1, channels: {} },
  );
});

// ── mergeStores: algebra (commutativity, associativity, idempotence) ──────────

function randEntry(rng) {
  return {
    starred: rng() > 0.5,
    updatedAt: Math.floor(rng() * 5),
    rev: Math.floor(rng() * 5),
  };
}
function randStore(rng, ids) {
  const channels = {};
  for (const id of ids) if (rng() > 0.3) channels[id] = randEntry(rng);
  return { version: 1, channels };
}
// Deterministic LCG so failures reproduce.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test("mergeStores: commutative — merge(a,b) === merge(b,a)", () => {
  const rng = lcg(12345);
  const ids = ["a", "b", "c", "d"];
  for (let i = 0; i < 200; i++) {
    const a = randStore(rng, ids);
    const b = randStore(rng, ids);
    assert.deepEqual(mergeStores(a, b), mergeStores(b, a));
  }
});

test("mergeStores: associative — merge(merge(a,b),c) === merge(a,merge(b,c))", () => {
  const rng = lcg(67890);
  const ids = ["a", "b", "c", "d"];
  for (let i = 0; i < 200; i++) {
    const a = randStore(rng, ids);
    const b = randStore(rng, ids);
    const c = randStore(rng, ids);
    assert.deepEqual(
      mergeStores(mergeStores(a, b), c),
      mergeStores(a, mergeStores(b, c)),
    );
  }
});

test("mergeStores: idempotent — merge(a, merge(a,b)) === merge(a,b)", () => {
  const rng = lcg(24680);
  const ids = ["a", "b", "c", "d"];
  for (let i = 0; i < 200; i++) {
    const a = randStore(rng, ids);
    const b = randStore(rng, ids);
    const ab = mergeStores(a, b);
    assert.deepEqual(mergeStores(a, ab), ab);
    assert.deepEqual(mergeStores(ab, ab), ab);
  }
});

// ── v1-blob bidirectional compatibility ───────────────────────────────────────

test("v1 compat: a rev-carrying blob round-trips through a rev-less parser view", () => {
  // Simulate an old build reading our blob: JSON-serialize our rev-carrying
  // payload, parse it back — version stays 1 so it is NOT rejected, and the
  // core fields survive (old build simply ignores rev).
  const ours = {
    version: 1,
    channels: { c: { starred: true, updatedAt: 100, rev: 7 } },
  };
  const roundTripped = parseStarPayload(JSON.parse(JSON.stringify(ours)));
  assert.equal(roundTripped.version, 1, "version stays 1 — old build accepts");
  assert.equal(roundTripped.channels.c.starred, true);
  assert.equal(roundTripped.channels.c.updatedAt, 100);
});

test("v1 compat: old-build unstar (no rev, updatedAt+1) beats our stale star", () => {
  // New build wrote {starred:true, rev:7, updatedAt:t}; old build (no rev)
  // unstars producing {starred:false, updatedAt:t+1}. The unstar wins on the
  // primary updatedAt key — old builds can still edit upgraded channels.
  const ours = S(E(true, 100, 7));
  const oldBuildUnstar = parseStarPayload({
    version: 1,
    channels: { c: { starred: false, updatedAt: 101 } },
  });
  assert.deepEqual(mergeStores(ours, oldBuildUnstar).channels.c, {
    starred: false,
    updatedAt: 101,
    rev: 0,
  });
});

// ── boundStarStore ────────────────────────────────────────────────────────────

test("boundStarStore: retains newest entries regardless of starred value", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_STAR_ENTRIES }, (_, i) => [
      `active-${i}`,
      E(true, i + 1, 0),
    ]),
  );
  channels["old-false"] = E(false, 0, 0);
  channels["new-false"] = E(false, 9999, 0);
  const result = boundStarStore({ version: 1, channels });
  assert.equal(Object.keys(result.channels).length, MAX_CHANNEL_STAR_ENTRIES);
  assert.equal(result.channels["old-false"], undefined);
  assert.deepEqual(result.channels["new-false"], E(false, 9999, 0));
  assert.equal(result.channels["active-0"], undefined);
});

test("boundStarStore: uses channel ID as an updatedAt tie-breaker", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_STAR_ENTRIES + 1 }, (_, i) => [
      `channel-${String(MAX_CHANNEL_STAR_ENTRIES - i).padStart(3, "0")}`,
      E(true, 1, 0),
    ]),
  );
  const result = boundStarStore({ version: 1, channels });
  assert.equal(result.channels["channel-000"], undefined);
  assert.deepEqual(result.channels["channel-500"], E(true, 1, 0));
});

test("boundStarStore: preserves a same-second mutation by key", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_STAR_ENTRIES }, (_, i) => [
      `z-channel-${String(i).padStart(3, "0")}`,
      E(true, 1, 0),
    ]),
  );
  channels["a-target"] = E(false, 1, 1);
  const result = boundStarStore({ version: 1, channels }, "a-target");
  assert.equal(Object.keys(result.channels).length, MAX_CHANNEL_STAR_ENTRIES);
  assert.deepEqual(result.channels["a-target"], E(false, 1, 1));
  assert.equal(result.channels["z-channel-000"], undefined);
});

test("mergeStores: a fresh at-capacity unstar defeats an older remote star", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_STAR_ENTRIES }, (_, i) => [
      `active-${i}`,
      E(true, i + 1, 0),
    ]),
  );
  channels.unstarred = E(false, 9999, 1);
  const bounded = boundStarStore({ version: 1, channels });
  const result = mergeStores(bounded, {
    version: 1,
    channels: { unstarred: E(true, 9998, 5) },
  });
  assert.deepEqual(result.channels.unstarred, E(false, 9999, 1));
});

test("mergeStores: evicted remote ID re-enters and the oldest state is re-trimmed", () => {
  const localChannels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_STAR_ENTRIES }, (_, i) => [
      `active-${i}`,
      E(true, i + 10, 0),
    ]),
  );
  const result = mergeStores(
    { version: 1, channels: localChannels },
    {
      version: 1,
      channels: {
        "evicted-id": E(true, 9999, 0),
        "active-0": E(false, 9998, 0),
      },
    },
  );
  assert.equal(Object.keys(result.channels).length, MAX_CHANNEL_STAR_ENTRIES);
  assert.deepEqual(result.channels["evicted-id"], E(true, 9999, 0));
  assert.deepEqual(result.channels["active-0"], E(false, 9998, 0));
  assert.equal(result.channels["active-1"], undefined);
});

// ── Eviction / remount (finding 3) ────────────────────────────────────────────

// Easy branch: X evicted at an OLDER second → remount (high-water lost) → click
// X at the current second → merge a remote carrying X at a high rev but an old
// updatedAt. The click's newer updatedAt wins on the primary key; the lost rev
// high-water is irrelevant. Closed by construction for all cross-second cases.
test("finding 3 easy branch: a fresh click beats an evicted high-rev entry at an older updatedAt", () => {
  // Remount state: the user clicks X fresh at updatedAt=now, empty high-water
  // (evicted), so rev mints to 1.
  const click = S(E(true, 1000, 1));
  // The previously observed remote X sits at an OLD updatedAt with a high rev.
  const remote = S(E(false, 500, 100));
  const merged = mergeStores(click, remote);
  assert.deepEqual(
    merged.channels.c,
    E(true, 1000, 1),
    "fresh click wins on the primary updatedAt key",
  );
});

// Hard branch (Thufir's exact equal-second counterexample): >500 entries all at
// the CURRENT second → X evicted by the id tiebreak (not because it is old) →
// remount in the same second → click X at rev 1 (empty high-water) → merge the
// previously observed remote X at rev 100, EQUAL updatedAt. updatedAt ties, rev
// decides, 100 > 1 — the click LOSES. Documented deterministic residual, proven
// here as the hard branch (not disguised as safety).
test("finding 3 hard branch: equal-second evicted click (rev 1) loses to observed remote (rev 100)", () => {
  const NOW = 777;
  const TARGET = "aaa-target"; // lexicographically small → evicted by the id tiebreak

  // >500 entries all at the CURRENT second (NOW). With MAX+1 equal-updatedAt
  // entries, boundStarStore sorts ascending by (updatedAt, id) and keeps the
  // highest MAX, so the lowest id is evicted — TARGET, NOT because it is old.
  const channels = { [TARGET]: E(true, NOW, 7) };
  for (let i = 0; i < MAX_CHANNEL_STAR_ENTRIES; i++) {
    channels[`z-${String(i).padStart(3, "0")}`] = E(true, NOW, 0);
  }
  const bounded = boundStarStore({ version: 1, channels });
  assert.equal(
    Object.keys(bounded.channels).length,
    MAX_CHANNEL_STAR_ENTRIES,
    "bound trims to the cap",
  );
  assert.equal(
    bounded.channels[TARGET],
    undefined,
    "TARGET evicted by the id tiebreak at equal updatedAt",
  );

  // Remount in the same second: TARGET's rev high-water is gone with the entry,
  // so a fresh click mints rev 1 at updatedAt=NOW.
  const click = { version: 1, channels: { [TARGET]: E(true, NOW, 1) } };
  // The previously observed remote for TARGET at the same second, rev 100 (it
  // may precede the remount — not genuinely concurrent).
  const remote = { version: 1, channels: { [TARGET]: E(false, NOW, 100) } };

  // equal updatedAt → rev decides → 100 > 1: the click LOSES. Documented
  // deterministic residual, proven here through real eviction+remount, not a
  // pre-shrunk tuple. Deterministic in both merge orders — a lost click, never
  // a divergence.
  assert.deepEqual(
    mergeStores(click, remote).channels[TARGET],
    E(false, NOW, 100),
    "equal updatedAt → higher rev wins deterministically (documented residual)",
  );
  assert.deepEqual(
    mergeStores(remote, click).channels[TARGET],
    E(false, NOW, 100),
  );
});

// ── starredChannelIdsFromStore ────────────────────────────────────────────────

test("starredChannelIdsFromStore: returns set of IDs where starred=true", () => {
  const result = starredChannelIdsFromStore({
    version: 1,
    channels: {
      a: E(true, 100, 0),
      b: E(true, 200, 0),
      c: E(false, 300, 0),
    },
  });
  assert.deepEqual([...result].sort(), ["a", "b"]);
});

test("starredChannelIdsFromStore: all-false / empty returns empty set", () => {
  assert.equal(
    starredChannelIdsFromStore({
      version: 1,
      channels: { x: E(false, 1, 0) },
    }).size,
    0,
  );
  assert.equal(
    starredChannelIdsFromStore({ version: 1, channels: {} }).size,
    0,
  );
});

// ─── Relay-scoped key + one-time legacy migration (Carl r6 P1) ────────────────
// The primary star cache was pubkey-only keyed, so a non-empty store from relay
// A could seed-publish onto a first-visited relay B. Scoping the key per relay
// and migrating the legacy key exactly once (then deleting it) closes that leak.

const STAR_E = (starred, updatedAt, rev) => ({ starred, updatedAt, rev });

test("storageKey: with relayUrl includes normalized+encoded relay in key", () => {
  const relay = "wss://relay.example.com";
  assert.equal(
    storageKey("pk1", relay),
    `buzz-channel-stars.v1:pk1:${encodeURIComponent(normalizeRelayUrl(relay))}`,
  );
});

test("storageKey: without relayUrl returns legacy pubkey-only key", () => {
  assert.equal(storageKey("pk1"), "buzz-channel-stars.v1:pk1");
  assert.equal(storageKey("pk1", undefined), "buzz-channel-stars.v1:pk1");
});

test("storageKey: two different relays produce different keys for same pubkey", () => {
  assert.notEqual(
    storageKey("pk1", "wss://relay-a.example.com"),
    storageKey("pk1", "wss://relay-b.example.com"),
  );
});

test("storageKey: equivalent relay URLs (case + trailing slash) map to the same key", () => {
  assert.equal(
    storageKey("pk1", "WSS://Relay.Example/"),
    storageKey("pk1", "wss://relay.example"),
  );
});

test("readChannelStarsStore + writeChannelStarsStore: scoped write/read roundtrip", () => {
  const pubkey = "pk-star-roundtrip";
  const relay = "wss://relay.example.com";
  const store = makeStarStore({ chan1: STAR_E(true, 1000, 1) });
  assert.ok(writeChannelStarsStore(pubkey, store, relay) !== null);
  assert.deepEqual(readChannelStarsStore(pubkey, relay), store);
});

test("readChannelStarsStore: scoped key is isolated from other relay's data (A→B no seed leak)", () => {
  const pubkey = "pk-star-isolation";
  const relayA = "wss://relay-a.example.com";
  const relayB = "wss://relay-b.example.com";
  writeChannelStarsStore(
    pubkey,
    makeStarStore({ cha: STAR_E(true, 100, 1) }),
    relayA,
  );
  // Relay B sees an empty store — relay A's stars must not seed onto B.
  assert.deepEqual(readChannelStarsStore(pubkey, relayB), DEFAULT_STORE);
});

test("readChannelStarsStore: migrates legacy unscoped data on first scoped read", () => {
  const pubkey = "pk-star-migrate";
  const relay = "wss://relay-migrate.example.com";
  const legacy = makeStarStore({ chl: STAR_E(true, 500, 2) });
  writeChannelStarsStore(pubkey, legacy); // legacy pubkey-only key
  assert.deepEqual(readChannelStarsStore(pubkey, relay), legacy);
  // Legacy key deleted after migration (globally one-time guarantee).
  assert.equal(window.localStorage.getItem(storageKey(pubkey)), null);
  // Subsequent scoped reads hit the scoped key directly.
  assert.deepEqual(readChannelStarsStore(pubkey, relay), legacy);
});

test("readChannelStarsStore: migration is globally one-time — relay B sees DEFAULT_STORE after relay A migrates", () => {
  const pubkey = "pk-star-migrate-once";
  const relayA = "wss://relay-a-once.example.com";
  const relayB = "wss://relay-b-once.example.com";
  writeChannelStarsStore(pubkey, makeStarStore({ chm: STAR_E(true, 1, 1) }));
  readChannelStarsStore(pubkey, relayA); // migrates + deletes legacy key
  // Relay B must not inherit relay A's migrated stars.
  assert.deepEqual(readChannelStarsStore(pubkey, relayB), DEFAULT_STORE);
  assert.equal(window.localStorage.getItem(storageKey(pubkey, relayB)), null);
});

test("readChannelStarsStore: migration only copies non-empty legacy stores", () => {
  const pubkey = "pk-star-migrate-empty";
  const relay = "wss://relay-empty.example.com";
  writeChannelStarsStore(pubkey, DEFAULT_STORE); // empty legacy store
  assert.deepEqual(readChannelStarsStore(pubkey, relay), DEFAULT_STORE);
  // An empty legacy store is not consumed, so it is not deleted either.
  assert.notEqual(window.localStorage.getItem(storageKey(pubkey)), null);
});

test("readChannelStarsStore: scoped key takes precedence over legacy key", () => {
  const pubkey = "pk-star-precedence";
  const relay = "wss://relay-precedence.example.com";
  writeChannelStarsStore(pubkey, makeStarStore({ old: STAR_E(true, 1, 1) }));
  const scoped = makeStarStore({ new: STAR_E(true, 2, 1) });
  writeChannelStarsStore(pubkey, scoped, relay);
  assert.deepEqual(readChannelStarsStore(pubkey, relay), scoped);
});

// Migration failure safety (Thufir r6 IMPORTANT): legacy data must be exposed
// to bootstrap ONLY once the legacy key is provably gone. If the scoped write
// throws, or the legacy delete does not take, the reader must roll back and
// return DEFAULT_STORE so no relay publishes legacy prefs while the legacy key
// still holds them (which would let a second relay import the same value).

test("readChannelStarsStore: scoped-write failure returns DEFAULT and leaves neither relay able to seed the legacy value", () => {
  const pubkey = "pk-star-migrate-writefail";
  const relayA = "wss://relay-a-writefail.example.com";
  const relayB = "wss://relay-b-writefail.example.com";
  const legacy = makeStarStore({ chw: STAR_E(true, 500, 2) });
  writeChannelStarsStore(pubkey, legacy);
  const scopedA = storageKey(pubkey, relayA);
  const origSet = window.localStorage.setItem;
  window.localStorage.setItem = (k, v) => {
    if (k === scopedA) throw new Error("QuotaExceededError");
    return origSet.call(window.localStorage, k, v);
  };
  try {
    // Relay A cannot claim the legacy value — it must NOT be exposed to publish.
    assert.deepEqual(readChannelStarsStore(pubkey, relayA), DEFAULT_STORE);
    // Rolled back: no partial scoped copy left behind for A.
    assert.equal(window.localStorage.getItem(scopedA), null);
  } finally {
    window.localStorage.setItem = origSet;
  }
  // Legacy key survived (migration is retryable), and relay B likewise cannot
  // be seeded — the value is claimed by whichever relay first deletes it.
  assert.notEqual(window.localStorage.getItem(storageKey(pubkey)), null);
  assert.deepEqual(readChannelStarsStore(pubkey, relayB), legacy);
  // Once B claims it, the legacy key is gone and A can no longer seed.
  assert.equal(window.localStorage.getItem(storageKey(pubkey)), null);
  assert.deepEqual(readChannelStarsStore(pubkey, relayA), DEFAULT_STORE);
});

test("readChannelStarsStore: a legacy delete that does not take rolls back and returns DEFAULT", () => {
  const pubkey = "pk-star-migrate-delfail";
  const relay = "wss://relay-delfail.example.com";
  const legacy = makeStarStore({ chd: STAR_E(true, 700, 3) });
  writeChannelStarsStore(pubkey, legacy);
  const legacyKey = storageKey(pubkey);
  const scoped = storageKey(pubkey, relay);
  const origRemove = window.localStorage.removeItem;
  window.localStorage.removeItem = (k) => {
    if (k === legacyKey) return; // silently no-op: delete "does not take"
    return origRemove.call(window.localStorage, k);
  };
  try {
    assert.deepEqual(readChannelStarsStore(pubkey, relay), DEFAULT_STORE);
    // Partial scoped copy rolled back so the migration stays retryable.
    assert.equal(window.localStorage.getItem(scoped), null);
  } finally {
    window.localStorage.removeItem = origRemove;
  }
  // With the delete working again, the migration completes cleanly.
  assert.deepEqual(readChannelStarsStore(pubkey, relay), legacy);
  assert.equal(window.localStorage.getItem(legacyKey), null);
});

test("readChannelStarsStore: legacy delete + rollback both throw — every read returns DEFAULT until storage recovers, never seeds", () => {
  const pubkey = "pk-star-migrate-delrollbackthrow";
  const relay = "wss://relay-delrollbackthrow.example.com";
  const legacy = makeStarStore({ chr: STAR_E(true, 900, 4) });
  writeChannelStarsStore(pubkey, legacy);
  const legacyKey = storageKey(pubkey);
  const scoped = storageKey(pubkey, relay);
  const origRemove = window.localStorage.removeItem;
  // removeItem throws globally: the legacy delete AND the scoped rollback both
  // throw, so a scoped copy the migration wrote survives on disk.
  window.localStorage.removeItem = () => {
    throw new Error("SecurityError");
  };
  try {
    // First read: scoped write took, legacy delete threw, rollback threw.
    assert.deepEqual(readChannelStarsStore(pubkey, relay), DEFAULT_STORE);
    // A stuck scoped copy survives, but the reader must NOT expose it while the
    // legacy key still holds importable data — the seam Thufir found.
    assert.deepEqual(readChannelStarsStore(pubkey, relay), DEFAULT_STORE);
    // Legacy key is intact, so the claim stays retryable rather than lost.
    assert.notEqual(window.localStorage.getItem(legacyKey), null);
  } finally {
    window.localStorage.removeItem = origRemove;
  }
  // Storage recovers: the next read finishes the claim from the stuck scoped
  // copy, deletes the legacy key, and only then exposes the value.
  assert.deepEqual(readChannelStarsStore(pubkey, relay), legacy);
  assert.equal(window.localStorage.getItem(legacyKey), null);
  assert.notEqual(window.localStorage.getItem(scoped), null);
});

test("readChannelStarsStore: legacy delete succeeds but the confirmation read throws — scoped copy retained, no data loss", () => {
  const pubkey = "pk-star-migrate-confirmthrow";
  const relay = "wss://relay-confirmthrow.example.com";
  const legacy = makeStarStore({ chc: STAR_E(true, 800, 3) });
  writeChannelStarsStore(pubkey, legacy);
  const legacyKey = storageKey(pubkey);
  const scoped = storageKey(pubkey, relay);
  const origGet = window.localStorage.getItem;
  const origRemove = window.localStorage.removeItem;
  let legacyDeleted = false;
  let threwOnce = false;
  window.localStorage.removeItem = (k) => {
    if (k === legacyKey) legacyDeleted = true;
    return origRemove.call(window.localStorage, k);
  };
  // Only the post-delete confirmation read of the legacy key throws, once.
  window.localStorage.getItem = (k) => {
    if (k === legacyKey && legacyDeleted && !threwOnce) {
      threwOnce = true;
      throw new Error("SecurityError");
    }
    return origGet.call(window.localStorage, k);
  };
  try {
    // Legacy is already gone; the catch probe sees null and must NOT roll back
    // the scoped copy — it is the only surviving copy. First read is DEFAULT.
    assert.deepEqual(readChannelStarsStore(pubkey, relay), DEFAULT_STORE);
    assert.notEqual(window.localStorage.getItem(scoped), null);
  } finally {
    window.localStorage.getItem = origGet;
    window.localStorage.removeItem = origRemove;
  }
  // Legacy gone + scoped retained → the next healthy read exposes the value.
  assert.equal(window.localStorage.getItem(legacyKey), null);
  assert.deepEqual(readChannelStarsStore(pubkey, relay), legacy);
});

test("readChannelStarsStore: legacy delete throws while the probe stays healthy — scoped rollback, DEFAULT, single future claimant", () => {
  const pubkey = "pk-star-migrate-delthrow-probeok";
  const relay = "wss://relay-delthrow-probeok.example.com";
  const legacy = makeStarStore({ cht: STAR_E(true, 600, 2) });
  writeChannelStarsStore(pubkey, legacy);
  const legacyKey = storageKey(pubkey);
  const scoped = storageKey(pubkey, relay);
  const origRemove = window.localStorage.removeItem;
  let thrown = false;
  window.localStorage.removeItem = (k) => {
    if (k === legacyKey && !thrown) {
      thrown = true;
      throw new Error("SecurityError");
    }
    return origRemove.call(window.localStorage, k);
  };
  try {
    assert.deepEqual(readChannelStarsStore(pubkey, relay), DEFAULT_STORE);
    // Probe saw legacy still present → rolled back the just-written scoped copy
    // so a second relay scope cannot double-import the same legacy value.
    assert.equal(window.localStorage.getItem(scoped), null);
    assert.notEqual(window.localStorage.getItem(legacyKey), null);
  } finally {
    window.localStorage.removeItem = origRemove;
  }
  // Legacy survived, so exactly one future healthy read claims it.
  assert.deepEqual(readChannelStarsStore(pubkey, relay), legacy);
  assert.equal(window.localStorage.getItem(legacyKey), null);
});

test("readChannelStarsStore: legacy delete and the catch probe both throw — scoped kept but hidden while legacy remains", () => {
  const pubkey = "pk-star-migrate-delthrow-probethrow";
  const relay = "wss://relay-delthrow-probethrow.example.com";
  const legacy = makeStarStore({ chb: STAR_E(true, 500, 1) });
  writeChannelStarsStore(pubkey, legacy);
  const legacyKey = storageKey(pubkey);
  const scoped = storageKey(pubkey, relay);
  const origGet = window.localStorage.getItem;
  const origRemove = window.localStorage.removeItem;
  let removeAttempted = false;
  window.localStorage.removeItem = (k) => {
    if (k === legacyKey) {
      removeAttempted = true;
      throw new Error("SecurityError");
    }
    return origRemove.call(window.localStorage, k);
  };
  window.localStorage.getItem = (k) => {
    if (k === legacyKey && removeAttempted) throw new Error("SecurityError");
    return origGet.call(window.localStorage, k);
  };
  try {
    // Delete throws, then the catch probe throws too: legacy cannot be proven
    // gone, so we KEEP the scoped copy (no-data-loss residual).
    assert.deepEqual(readChannelStarsStore(pubkey, relay), DEFAULT_STORE);
    assert.notEqual(window.localStorage.getItem(scoped), null);
    // While legacy remains and storage is broken, every read returns DEFAULT.
    assert.deepEqual(readChannelStarsStore(pubkey, relay), DEFAULT_STORE);
  } finally {
    window.localStorage.getItem = origGet;
    window.localStorage.removeItem = origRemove;
  }
  // Storage recovers with legacy still present → the claim completes once.
  assert.deepEqual(readChannelStarsStore(pubkey, relay), legacy);
  assert.equal(window.localStorage.getItem(legacyKey), null);
});
