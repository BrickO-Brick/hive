import assert from "node:assert/strict";
import test from "node:test";

import {
  boundMuteStore,
  DEFAULT_STORE,
  MAX_CHANNEL_MUTE_ENTRIES,
  mergeStores,
  parseMutePayload,
  mutedChannelIdsFromStore,
  readChannelMutesStore,
  storageKey,
  writeChannelMutesStore,
} from "./channelMutesStorage.ts";
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

function makeMuteStore(channels = {}) {
  return { version: 1, channels };
}

// ── parseMutePayload ──────────────────────────────────────────────────────────

test("parseMutePayload: valid payload with channels returns store (rev preserved)", () => {
  const payload = {
    version: 1,
    channels: {
      "chan-1": { muted: true, updatedAt: 1000, rev: 3 },
      "chan-2": { muted: false, updatedAt: 2000, rev: 0 },
    },
  };
  assert.deepEqual(parseMutePayload(payload), payload);
});

test("parseMutePayload: missing rev normalizes to 0 (old-build blob, entry kept)", () => {
  const result = parseMutePayload({
    version: 1,
    channels: { "chan-1": { muted: true, updatedAt: 1000 } },
  });
  assert.deepEqual(result.channels["chan-1"], {
    muted: true,
    updatedAt: 1000,
    rev: 0,
  });
});

test("parseMutePayload: malformed rev (string / negative / non-integer / NaN / unsafe) normalizes to 0", () => {
  const result = parseMutePayload({
    version: 1,
    channels: {
      str: { muted: true, updatedAt: 1, rev: "5" },
      neg: { muted: true, updatedAt: 1, rev: -2 },
      frac: { muted: true, updatedAt: 1, rev: 1.5 },
      nan: { muted: true, updatedAt: 1, rev: NaN },
      // At or above Number.MAX_SAFE_INTEGER: `maxRev + 1` cannot advance past
      // Number.MAX_SAFE_INTEGER, so an entry at the boundary itself (or beyond)
      // would wedge later toggles forever unless rejected here (Carl P2 /
      // Thufir off-by-one). The bound is exclusive, so the boundary normalizes.
      boundary: { muted: true, updatedAt: 1, rev: Number.MAX_SAFE_INTEGER },
      huge: { muted: true, updatedAt: 1, rev: Number.MAX_SAFE_INTEGER + 1 },
    },
  });
  for (const id of ["str", "neg", "frac", "nan", "boundary", "huge"]) {
    assert.equal(result.channels[id].rev, 0, `${id} rev normalized to 0`);
    assert.equal(result.channels[id].muted, true, `${id} entry kept`);
  }
});

test("parseMutePayload: missing version returns null", () => {
  assert.equal(
    parseMutePayload({
      channels: { "chan-1": { muted: true, updatedAt: 1 } },
    }),
    null,
  );
});

test("parseMutePayload: wrong version returns null", () => {
  assert.equal(
    parseMutePayload({
      version: 2,
      channels: { "chan-1": { muted: true, updatedAt: 1 } },
    }),
    null,
  );
});

test("parseMutePayload: null / non-object input returns null", () => {
  assert.equal(parseMutePayload(null), null);
  assert.equal(parseMutePayload("string"), null);
  assert.equal(parseMutePayload(42), null);
  assert.equal(parseMutePayload(true), null);
});

test("parseMutePayload: malformed channel entries missing muted/updatedAt are filtered out", () => {
  const result = parseMutePayload({
    version: 1,
    channels: {
      "no-muted": { updatedAt: 1000 },
      "no-updated-at": { muted: true },
      valid: { muted: false, updatedAt: 500 },
      "muted-wrong-type": { muted: "yes", updatedAt: 1000 },
      "updated-at-wrong-type": { muted: true, updatedAt: "now" },
      null: null,
    },
  });
  assert.deepEqual(result, {
    version: 1,
    channels: { valid: { muted: false, updatedAt: 500, rev: 0 } },
  });
});

