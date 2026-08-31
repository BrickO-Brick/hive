// Authoritative merge-lane storage suite, run directly against
// channelStarsStorage.ts (the canonical merge-lane implementation).
//
// Covers all merge-lane storage invariants: parsePayload contract, mergeStores
// algebra, boundStore, idsFromStore, storageKey, readStore/writeStore, and the
// full claimLegacy state machine. channelStarsStorage.test.mjs and
// channelMutesStorage.test.mjs each carry a compact adapter contract that catches
// field/key/prefix wiring divergence without replaying this full suite.

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRelayUrl } from "@/shared/lib/normalizeRelayUrl";
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

const storageKeyPrefix = "buzz-channel-stars.v1";
const MAX_ENTRIES = MAX_CHANNEL_STAR_ENTRIES;
const entryValueField = "starred";

function makeStore(channels = {}) {
  return { version: 1, channels };
}
const E = (v, updatedAt, rev) => ({ starred: v, updatedAt, rev });
const S = (entry) => makeStore({ c: entry });

// ── parsePayload ──────────────────────────────────────────────────────────

test("parseStarPayload: valid payload with channels returns store (rev preserved)", () => {
  const payload = {
    version: 1,
    channels: {
      "chan-1": E(true, 1000, 3),
      "chan-2": E(false, 2000, 0),
    },
  };
  assert.deepEqual(parseStarPayload(payload), payload);
});

test("parseStarPayload: missing rev normalizes to 0 (old-build blob, entry kept)", () => {
  const raw = {
    version: 1,
    channels: { "chan-1": { starred: true, updatedAt: 1000 } },
  };
  const result = parseStarPayload(raw);
  assert.deepEqual(result.channels["chan-1"], E(true, 1000, 0));
});

test("parseStarPayload: malformed rev (string / negative / non-integer / NaN / unsafe) normalizes to 0", () => {
  const raw = {
    version: 1,
    channels: {
      str: { starred: true, updatedAt: 1, rev: "5" },
      neg: { starred: true, updatedAt: 1, rev: -2 },
      frac: { starred: true, updatedAt: 1, rev: 1.5 },
      nan: { starred: true, updatedAt: 1, rev: NaN },
      boundary: { starred: true, updatedAt: 1, rev: Number.MAX_SAFE_INTEGER },
      huge: { starred: true, updatedAt: 1, rev: Number.MAX_SAFE_INTEGER + 1 },
    },
  };
  const result = parseStarPayload(raw);
  for (const id of ["str", "neg", "frac", "nan", "boundary", "huge"]) {
    assert.equal(result.channels[id].rev, 0, `${id} rev normalized to 0`);
    assert.equal(result.channels[id].starred, true, `${id} entry kept`);
  }
});

test("parseStarPayload: missing version returns null", () => {
  assert.equal(
    parseStarPayload({ channels: { "chan-1": E(true, 1, 0) } }),
    null,
  );
});

test("parseStarPayload: wrong version returns null", () => {
  assert.equal(
    parseStarPayload({ version: 2, channels: { "chan-1": E(true, 1, 0) } }),
    null,
  );
});

test("parseStarPayload: null / non-object input returns null", () => {
  assert.equal(parseStarPayload(null), null);
  assert.equal(parseStarPayload("string"), null);
  assert.equal(parseStarPayload(42), null);
  assert.equal(parseStarPayload(true), null);
});

test("parseStarPayload: malformed channel entries missing value field/updatedAt are filtered out", () => {
  const result = parseStarPayload({
    version: 1,
    channels: {
      "no-starred": { updatedAt: 1000 },
      "no-updated-at": { starred: true },
      valid: { starred: false, updatedAt: 500 },
      "value-wrong-type": { starred: "yes", updatedAt: 1000 },
      "updated-at-wrong-type": { starred: true, updatedAt: "now" },
      null: null,
    },
  });
  assert.deepEqual(result, makeStore({ valid: E(false, 500, 0) }));
});

test("parseStarPayload: NaN/Infinity/negative/unsafe updatedAt entries are filtered out", () => {
  const result = parseStarPayload({
    version: 1,
    channels: {
      nan: { starred: true, updatedAt: NaN },
      inf: { starred: true, updatedAt: Infinity },
      "neg-inf": { starred: true, updatedAt: -Infinity },
      neg: { starred: true, updatedAt: -1 },
      unsafe: { starred: true, updatedAt: Number.MAX_SAFE_INTEGER + 1 },
      valid: { starred: true, updatedAt: 100, rev: 2 },
    },
  });
  assert.deepEqual(result, makeStore({ valid: E(true, 100, 2) }));
});

test("parseStarPayload: empty channels / no channels key returns empty store", () => {
  assert.deepEqual(parseStarPayload({ version: 1, channels: {} }), makeStore());
  assert.deepEqual(parseStarPayload({ version: 1 }), makeStore());
});

// ── mergeStores: tuple order ──────────────────────────────────────────────

test("mergeStores: non-overlapping channels returns union", () => {
  const result = mergeStores(
    makeStore({ a: E(true, 100, 1) }),
    makeStore({ b: E(false, 200, 1) }),
  );
  assert.deepEqual(
    result,
    makeStore({ a: E(true, 100, 1), b: E(false, 200, 1) }),
  );
});

test("mergeStores: strictly-later updatedAt wins regardless of rev (primary key)", () => {
  const result = mergeStores(S(E(false, 200, 0)), S(E(true, 100, 7)));
  assert.deepEqual(result.channels.c, E(false, 200, 0));
});

test("mergeStores: equal updatedAt → higher rev wins (same-second tiebreak)", () => {
  const result = mergeStores(S(E(false, 100, 5)), S(E(true, 100, 2)));
  assert.deepEqual(result.channels.c, E(false, 100, 5));
});

test("mergeStores: equal updatedAt AND equal rev → true-value wins (leaf)", () => {
  const result = mergeStores(S(E(false, 100, 3)), S(E(true, 100, 3)));
  assert.deepEqual(result.channels.c, E(true, 100, 3));
});

test("mergeStores: same-second old-build click (rev 0) loses to an earlier new-build rev, heals next second", () => {
  // ACCEPTED MIXED-FLEET RESIDUAL (Carl P1 #5).
  const newBuildTrue = S(E(true, 100, 2));
  const oldBuildFalseSameSecond = S(E(false, 100, 0));
  assert.deepEqual(
    mergeStores(newBuildTrue, oldBuildFalseSameSecond).channels.c,
    E(true, 100, 2),
    "the earlier new-build rev-2 true wins the same-second tie",
  );
  const oldBuildFalseNextSecond = S(E(false, 101, 0));
  assert.deepEqual(
    mergeStores(newBuildTrue, oldBuildFalseNextSecond).channels.c,
    E(false, 101, 0),
    "a strictly-later-second old-build false wins — the residual is transient",
  );
});

test("mergeStores: a boundary (MAX_SAFE_INTEGER) rev cannot wedge later same-second toggles", () => {
  const raw = {
    version: 1,
    channels: {
      c: { starred: true, updatedAt: 100, rev: Number.MAX_SAFE_INTEGER },
    },
  };
  const wedged = parseStarPayload(raw);
  assert.equal(wedged.channels.c.rev, 0, "boundary rev is normalized to 0");
  const mint = (store, v) => {
    const local = store.channels.c;
    const rev = Math.max(local?.rev ?? 0, 0) + 1;
    return { store: S(E(v, 100, rev)), rev };
  };
  let state = wedged;
  let prevRev = state.channels.c.rev;
  for (const v of [false, true, false, true]) {
    const { store: click, rev } = mint(state, v);
    assert.ok(
      rev > prevRev,
      `mint rev ${rev} strictly advances past ${prevRev}`,
    );
    state = mergeStores(state, click);
    assert.deepEqual(
      state.channels.c,
      E(v, 100, rev),
      `same-second toggle to ${v} (rev ${rev}) wins`,
    );
    prevRev = rev;
  }
});

test("mergeStores: false-value with higher updatedAt overrides true-value", () => {
  const result = mergeStores(S(E(true, 100, 9)), S(E(false, 999, 1)));
  assert.deepEqual(result.channels.c, E(false, 999, 1));
});