test("parseMutePayload: NaN/Infinity/negative/unsafe updatedAt entries are filtered out", () => {
  const result = parseMutePayload({
    version: 1,
    channels: {
      nan: { muted: true, updatedAt: NaN },
      inf: { muted: true, updatedAt: Infinity },
      "neg-inf": { muted: true, updatedAt: -Infinity },
      neg: { muted: true, updatedAt: -1 },
      // Beyond Number.MAX_SAFE_INTEGER: an unrepresentable second is not a
      // trustworthy watermark, so the entry is dropped rather than kept (Carl
      // P2 — same bound as `rev`).
      unsafe: { muted: true, updatedAt: Number.MAX_SAFE_INTEGER + 1 },
      valid: { muted: true, updatedAt: 100, rev: 2 },
    },
  });
  assert.deepEqual(result, {
    version: 1,
    channels: { valid: { muted: true, updatedAt: 100, rev: 2 } },
  });
});

test("parseMutePayload: empty channels / no channels key returns empty store", () => {
  assert.deepEqual(parseMutePayload({ version: 1, channels: {} }), {
    version: 1,
    channels: {},
  });
  assert.deepEqual(parseMutePayload({ version: 1 }), {
    version: 1,
    channels: {},
  });
});

// ── mergeStores: tuple order (updatedAt → rev → value) ────────────────────────

const E = (muted, updatedAt, rev) => ({ muted, updatedAt, rev });
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

test("mergeStores: equal updatedAt AND equal rev → muted=true wins (leaf)", () => {
  const result = mergeStores(S(E(false, 100, 3)), S(E(true, 100, 3)));
  assert.deepEqual(result.channels.c, E(true, 100, 3));
});

test("mergeStores: same-second old-build click (rev 0) loses to an earlier new-build rev, heals next second", () => {
  // ACCEPTED MIXED-FLEET RESIDUAL (Carl P1 #5). A new build wrote {muted:true,
  // rev:2} at second 100; an old build then UNMUTES in the SAME second — old
  // builds mint no rev, so its click reads rev:0. It loses the same-second tie
  // to the earlier rev-2 entry: the later intent is suppressed until a
  // strictly-later second carries it on the primary updatedAt key. This pins the
  // current deterministic outcome; it is not a regression to fix here.
  const newBuildMute = S(E(true, 100, 2));
  const oldBuildUnmuteSameSecond = S(E(false, 100, 0));
  assert.deepEqual(
    mergeStores(newBuildMute, oldBuildUnmuteSameSecond).channels.c,
    E(true, 100, 2),
    "the earlier new-build rev-2 mute wins the same-second tie — old click's unmute is lost",
  );

  // The same old-build unmute one second later wins outright on updatedAt: the
  // residual self-heals the moment the user clicks again in a later second.
  const oldBuildUnmuteNextSecond = S(E(false, 101, 0));
  assert.deepEqual(
    mergeStores(newBuildMute, oldBuildUnmuteNextSecond).channels.c,
    E(false, 101, 0),
    "a strictly-later-second old-build unmute wins — the residual is transient",
  );
});

test("mergeStores: a boundary (MAX_SAFE_INTEGER) rev cannot wedge later same-second toggles", () => {
  // Carl P2 / Thufir off-by-one regression. A malformed blob carries a
  // same-second rev of exactly Number.MAX_SAFE_INTEGER on a `muted:true`
  // entry — the largest value the pre-fix `Number.isSafeInteger` guard still
  // ACCEPTED. Had it survived, the click path (`rev = max(seen) + 1`) would
  // mint Number.MAX_SAFE_INTEGER + 1, an unsafe integer that never advances,
  // so the true entry would win every same-second tie forever. The parser now
  // rejects `rev >= Number.MAX_SAFE_INTEGER` (exclusive), normalizing it to 0
  // and preserving headroom for `maxRev + 1`. Drive the production mint
  // (`Math.max(localRev, maxRevSeen) + 1`) through alternating same-second
  // toggles and assert each later toggle mints a strictly-advancing rev and wins.
  const wedged = parseMutePayload({
    version: 1,
    channels: {
      c: { muted: true, updatedAt: 100, rev: Number.MAX_SAFE_INTEGER },
    },
  });
  assert.equal(wedged.channels.c.rev, 0, "boundary rev is normalized to 0");

  // Production mint: same fixed second (100), rev = max(local, seen) + 1.
  const mint = (store, muted) => {
    const local = store.channels.c;
    const rev = Math.max(local?.rev ?? 0, 0) + 1;
    return { store: S(E(muted, 100, rev)), rev };
  };

  let state = wedged;
  let prevRev = state.channels.c.rev; // 0
  for (const muted of [false, true, false, true]) {
    const { store: click, rev } = mint(state, muted);
    assert.ok(
      rev > prevRev,
      `mint rev ${rev} strictly advances past ${prevRev}`,
    );
    state = mergeStores(state, click);
    assert.deepEqual(
      state.channels.c,
      E(muted, 100, rev),
      `same-second toggle to ${muted} (rev ${rev}) wins — no wedge`,
    );
    prevRev = rev;
  }
});