test("mergeStores: empty local / empty remote / both empty", () => {
  assert.deepEqual(
    mergeStores(makeStore(), S(E(true, 42, 1))).channels.c,
    E(true, 42, 1),
  );
  assert.deepEqual(
    mergeStores(S(E(false, 10, 2)), makeStore()).channels.c,
    E(false, 10, 2),
  );
  assert.deepEqual(mergeStores(makeStore(), makeStore()), makeStore());
});

// ── mergeStores: algebra ──────────────────────────────────────────────────

function randEntry(rng) {
  return E(rng() > 0.5, Math.floor(rng() * 5), Math.floor(rng() * 5));
}
function randStore(rng, ids) {
  const channels = {};
  for (const id of ids) if (rng() > 0.3) channels[id] = randEntry(rng);
  return makeStore(channels);
}
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

// ── v1-blob bidirectional compatibility ───────────────────────────────────

test("v1 compat: a rev-carrying blob round-trips through a rev-less parser view", () => {
  const ours = makeStore({ c: E(true, 100, 7) });
  const roundTripped = parseStarPayload(JSON.parse(JSON.stringify(ours)));
  assert.equal(roundTripped.version, 1, "version stays 1");
  assert.equal(roundTripped.channels.c.starred, true);
  assert.equal(roundTripped.channels.c.updatedAt, 100);
});

test("v1 compat: old-build unstar (no rev, updatedAt+1) beats our stale star", () => {
  const ours = S(E(true, 100, 7));
  const oldBuildFalse = parseStarPayload({
    version: 1,
    channels: { c: { starred: false, updatedAt: 101 } },
  });
  assert.deepEqual(
    mergeStores(ours, oldBuildFalse).channels.c,
    E(false, 101, 0),
  );
});

// ── boundStore ────────────────────────────────────────────────────────────

test("boundStarStore: retains newest entries regardless of value", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_ENTRIES }, (_, i) => [
      `active-${i}`,
      E(true, i + 1, 0),
    ]),
  );
  channels["old-false"] = E(false, 0, 0);
  channels["new-false"] = E(false, 9999, 0);
  const result = boundStarStore(makeStore(channels));
  assert.equal(Object.keys(result.channels).length, MAX_ENTRIES);
  assert.equal(result.channels["old-false"], undefined);
  assert.deepEqual(result.channels["new-false"], E(false, 9999, 0));
  assert.equal(result.channels["active-0"], undefined);
});

test("boundStarStore: uses channel ID as an updatedAt tie-breaker", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => [
      `channel-${String(MAX_ENTRIES - i).padStart(3, "0")}`,
      E(true, 1, 0),
    ]),
  );
  const result = boundStarStore(makeStore(channels));
  assert.equal(result.channels["channel-000"], undefined);
  assert.deepEqual(result.channels["channel-500"], E(true, 1, 0));
});

test("boundStarStore: preserves a same-second mutation by key", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_ENTRIES }, (_, i) => [
      `z-channel-${String(i).padStart(3, "0")}`,
      E(true, 1, 0),
    ]),
  );
  channels["a-target"] = E(false, 1, 1);
  const result = boundStarStore(makeStore(channels), "a-target");
  assert.equal(Object.keys(result.channels).length, MAX_ENTRIES);
  assert.deepEqual(result.channels["a-target"], E(false, 1, 1));
  assert.equal(result.channels["z-channel-000"], undefined);
});

test("mergeStores: a fresh at-capacity unstar defeats an older remote star", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_ENTRIES }, (_, i) => [
      `active-${i}`,
      E(true, i + 1, 0),
    ]),
  );
  channels.toggled = E(false, 9999, 1);
  const bounded = boundStarStore(makeStore(channels));
  const result = mergeStores(bounded, makeStore({ toggled: E(true, 9998, 5) }));
  assert.deepEqual(result.channels.toggled, E(false, 9999, 1));
});