test("mergeStores: unmute with higher updatedAt overrides mute", () => {
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
    muted: rng() > 0.5,
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
    channels: { c: { muted: true, updatedAt: 100, rev: 7 } },
  };
  const roundTripped = parseMutePayload(JSON.parse(JSON.stringify(ours)));
  assert.equal(roundTripped.version, 1, "version stays 1 — old build accepts");
  assert.equal(roundTripped.channels.c.muted, true);
  assert.equal(roundTripped.channels.c.updatedAt, 100);
});

test("v1 compat: old-build unmute (no rev, updatedAt+1) beats our stale mute", () => {
  // New build wrote {muted:true, rev:7, updatedAt:t}; old build (no rev)
  // unmutes producing {muted:false, updatedAt:t+1}. The unmute wins on the
  // primary updatedAt key — old builds can still edit upgraded channels.
  const ours = S(E(true, 100, 7));
  const oldBuildUnmute = parseMutePayload({
    version: 1,
    channels: { c: { muted: false, updatedAt: 101 } },
  });
  assert.deepEqual(mergeStores(ours, oldBuildUnmute).channels.c, {
    muted: false,
    updatedAt: 101,
    rev: 0,
  });
});

// ── boundMuteStore ────────────────────────────────────────────────────────────

test("boundMuteStore: retains newest entries regardless of muted value", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_MUTE_ENTRIES }, (_, i) => [
      `active-${i}`,
      E(true, i + 1, 0),
    ]),
  );
  channels["old-false"] = E(false, 0, 0);
  channels["new-false"] = E(false, 9999, 0);
  const result = boundMuteStore({ version: 1, channels });
  assert.equal(Object.keys(result.channels).length, MAX_CHANNEL_MUTE_ENTRIES);
  assert.equal(result.channels["old-false"], undefined);
  assert.deepEqual(result.channels["new-false"], E(false, 9999, 0));
  assert.equal(result.channels["active-0"], undefined);
});

test("boundMuteStore: uses channel ID as an updatedAt tie-breaker", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_MUTE_ENTRIES + 1 }, (_, i) => [
      `channel-${String(MAX_CHANNEL_MUTE_ENTRIES - i).padStart(3, "0")}`,
      E(true, 1, 0),
    ]),
  );
  const result = boundMuteStore({ version: 1, channels });
  assert.equal(result.channels["channel-000"], undefined);
  assert.deepEqual(result.channels["channel-500"], E(true, 1, 0));
});

test("boundMuteStore: preserves a same-second mutation by key", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_MUTE_ENTRIES }, (_, i) => [
      `z-channel-${String(i).padStart(3, "0")}`,
      E(true, 1, 0),
    ]),
  );
  channels["a-target"] = E(false, 1, 1);
  const result = boundMuteStore({ version: 1, channels }, "a-target");
  assert.equal(Object.keys(result.channels).length, MAX_CHANNEL_MUTE_ENTRIES);
  assert.deepEqual(result.channels["a-target"], E(false, 1, 1));
  assert.equal(result.channels["z-channel-000"], undefined);
});

test("mergeStores: a fresh at-capacity unmute defeats an older remote mute", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_MUTE_ENTRIES }, (_, i) => [
      `active-${i}`,
      E(true, i + 1, 0),
    ]),
  );
  channels.unmuted = E(false, 9999, 1);
  const bounded = boundMuteStore({ version: 1, channels });
  const result = mergeStores(bounded, {
    version: 1,
    channels: { unmuted: E(true, 9998, 5) },
  });
  assert.deepEqual(result.channels.unmuted, E(false, 9999, 1));
});