test("mergeStores: evicted remote ID re-enters and the oldest state is re-trimmed", () => {
  const localChannels = Object.fromEntries(
    Array.from({ length: MAX_ENTRIES }, (_, i) => [
      `active-${i}`,
      E(true, i + 10, 0),
    ]),
  );
  const result = mergeStores(
    makeStore(localChannels),
    makeStore({
      "evicted-id": E(true, 9999, 0),
      "active-0": E(false, 9998, 0),
    }),
  );
  assert.equal(Object.keys(result.channels).length, MAX_ENTRIES);
  assert.deepEqual(result.channels["evicted-id"], E(true, 9999, 0));
  assert.deepEqual(result.channels["active-0"], E(false, 9998, 0));
  assert.equal(result.channels["active-1"], undefined);
});

// ── Eviction / remount (finding 3) ────────────────────────────────────────

test("finding 3 easy branch: a fresh click beats an evicted high-rev entry at an older updatedAt", () => {
  const click = S(E(true, 1000, 1));
  const remote = S(E(false, 500, 100));
  assert.deepEqual(
    mergeStores(click, remote).channels.c,
    E(true, 1000, 1),
    "fresh click wins on the primary updatedAt key",
  );
});

test("finding 3 hard branch: equal-second evicted click (rev 1) loses to observed remote (rev 100)", () => {
  const NOW = 777;
  const TARGET = "aaa-target";
  const channels = { [TARGET]: E(true, NOW, 7) };
  for (let i = 0; i < MAX_ENTRIES; i++)
    channels[`z-${String(i).padStart(3, "0")}`] = E(true, NOW, 0);
  const bounded = boundStarStore(makeStore(channels));
  assert.equal(
    Object.keys(bounded.channels).length,
    MAX_ENTRIES,
    "bound trims to the cap",
  );
  assert.equal(
    bounded.channels[TARGET],
    undefined,
    "TARGET evicted by the id tiebreak",
  );
  const click = makeStore({ [TARGET]: E(true, NOW, 1) });
  const remote = makeStore({ [TARGET]: E(false, NOW, 100) });
  assert.deepEqual(
    mergeStores(click, remote).channels[TARGET],
    E(false, NOW, 100),
    "equal updatedAt → higher rev wins",
  );
  assert.deepEqual(
    mergeStores(remote, click).channels[TARGET],
    E(false, NOW, 100),
  );
});

// ── idsFromStore ─────────────────────────────────────────────────────────

test("starredChannelIdsFromStore: returns set of IDs where starred=true", () => {
  const result = starredChannelIdsFromStore({
    version: 1,
    channels: { a: E(true, 100, 0), b: E(true, 200, 0), c: E(false, 300, 0) },
  });
  assert.deepEqual([...result].sort(), ["a", "b"]);
});

test("starredChannelIdsFromStore: all-false / empty returns empty set", () => {
  assert.equal(
    starredChannelIdsFromStore({ version: 1, channels: { x: E(false, 1, 0) } })
      .size,
    0,
  );
  assert.equal(
    starredChannelIdsFromStore({ version: 1, channels: {} }).size,
    0,
  );
});

// ── storageKey + readStore/writeStore ─────────────────────────────────────

test("storageKey: with relayUrl includes normalized+encoded relay in key", () => {
  const relay = "wss://relay.example.com";
  assert.equal(
    storageKey("pk1", relay),
    `${storageKeyPrefix}:pk1:${encodeURIComponent(normalizeRelayUrl(relay))}`,
  );
});

test("storageKey: without relayUrl returns legacy pubkey-only key", () => {
  assert.equal(storageKey("pk1"), `${storageKeyPrefix}:pk1`);
  assert.equal(storageKey("pk1", undefined), `${storageKeyPrefix}:pk1`);
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
  const pubkey = "pk-stars-roundtrip";
  const relay = "wss://relay.example.com";
  const store = makeStore({ chan1: E(true, 1000, 1) });
  assert.ok(writeChannelStarsStore(pubkey, store, relay) !== null);
  assert.deepEqual(readChannelStarsStore(pubkey, relay), store);
});

test("readChannelStarsStore: scoped key is isolated from other relay's data (A→B no seed leak)", () => {
  const pubkey = "pk-stars-isolation";
  writeChannelStarsStore(
    pubkey,
    makeStore({ cha: E(true, 100, 1) }),
    "wss://relay-a.example.com",
  );
  assert.deepEqual(
    readChannelStarsStore(pubkey, "wss://relay-b.example.com"),
    DEFAULT_STORE,
  );
});