test("mergeStores: evicted remote ID re-enters and the oldest state is re-trimmed", () => {
  const localChannels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_MUTE_ENTRIES }, (_, i) => [
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
  assert.equal(Object.keys(result.channels).length, MAX_CHANNEL_MUTE_ENTRIES);
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
  // entries, boundMuteStore sorts ascending by (updatedAt, id) and keeps the
  // highest MAX, so the lowest id is evicted — TARGET, NOT because it is old.
  const channels = { [TARGET]: E(true, NOW, 7) };
  for (let i = 0; i < MAX_CHANNEL_MUTE_ENTRIES; i++) {
    channels[`z-${String(i).padStart(3, "0")}`] = E(true, NOW, 0);
  }
  const bounded = boundMuteStore({ version: 1, channels });
  assert.equal(
    Object.keys(bounded.channels).length,
    MAX_CHANNEL_MUTE_ENTRIES,
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

// ── mutedChannelIdsFromStore ────────────────────────────────────────────────

test("mutedChannelIdsFromStore: returns set of IDs where muted=true", () => {
  const result = mutedChannelIdsFromStore({
    version: 1,
    channels: {
      a: E(true, 100, 0),
      b: E(true, 200, 0),
      c: E(false, 300, 0),
    },
  });
  assert.deepEqual([...result].sort(), ["a", "b"]);
});

test("mutedChannelIdsFromStore: all-false / empty returns empty set", () => {
  assert.equal(
    mutedChannelIdsFromStore({
      version: 1,
      channels: { x: E(false, 1, 0) },
    }).size,
    0,
  );
  assert.equal(mutedChannelIdsFromStore({ version: 1, channels: {} }).size, 0);
});

// ─── Relay-scoped key + one-time legacy migration (Carl r6 P1) ────────────────
// The primary mute cache was pubkey-only keyed, so a non-empty store from relay
// A could seed-publish onto a first-visited relay B. Scoping the key per relay
// and migrating the legacy key exactly once (then deleting it) closes that leak.

const MUTE_E = (muted, updatedAt, rev) => ({ muted, updatedAt, rev });

test("storageKey: with relayUrl includes normalized+encoded relay in key", () => {
  const relay = "wss://relay.example.com";
  assert.equal(
    storageKey("pk1", relay),
    `buzz-channel-mutes.v1:pk1:${encodeURIComponent(normalizeRelayUrl(relay))}`,
  );
});

test("storageKey: without relayUrl returns legacy pubkey-only key", () => {
  assert.equal(storageKey("pk1"), "buzz-channel-mutes.v1:pk1");
  assert.equal(storageKey("pk1", undefined), "buzz-channel-mutes.v1:pk1");
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

test("readChannelMutesStore + writeChannelMutesStore: scoped write/read roundtrip", () => {
  const pubkey = "pk-mute-roundtrip";
  const relay = "wss://relay.example.com";
  const store = makeMuteStore({ chan1: MUTE_E(true, 1000, 1) });
  assert.ok(writeChannelMutesStore(pubkey, store, relay) !== null);
  assert.deepEqual(readChannelMutesStore(pubkey, relay), store);
});

test("readChannelMutesStore: scoped key is isolated from other relay's data (A→B no seed leak)", () => {
  const pubkey = "pk-mute-isolation";
  const relayA = "wss://relay-a.example.com";
  const relayB = "wss://relay-b.example.com";
  writeChannelMutesStore(
    pubkey,
    makeMuteStore({ cha: MUTE_E(true, 100, 1) }),
    relayA,
  );
  // Relay B sees an empty store — relay A's mutes must not seed onto B.
  assert.deepEqual(readChannelMutesStore(pubkey, relayB), DEFAULT_STORE);
});

test("readChannelMutesStore: migrates legacy unscoped data on first scoped read", () => {
  const pubkey = "pk-mute-migrate";
  const relay = "wss://relay-migrate.example.com";
  const legacy = makeMuteStore({ chl: MUTE_E(true, 500, 2) });
  writeChannelMutesStore(pubkey, legacy); // legacy pubkey-only key
  assert.deepEqual(readChannelMutesStore(pubkey, relay), legacy);
  // Legacy key deleted after migration (globally one-time guarantee).
  assert.equal(window.localStorage.getItem(storageKey(pubkey)), null);
  // Subsequent scoped reads hit the scoped key directly.
  assert.deepEqual(readChannelMutesStore(pubkey, relay), legacy);
});

test("readChannelMutesStore: migration is globally one-time — relay B sees DEFAULT_STORE after relay A migrates", () => {
  const pubkey = "pk-mute-migrate-once";
  const relayA = "wss://relay-a-once.example.com";
  const relayB = "wss://relay-b-once.example.com";
  writeChannelMutesStore(pubkey, makeMuteStore({ chm: MUTE_E(true, 1, 1) }));
  readChannelMutesStore(pubkey, relayA); // migrates + deletes legacy key
  // Relay B must not inherit relay A's migrated mutes.
  assert.deepEqual(readChannelMutesStore(pubkey, relayB), DEFAULT_STORE);
  assert.equal(window.localStorage.getItem(storageKey(pubkey, relayB)), null);
});

test("readChannelMutesStore: migration only copies non-empty legacy stores", () => {
  const pubkey = "pk-mute-migrate-empty";
  const relay = "wss://relay-empty.example.com";
  writeChannelMutesStore(pubkey, DEFAULT_STORE); // empty legacy store
  assert.deepEqual(readChannelMutesStore(pubkey, relay), DEFAULT_STORE);
  // An empty legacy store is not consumed, so it is not deleted either.
  assert.notEqual(window.localStorage.getItem(storageKey(pubkey)), null);
});

test("readChannelMutesStore: scoped key takes precedence over legacy key", () => {
  const pubkey = "pk-mute-precedence";
  const relay = "wss://relay-precedence.example.com";
  writeChannelMutesStore(pubkey, makeMuteStore({ old: MUTE_E(true, 1, 1) }));
  const scoped = makeMuteStore({ new: MUTE_E(true, 2, 1) });
  writeChannelMutesStore(pubkey, scoped, relay);
  assert.deepEqual(readChannelMutesStore(pubkey, relay), scoped);
});

// Migration failure safety (Thufir r6 IMPORTANT): legacy data must be exposed
// to bootstrap ONLY once the legacy key is provably gone. If the scoped write
// throws, or the legacy delete does not take, the reader must roll back and
// return DEFAULT_STORE so no relay publishes legacy prefs while the legacy key
// still holds them (which would let a second relay import the same value).

test("readChannelMutesStore: scoped-write failure returns DEFAULT and leaves neither relay able to seed the legacy value", () => {
  const pubkey = "pk-mute-migrate-writefail";
  const relayA = "wss://relay-a-writefail.example.com";
  const relayB = "wss://relay-b-writefail.example.com";
  const legacy = makeMuteStore({ chw: MUTE_E(true, 500, 2) });
  writeChannelMutesStore(pubkey, legacy);
  const scopedA = storageKey(pubkey, relayA);
  const origSet = window.localStorage.setItem;
  window.localStorage.setItem = (k, v) => {
    if (k === scopedA) throw new Error("QuotaExceededError");
    return origSet.call(window.localStorage, k, v);
  };
  try {
    // Relay A cannot claim the legacy value — it must NOT be exposed to publish.
    assert.deepEqual(readChannelMutesStore(pubkey, relayA), DEFAULT_STORE);
    // Rolled back: no partial scoped copy left behind for A.
    assert.equal(window.localStorage.getItem(scopedA), null);
  } finally {
    window.localStorage.setItem = origSet;
  }
  // Legacy key survived (migration is retryable), and relay B likewise cannot
  // be seeded — the value is claimed by whichever relay first deletes it.
  assert.notEqual(window.localStorage.getItem(storageKey(pubkey)), null);
  assert.deepEqual(readChannelMutesStore(pubkey, relayB), legacy);
  // Once B claims it, the legacy key is gone and A can no longer seed.
  assert.equal(window.localStorage.getItem(storageKey(pubkey)), null);
  assert.deepEqual(readChannelMutesStore(pubkey, relayA), DEFAULT_STORE);
});

test("readChannelMutesStore: a legacy delete that does not take rolls back and returns DEFAULT", () => {
  const pubkey = "pk-mute-migrate-delfail";
  const relay = "wss://relay-delfail.example.com";
  const legacy = makeMuteStore({ chd: MUTE_E(true, 700, 3) });
  writeChannelMutesStore(pubkey, legacy);
  const legacyKey = storageKey(pubkey);
  const scoped = storageKey(pubkey, relay);
  const origRemove = window.localStorage.removeItem;
  window.localStorage.removeItem = (k) => {
    if (k === legacyKey) return; // silently no-op: delete "does not take"
    return origRemove.call(window.localStorage, k);
  };
  try {
    assert.deepEqual(readChannelMutesStore(pubkey, relay), DEFAULT_STORE);
    // Partial scoped copy rolled back so the migration stays retryable.
    assert.equal(window.localStorage.getItem(scoped), null);
  } finally {
    window.localStorage.removeItem = origRemove;
  }
  // With the delete working again, the migration completes cleanly.
  assert.deepEqual(readChannelMutesStore(pubkey, relay), legacy);
  assert.equal(window.localStorage.getItem(legacyKey), null);
});

test("readChannelMutesStore: legacy delete + rollback both throw — every read returns DEFAULT until storage recovers, never seeds", () => {
  const pubkey = "pk-mute-migrate-delrollbackthrow";
  const relay = "wss://relay-delrollbackthrow.example.com";
  const legacy = makeMuteStore({ chr: MUTE_E(true, 900, 4) });
  writeChannelMutesStore(pubkey, legacy);
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
    assert.deepEqual(readChannelMutesStore(pubkey, relay), DEFAULT_STORE);
    // A stuck scoped copy survives, but the reader must NOT expose it while the
    // legacy key still holds importable data — the seam Thufir found.
    assert.deepEqual(readChannelMutesStore(pubkey, relay), DEFAULT_STORE);
    // Legacy key is intact, so the claim stays retryable rather than lost.
    assert.notEqual(window.localStorage.getItem(legacyKey), null);
  } finally {
    window.localStorage.removeItem = origRemove;
  }
  // Storage recovers: the next read finishes the claim from the stuck scoped
  // copy, deletes the legacy key, and only then exposes the value.
  assert.deepEqual(readChannelMutesStore(pubkey, relay), legacy);
  assert.equal(window.localStorage.getItem(legacyKey), null);
  assert.notEqual(window.localStorage.getItem(scoped), null);
});

test("readChannelMutesStore: legacy delete succeeds but the confirmation read throws — scoped copy retained, no data loss", () => {
  const pubkey = "pk-mute-migrate-confirmthrow";
  const relay = "wss://relay-confirmthrow.example.com";
  const legacy = makeMuteStore({ chc: MUTE_E(true, 800, 3) });
  writeChannelMutesStore(pubkey, legacy);
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
    assert.deepEqual(readChannelMutesStore(pubkey, relay), DEFAULT_STORE);
    assert.notEqual(window.localStorage.getItem(scoped), null);
  } finally {
    window.localStorage.getItem = origGet;
    window.localStorage.removeItem = origRemove;
  }
  // Legacy gone + scoped retained → the next healthy read exposes the value.
  assert.equal(window.localStorage.getItem(legacyKey), null);
  assert.deepEqual(readChannelMutesStore(pubkey, relay), legacy);
});

test("readChannelMutesStore: legacy delete throws while the probe stays healthy — scoped rollback, DEFAULT, single future claimant", () => {
  const pubkey = "pk-mute-migrate-delthrow-probeok";
  const relay = "wss://relay-delthrow-probeok.example.com";
  const legacy = makeMuteStore({ cht: MUTE_E(true, 600, 2) });
  writeChannelMutesStore(pubkey, legacy);
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
    assert.deepEqual(readChannelMutesStore(pubkey, relay), DEFAULT_STORE);
    // Probe saw legacy still present → rolled back the just-written scoped copy
    // so a second relay scope cannot double-import the same legacy value.
    assert.equal(window.localStorage.getItem(scoped), null);
    assert.notEqual(window.localStorage.getItem(legacyKey), null);
  } finally {
    window.localStorage.removeItem = origRemove;
  }
  // Legacy survived, so exactly one future healthy read claims it.
  assert.deepEqual(readChannelMutesStore(pubkey, relay), legacy);
  assert.equal(window.localStorage.getItem(legacyKey), null);
});

test("readChannelMutesStore: legacy delete and the catch probe both throw — scoped kept but hidden while legacy remains", () => {
  const pubkey = "pk-mute-migrate-delthrow-probethrow";
  const relay = "wss://relay-delthrow-probethrow.example.com";
  const legacy = makeMuteStore({ chb: MUTE_E(true, 500, 1) });
  writeChannelMutesStore(pubkey, legacy);
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
    assert.deepEqual(readChannelMutesStore(pubkey, relay), DEFAULT_STORE);
    assert.notEqual(window.localStorage.getItem(scoped), null);
    // While legacy remains and storage is broken, every read returns DEFAULT.
    assert.deepEqual(readChannelMutesStore(pubkey, relay), DEFAULT_STORE);
  } finally {
    window.localStorage.getItem = origGet;
    window.localStorage.removeItem = origRemove;
  }
  // Storage recovers with legacy still present → the claim completes once.
  assert.deepEqual(readChannelMutesStore(pubkey, relay), legacy);
  assert.equal(window.localStorage.getItem(legacyKey), null);
});