test("readChannelStarsStore: migrates legacy unscoped data on first scoped read", () => {
  const pubkey = "pk-stars-migrate";
  const relay = "wss://relay-migrate.example.com";
  const legacy = makeStore({ chl: E(true, 500, 2) });
  writeChannelStarsStore(pubkey, legacy);
  assert.deepEqual(readChannelStarsStore(pubkey, relay), legacy);
  assert.equal(window.localStorage.getItem(storageKey(pubkey)), null);
  assert.deepEqual(readChannelStarsStore(pubkey, relay), legacy);
});

test("readChannelStarsStore: migration is globally one-time — relay B sees DEFAULT_STORE after relay A migrates", () => {
  const pubkey = "pk-stars-migrate-once";
  writeChannelStarsStore(pubkey, makeStore({ chm: E(true, 1, 1) }));
  readChannelStarsStore(pubkey, "wss://relay-a-once.example.com");
  assert.deepEqual(
    readChannelStarsStore(pubkey, "wss://relay-b-once.example.com"),
    DEFAULT_STORE,
  );
  assert.equal(
    window.localStorage.getItem(
      storageKey(pubkey, "wss://relay-b-once.example.com"),
    ),
    null,
  );
});

test("readChannelStarsStore: migration only copies non-empty legacy stores", () => {
  const pubkey = "pk-stars-migrate-empty";
  const relay = "wss://relay-empty.example.com";
  writeChannelStarsStore(pubkey, DEFAULT_STORE);
  assert.deepEqual(readChannelStarsStore(pubkey, relay), DEFAULT_STORE);
  assert.notEqual(window.localStorage.getItem(storageKey(pubkey)), null);
});

test("readChannelStarsStore: scoped key takes precedence over legacy key", () => {
  const pubkey = "pk-stars-precedence";
  const relay = "wss://relay-precedence.example.com";
  writeChannelStarsStore(pubkey, makeStore({ old: E(true, 1, 1) }));
  const scoped = makeStore({ new: E(true, 2, 1) });
  writeChannelStarsStore(pubkey, scoped, relay);
  assert.deepEqual(readChannelStarsStore(pubkey, relay), scoped);
});

// ── claimLegacy state machine (authoritative — not duplicated in lane files) ──

test("claimLegacy: scoped-write failure returns DEFAULT and leaves neither relay able to seed the legacy value", () => {
  const pubkey = "pk-stars-migrate-writefail";
  const relayA = "wss://relay-a-writefail-stars.example.com";
  const relayB = "wss://relay-b-writefail-stars.example.com";
  const legacy = makeStore({ chw: E(true, 500, 2) });
  writeChannelStarsStore(pubkey, legacy);
  const scopedA = storageKey(pubkey, relayA);
  const origSet = window.localStorage.setItem;
  window.localStorage.setItem = (k, v) => {
    if (k === scopedA) throw new Error("QuotaExceededError");
    return origSet.call(window.localStorage, k, v);
  };
  try {
    assert.deepEqual(readChannelStarsStore(pubkey, relayA), DEFAULT_STORE);
    assert.equal(window.localStorage.getItem(scopedA), null);
  } finally {
    window.localStorage.setItem = origSet;
  }
  assert.notEqual(window.localStorage.getItem(storageKey(pubkey)), null);
  assert.deepEqual(readChannelStarsStore(pubkey, relayB), legacy);
  assert.equal(window.localStorage.getItem(storageKey(pubkey)), null);
  assert.deepEqual(readChannelStarsStore(pubkey, relayA), DEFAULT_STORE);
});

test("claimLegacy: a legacy delete that does not take rolls back and returns DEFAULT", () => {
  const pubkey = "pk-stars-migrate-delfail";
  const relay = "wss://relay-delfail-stars.example.com";
  const legacy = makeStore({ chd: E(true, 700, 3) });
  writeChannelStarsStore(pubkey, legacy);
  const legacyKey = storageKey(pubkey);
  const scoped = storageKey(pubkey, relay);
  const origRemove = window.localStorage.removeItem;
  window.localStorage.removeItem = (k) => {
    if (k === legacyKey) return;
    return origRemove.call(window.localStorage, k);
  };
  try {
    assert.deepEqual(readChannelStarsStore(pubkey, relay), DEFAULT_STORE);
    assert.equal(window.localStorage.getItem(scoped), null);
  } finally {
    window.localStorage.removeItem = origRemove;
  }
  assert.deepEqual(readChannelStarsStore(pubkey, relay), legacy);
  assert.equal(window.localStorage.getItem(legacyKey), null);
});

test("claimLegacy: legacy delete + rollback both throw — every read returns DEFAULT until storage recovers, never seeds", () => {
  const pubkey = "pk-stars-migrate-delrollbackthrow";
  const relay = "wss://relay-delrollbackthrow-stars.example.com";
  const legacy = makeStore({ chr: E(true, 900, 4) });
  writeChannelStarsStore(pubkey, legacy);
  const legacyKey = storageKey(pubkey);
  const scoped = storageKey(pubkey, relay);
  const origRemove = window.localStorage.removeItem;
  window.localStorage.removeItem = () => {
    throw new Error("SecurityError");
  };
  try {
    assert.deepEqual(readChannelStarsStore(pubkey, relay), DEFAULT_STORE);
    assert.deepEqual(readChannelStarsStore(pubkey, relay), DEFAULT_STORE);
    assert.notEqual(window.localStorage.getItem(legacyKey), null);
  } finally {
    window.localStorage.removeItem = origRemove;
  }
  assert.deepEqual(readChannelStarsStore(pubkey, relay), legacy);
  assert.equal(window.localStorage.getItem(legacyKey), null);
  assert.notEqual(window.localStorage.getItem(scoped), null);
});

test("claimLegacy: legacy delete succeeds but the confirmation read throws — scoped copy retained, no data loss", () => {
  const pubkey = "pk-stars-migrate-confirmthrow";
  const relay = "wss://relay-confirmthrow-stars.example.com";
  const legacy = makeStore({ chc: E(true, 800, 3) });
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
  window.localStorage.getItem = (k) => {
    if (k === legacyKey && legacyDeleted && !threwOnce) {
      threwOnce = true;
      throw new Error("SecurityError");
    }
    return origGet.call(window.localStorage, k);
  };
  try {
    assert.deepEqual(readChannelStarsStore(pubkey, relay), DEFAULT_STORE);
    assert.notEqual(window.localStorage.getItem(scoped), null);
  } finally {
    window.localStorage.getItem = origGet;
    window.localStorage.removeItem = origRemove;
  }
  assert.equal(window.localStorage.getItem(legacyKey), null);
  assert.deepEqual(readChannelStarsStore(pubkey, relay), legacy);
});

test("claimLegacy: legacy delete throws while the probe stays healthy — scoped rollback, DEFAULT, single future claimant", () => {
  const pubkey = "pk-stars-migrate-delthrow-probeok";
  const relay = "wss://relay-delthrow-probeok-stars.example.com";
  const legacy = makeStore({ cht: E(true, 600, 2) });
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
    assert.equal(window.localStorage.getItem(scoped), null);
    assert.notEqual(window.localStorage.getItem(legacyKey), null);
  } finally {
    window.localStorage.removeItem = origRemove;
  }
  assert.deepEqual(readChannelStarsStore(pubkey, relay), legacy);
  assert.equal(window.localStorage.getItem(legacyKey), null);
});

test("claimLegacy: legacy delete and the catch probe both throw — scoped kept but hidden while legacy remains", () => {
  const pubkey = "pk-stars-migrate-delthrow-probethrow";
  const relay = "wss://relay-delthrow-probethrow-stars.example.com";
  const legacy = makeStore({ chb: E(true, 500, 1) });
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
    assert.deepEqual(readChannelStarsStore(pubkey, relay), DEFAULT_STORE);
    assert.notEqual(window.localStorage.getItem(scoped), null);
    assert.deepEqual(readChannelStarsStore(pubkey, relay), DEFAULT_STORE);
  } finally {
    window.localStorage.getItem = origGet;
    window.localStorage.removeItem = origRemove;
  }
  assert.deepEqual(readChannelStarsStore(pubkey, relay), legacy);
  assert.equal(window.localStorage.getItem(legacyKey), null);
});
