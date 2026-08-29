// Shared parameterized test suite for merge-lane storage modules
// (channelStarsStorage.ts, channelMutesStorage.ts).
//
// Usage:
//   import { runMergeLaneStorageSuite } from "./mergeLaneStorage.shared.test.mjs";
//   runMergeLaneStorageSuite({
//     label:           "stars",
//     storageKeyPrefix: "buzz-channel-stars.v1",
//     MAX_ENTRIES:     MAX_CHANNEL_STAR_ENTRIES,
//     DEFAULT_STORE,
//     parsePayload:    parseStarPayload,
//     makeEntry:       (v, updatedAt, rev) => ({ starred: v, updatedAt, rev }),
//     entryValueField: "starred",
//     trueLabel:       "star",
//     falseLabel:      "unstar",
//     boundStore:      boundStarStore,
//     mergeStores,
//     idsFromStore:    starredChannelIdsFromStore,
//     readStore:       readChannelStarsStore,
//     writeStore:      writeChannelStarsStore,
//     storageKey,
//     normalizeRelayUrl,
//   });

import assert from "node:assert/strict";
import test from "node:test";
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

/**
 * Run the full merge-lane storage invariant suite for a single lane.
 *
 * @param {object} cfg
 * @param {string}   cfg.label            - Human-readable lane name for test titles.
 * @param {string}   cfg.storageKeyPrefix - The localStorage key prefix (e.g. "buzz-channel-stars.v1").
 * @param {number}   cfg.MAX_ENTRIES      - The lane's capacity cap.
 * @param {object}   cfg.DEFAULT_STORE    - The lane's empty default store.
 * @param {Function} cfg.parsePayload     - parse{Star|Mute}Payload.
 * @param {Function} cfg.makeEntry        - (value, updatedAt, rev) => entry object.
 * @param {string}   cfg.entryValueField  - "starred" or "muted".
 * @param {string}   cfg.trueLabel        - Action name when value=true (e.g. "star").
 * @param {string}   cfg.falseLabel       - Action name when value=false (e.g. "unstar").
 * @param {Function} cfg.boundStore       - bound{Star|Mute}Store(store, preservedKey?).
 * @param {Function} cfg.mergeStores      - mergeStores(a, b, preservedKey?).
 * @param {Function} cfg.idsFromStore     - {starred|muted}ChannelIdsFromStore(store).
 * @param {Function} cfg.readStore        - readChannel{Stars|Mutes}Store(pubkey, relay?).
 * @param {Function} cfg.writeStore       - writeChannel{Stars|Mutes}Store(pubkey, store, relay?).
 * @param {Function} cfg.storageKey       - storageKey(pubkey, relay?).
 */
export function runMergeLaneStorageSuite({
  label,
  storageKeyPrefix,
  MAX_ENTRIES,
  DEFAULT_STORE,
  parsePayload,
  makeEntry,
  entryValueField,
  trueLabel,
  falseLabel,
  boundStore,
  mergeStores,
  idsFromStore,
  readStore,
  writeStore,
  storageKey,
}) {
  function makeStore(channels = {}) {
    return { version: 1, channels };
  }
  const E = (v, updatedAt, rev) => makeEntry(v, updatedAt, rev);
  const S = (entry) => makeStore({ c: entry });

  // ── parsePayload ──────────────────────────────────────────────────────────

  test(`${label}: parsePayload: valid payload with channels returns store (rev preserved)`, () => {
    const payload = {
      version: 1,
      channels: {
        "chan-1": makeEntry(true, 1000, 3),
        "chan-2": makeEntry(false, 2000, 0),
      },
    };
    assert.deepEqual(parsePayload(payload), payload);
  });

  test(`${label}: parsePayload: missing rev normalizes to 0 (old-build blob, entry kept)`, () => {
    const raw = {
      version: 1,
      channels: { "chan-1": { [entryValueField]: true, updatedAt: 1000 } },
    };
    const result = parsePayload(raw);
    assert.deepEqual(result.channels["chan-1"], makeEntry(true, 1000, 0));
  });

  test(`${label}: parsePayload: malformed rev (string / negative / non-integer / NaN / unsafe) normalizes to 0`, () => {
    const raw = {
      version: 1,
      channels: {
        str: { [entryValueField]: true, updatedAt: 1, rev: "5" },
        neg: { [entryValueField]: true, updatedAt: 1, rev: -2 },
        frac: { [entryValueField]: true, updatedAt: 1, rev: 1.5 },
        nan: { [entryValueField]: true, updatedAt: 1, rev: NaN },
        boundary: {
          [entryValueField]: true,
          updatedAt: 1,
          rev: Number.MAX_SAFE_INTEGER,
        },
        huge: {
          [entryValueField]: true,
          updatedAt: 1,
          rev: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    };
    const result = parsePayload(raw);
    for (const id of ["str", "neg", "frac", "nan", "boundary", "huge"]) {
      assert.equal(result.channels[id].rev, 0, `${id} rev normalized to 0`);
      assert.equal(
        result.channels[id][entryValueField],
        true,
        `${id} entry kept`,
      );
    }
  });

  test(`${label}: parsePayload: missing version returns null`, () => {
    assert.equal(
      parsePayload({ channels: { "chan-1": makeEntry(true, 1, 0) } }),
      null,
    );
  });

  test(`${label}: parsePayload: wrong version returns null`, () => {
    assert.equal(
      parsePayload({
        version: 2,
        channels: { "chan-1": makeEntry(true, 1, 0) },
      }),
      null,
    );
  });

  test(`${label}: parsePayload: null / non-object input returns null`, () => {
    assert.equal(parsePayload(null), null);
    assert.equal(parsePayload("string"), null);
    assert.equal(parsePayload(42), null);
    assert.equal(parsePayload(true), null);
  });

  test(`${label}: parsePayload: malformed channel entries missing value field/updatedAt are filtered out`, () => {
    const result = parsePayload({
      version: 1,
      channels: {
        [`no-${entryValueField}`]: { updatedAt: 1000 },
        "no-updated-at": { [entryValueField]: true },
        valid: { [entryValueField]: false, updatedAt: 500 },
        "value-wrong-type": { [entryValueField]: "yes", updatedAt: 1000 },
        "updated-at-wrong-type": { [entryValueField]: true, updatedAt: "now" },
        null: null,
      },
    });
    assert.deepEqual(result, makeStore({ valid: makeEntry(false, 500, 0) }));
  });

  test(`${label}: parsePayload: NaN/Infinity/negative/unsafe updatedAt entries are filtered out`, () => {
    const result = parsePayload({
      version: 1,
      channels: {
        nan: { [entryValueField]: true, updatedAt: NaN },
        inf: { [entryValueField]: true, updatedAt: Infinity },
        "neg-inf": { [entryValueField]: true, updatedAt: -Infinity },
        neg: { [entryValueField]: true, updatedAt: -1 },
        unsafe: {
          [entryValueField]: true,
          updatedAt: Number.MAX_SAFE_INTEGER + 1,
        },
        valid: { [entryValueField]: true, updatedAt: 100, rev: 2 },
      },
    });
    assert.deepEqual(result, makeStore({ valid: makeEntry(true, 100, 2) }));
  });

  test(`${label}: parsePayload: empty channels / no channels key returns empty store`, () => {
    assert.deepEqual(parsePayload({ version: 1, channels: {} }), makeStore());
    assert.deepEqual(parsePayload({ version: 1 }), makeStore());
  });

  // ── mergeStores: tuple order ──────────────────────────────────────────────

  test(`${label}: mergeStores: non-overlapping channels returns union`, () => {
    const result = mergeStores(
      makeStore({ a: E(true, 100, 1) }),
      makeStore({ b: E(false, 200, 1) }),
    );
    assert.deepEqual(
      result,
      makeStore({ a: E(true, 100, 1), b: E(false, 200, 1) }),
    );
  });

  test(`${label}: mergeStores: strictly-later updatedAt wins regardless of rev (primary key)`, () => {
    const result = mergeStores(S(E(false, 200, 0)), S(E(true, 100, 7)));
    assert.deepEqual(result.channels.c, E(false, 200, 0));
  });

  test(`${label}: mergeStores: equal updatedAt → higher rev wins (same-second tiebreak)`, () => {
    const result = mergeStores(S(E(false, 100, 5)), S(E(true, 100, 2)));
    assert.deepEqual(result.channels.c, E(false, 100, 5));
  });

  test(`${label}: mergeStores: equal updatedAt AND equal rev → true-value wins (leaf)`, () => {
    const result = mergeStores(S(E(false, 100, 3)), S(E(true, 100, 3)));
    assert.deepEqual(result.channels.c, E(true, 100, 3));
  });

  test(`${label}: mergeStores: same-second old-build click (rev 0) loses to an earlier new-build rev, heals next second`, () => {
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

  test(`${label}: mergeStores: a boundary (MAX_SAFE_INTEGER) rev cannot wedge later same-second toggles`, () => {
    const raw = {
      version: 1,
      channels: {
        c: {
          [entryValueField]: true,
          updatedAt: 100,
          rev: Number.MAX_SAFE_INTEGER,
        },
      },
    };
    const wedged = parsePayload(raw);
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

  test(`${label}: mergeStores: false-value with higher updatedAt overrides true-value`, () => {
    const result = mergeStores(S(E(true, 100, 9)), S(E(false, 999, 1)));
    assert.deepEqual(result.channels.c, E(false, 999, 1));
  });

  test(`${label}: mergeStores: empty local / empty remote / both empty`, () => {
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
    return makeEntry(rng() > 0.5, Math.floor(rng() * 5), Math.floor(rng() * 5));
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

  test(`${label}: mergeStores: commutative — merge(a,b) === merge(b,a)`, () => {
    const rng = lcg(12345);
    const ids = ["a", "b", "c", "d"];
    for (let i = 0; i < 200; i++) {
      const a = randStore(rng, ids);
      const b = randStore(rng, ids);
      assert.deepEqual(mergeStores(a, b), mergeStores(b, a));
    }
  });

  test(`${label}: mergeStores: associative — merge(merge(a,b),c) === merge(a,merge(b,c))`, () => {
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

  test(`${label}: mergeStores: idempotent — merge(a, merge(a,b)) === merge(a,b)`, () => {
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

  test(`${label}: v1 compat: a rev-carrying blob round-trips through a rev-less parser view`, () => {
    const ours = makeStore({ c: makeEntry(true, 100, 7) });
    const roundTripped = parsePayload(JSON.parse(JSON.stringify(ours)));
    assert.equal(roundTripped.version, 1, "version stays 1");
    assert.equal(roundTripped.channels.c[entryValueField], true);
    assert.equal(roundTripped.channels.c.updatedAt, 100);
  });

  test(`${label}: v1 compat: old-build ${falseLabel} (no rev, updatedAt+1) beats our stale ${trueLabel}`, () => {
    const ours = S(E(true, 100, 7));
    const oldBuildFalse = parsePayload({
      version: 1,
      channels: { c: { [entryValueField]: false, updatedAt: 101 } },
    });
    assert.deepEqual(
      mergeStores(ours, oldBuildFalse).channels.c,
      makeEntry(false, 101, 0),
    );
  });

  // ── boundStore ────────────────────────────────────────────────────────────

  test(`${label}: boundStore: retains newest entries regardless of value`, () => {
    const channels = Object.fromEntries(
      Array.from({ length: MAX_ENTRIES }, (_, i) => [
        `active-${i}`,
        E(true, i + 1, 0),
      ]),
    );
    channels["old-false"] = E(false, 0, 0);
    channels["new-false"] = E(false, 9999, 0);
    const result = boundStore(makeStore(channels));
    assert.equal(Object.keys(result.channels).length, MAX_ENTRIES);
    assert.equal(result.channels["old-false"], undefined);
    assert.deepEqual(result.channels["new-false"], E(false, 9999, 0));
    assert.equal(result.channels["active-0"], undefined);
  });

  test(`${label}: boundStore: uses channel ID as an updatedAt tie-breaker`, () => {
    const channels = Object.fromEntries(
      Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => [
        `channel-${String(MAX_ENTRIES - i).padStart(3, "0")}`,
        E(true, 1, 0),
      ]),
    );
    const result = boundStore(makeStore(channels));
    assert.equal(result.channels["channel-000"], undefined);
    assert.deepEqual(result.channels["channel-500"], E(true, 1, 0));
  });

  test(`${label}: boundStore: preserves a same-second mutation by key`, () => {
    const channels = Object.fromEntries(
      Array.from({ length: MAX_ENTRIES }, (_, i) => [
        `z-channel-${String(i).padStart(3, "0")}`,
        E(true, 1, 0),
      ]),
    );
    channels["a-target"] = E(false, 1, 1);
    const result = boundStore(makeStore(channels), "a-target");
    assert.equal(Object.keys(result.channels).length, MAX_ENTRIES);
    assert.deepEqual(result.channels["a-target"], E(false, 1, 1));
    assert.equal(result.channels["z-channel-000"], undefined);
  });

  test(`${label}: mergeStores: a fresh at-capacity ${falseLabel} defeats an older remote ${trueLabel}`, () => {
    const channels = Object.fromEntries(
      Array.from({ length: MAX_ENTRIES }, (_, i) => [
        `active-${i}`,
        E(true, i + 1, 0),
      ]),
    );
    channels.toggled = E(false, 9999, 1);
    const bounded = boundStore(makeStore(channels));
    const result = mergeStores(
      bounded,
      makeStore({ toggled: E(true, 9998, 5) }),
    );
    assert.deepEqual(result.channels.toggled, E(false, 9999, 1));
  });

  test(`${label}: mergeStores: evicted remote ID re-enters and the oldest state is re-trimmed`, () => {
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

  test(`${label}: finding 3 easy branch: a fresh click beats an evicted high-rev entry at an older updatedAt`, () => {
    const click = S(E(true, 1000, 1));
    const remote = S(E(false, 500, 100));
    assert.deepEqual(
      mergeStores(click, remote).channels.c,
      E(true, 1000, 1),
      "fresh click wins on the primary updatedAt key",
    );
  });

  test(`${label}: finding 3 hard branch: equal-second evicted click (rev 1) loses to observed remote (rev 100)`, () => {
    const NOW = 777;
    const TARGET = "aaa-target";
    const channels = { [TARGET]: E(true, NOW, 7) };
    for (let i = 0; i < MAX_ENTRIES; i++)
      channels[`z-${String(i).padStart(3, "0")}`] = E(true, NOW, 0);
    const bounded = boundStore(makeStore(channels));
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

  test(`${label}: idsFromStore: returns set of IDs where ${entryValueField}=true`, () => {
    const result = idsFromStore({
      version: 1,
      channels: {
        a: E(true, 100, 0),
        b: E(true, 200, 0),
        c: E(false, 300, 0),
      },
    });
    assert.deepEqual([...result].sort(), ["a", "b"]);
  });

  test(`${label}: idsFromStore: all-false / empty returns empty set`, () => {
    assert.equal(
      idsFromStore({
        version: 1,
        channels: { x: E(false, 1, 0) },
      }).size,
      0,
    );
    assert.equal(idsFromStore({ version: 1, channels: {} }).size, 0);
  });

  // ── storageKey + readStore/writeStore ─────────────────────────────────────

  test(`${label}: storageKey: with relayUrl includes normalized+encoded relay in key`, () => {
    const relay = "wss://relay.example.com";
    assert.equal(
      storageKey("pk1", relay),
      `${storageKeyPrefix}:pk1:${encodeURIComponent(normalizeRelayUrl(relay))}`,
    );
  });

  test(`${label}: storageKey: without relayUrl returns legacy pubkey-only key`, () => {
    assert.equal(storageKey("pk1"), `${storageKeyPrefix}:pk1`);
    assert.equal(storageKey("pk1", undefined), `${storageKeyPrefix}:pk1`);
  });

  test(`${label}: storageKey: two different relays produce different keys for same pubkey`, () => {
    assert.notEqual(
      storageKey("pk1", "wss://relay-a.example.com"),
      storageKey("pk1", "wss://relay-b.example.com"),
    );
  });

  test(`${label}: storageKey: equivalent relay URLs (case + trailing slash) map to the same key`, () => {
    assert.equal(
      storageKey("pk1", "WSS://Relay.Example/"),
      storageKey("pk1", "wss://relay.example"),
    );
  });

  test(`${label}: readStore + writeStore: scoped write/read roundtrip`, () => {
    const pubkey = `pk-${label}-roundtrip`;
    const relay = "wss://relay.example.com";
    const store = makeStore({ chan1: E(true, 1000, 1) });
    assert.ok(writeStore(pubkey, store, relay) !== null);
    assert.deepEqual(readStore(pubkey, relay), store);
  });

  test(`${label}: readStore: scoped key is isolated from other relay's data (A→B no seed leak)`, () => {
    const pubkey = `pk-${label}-isolation`;
    writeStore(
      pubkey,
      makeStore({ cha: E(true, 100, 1) }),
      "wss://relay-a.example.com",
    );
    assert.deepEqual(
      readStore(pubkey, "wss://relay-b.example.com"),
      DEFAULT_STORE,
    );
  });

  test(`${label}: readStore: migrates legacy unscoped data on first scoped read`, () => {
    const pubkey = `pk-${label}-migrate`;
    const relay = "wss://relay-migrate.example.com";
    const legacy = makeStore({ chl: E(true, 500, 2) });
    writeStore(pubkey, legacy);
    assert.deepEqual(readStore(pubkey, relay), legacy);
    assert.equal(window.localStorage.getItem(storageKey(pubkey)), null);
    assert.deepEqual(readStore(pubkey, relay), legacy);
  });

  test(`${label}: readStore: migration is globally one-time — relay B sees DEFAULT_STORE after relay A migrates`, () => {
    const pubkey = `pk-${label}-migrate-once`;
    writeStore(pubkey, makeStore({ chm: E(true, 1, 1) }));
    readStore(pubkey, "wss://relay-a-once.example.com");
    assert.deepEqual(
      readStore(pubkey, "wss://relay-b-once.example.com"),
      DEFAULT_STORE,
    );
    assert.equal(
      window.localStorage.getItem(
        storageKey(pubkey, "wss://relay-b-once.example.com"),
      ),
      null,
    );
  });

  test(`${label}: readStore: migration only copies non-empty legacy stores`, () => {
    const pubkey = `pk-${label}-migrate-empty`;
    const relay = "wss://relay-empty.example.com";
    writeStore(pubkey, DEFAULT_STORE);
    assert.deepEqual(readStore(pubkey, relay), DEFAULT_STORE);
    assert.notEqual(window.localStorage.getItem(storageKey(pubkey)), null);
  });

  test(`${label}: readStore: scoped key takes precedence over legacy key`, () => {
    const pubkey = `pk-${label}-precedence`;
    const relay = "wss://relay-precedence.example.com";
    writeStore(pubkey, makeStore({ old: E(true, 1, 1) }));
    const scoped = makeStore({ new: E(true, 2, 1) });
    writeStore(pubkey, scoped, relay);
    assert.deepEqual(readStore(pubkey, relay), scoped);
  });

  test(`${label}: readStore: scoped-write failure returns DEFAULT and leaves neither relay able to seed the legacy value`, () => {
    const pubkey = `pk-${label}-migrate-writefail`;
    const relayA = `wss://relay-a-writefail-${label}.example.com`;
    const relayB = `wss://relay-b-writefail-${label}.example.com`;
    const legacy = makeStore({ chw: E(true, 500, 2) });
    writeStore(pubkey, legacy);
    const scopedA = storageKey(pubkey, relayA);
    const origSet = window.localStorage.setItem;
    window.localStorage.setItem = (k, v) => {
      if (k === scopedA) throw new Error("QuotaExceededError");
      return origSet.call(window.localStorage, k, v);
    };
    try {
      assert.deepEqual(readStore(pubkey, relayA), DEFAULT_STORE);
      assert.equal(window.localStorage.getItem(scopedA), null);
    } finally {
      window.localStorage.setItem = origSet;
    }
    assert.notEqual(window.localStorage.getItem(storageKey(pubkey)), null);
    assert.deepEqual(readStore(pubkey, relayB), legacy);
    assert.equal(window.localStorage.getItem(storageKey(pubkey)), null);
    assert.deepEqual(readStore(pubkey, relayA), DEFAULT_STORE);
  });

  test(`${label}: readStore: a legacy delete that does not take rolls back and returns DEFAULT`, () => {
    const pubkey = `pk-${label}-migrate-delfail`;
    const relay = `wss://relay-delfail-${label}.example.com`;
    const legacy = makeStore({ chd: E(true, 700, 3) });
    writeStore(pubkey, legacy);
    const legacyKey = storageKey(pubkey);
    const scoped = storageKey(pubkey, relay);
    const origRemove = window.localStorage.removeItem;
    window.localStorage.removeItem = (k) => {
      if (k === legacyKey) return;
      return origRemove.call(window.localStorage, k);
    };
    try {
      assert.deepEqual(readStore(pubkey, relay), DEFAULT_STORE);
      assert.equal(window.localStorage.getItem(scoped), null);
    } finally {
      window.localStorage.removeItem = origRemove;
    }
    assert.deepEqual(readStore(pubkey, relay), legacy);
    assert.equal(window.localStorage.getItem(legacyKey), null);
  });

  test(`${label}: readStore: legacy delete + rollback both throw — every read returns DEFAULT until storage recovers, never seeds`, () => {
    const pubkey = `pk-${label}-migrate-delrollbackthrow`;
    const relay = `wss://relay-delrollbackthrow-${label}.example.com`;
    const legacy = makeStore({ chr: E(true, 900, 4) });
    writeStore(pubkey, legacy);
    const legacyKey = storageKey(pubkey);
    const scoped = storageKey(pubkey, relay);
    const origRemove = window.localStorage.removeItem;
    window.localStorage.removeItem = () => {
      throw new Error("SecurityError");
    };
    try {
      assert.deepEqual(readStore(pubkey, relay), DEFAULT_STORE);
      assert.deepEqual(readStore(pubkey, relay), DEFAULT_STORE);
      assert.notEqual(window.localStorage.getItem(legacyKey), null);
    } finally {
      window.localStorage.removeItem = origRemove;
    }
    assert.deepEqual(readStore(pubkey, relay), legacy);
    assert.equal(window.localStorage.getItem(legacyKey), null);
    assert.notEqual(window.localStorage.getItem(scoped), null);
  });

  test(`${label}: readStore: legacy delete succeeds but the confirmation read throws — scoped copy retained, no data loss`, () => {
    const pubkey = `pk-${label}-migrate-confirmthrow`;
    const relay = `wss://relay-confirmthrow-${label}.example.com`;
    const legacy = makeStore({ chc: E(true, 800, 3) });
    writeStore(pubkey, legacy);
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
      assert.deepEqual(readStore(pubkey, relay), DEFAULT_STORE);
      assert.notEqual(window.localStorage.getItem(scoped), null);
    } finally {
      window.localStorage.getItem = origGet;
      window.localStorage.removeItem = origRemove;
    }
    assert.equal(window.localStorage.getItem(legacyKey), null);
    assert.deepEqual(readStore(pubkey, relay), legacy);
  });

  test(`${label}: readStore: legacy delete throws while the probe stays healthy — scoped rollback, DEFAULT, single future claimant`, () => {
    const pubkey = `pk-${label}-migrate-delthrow-probeok`;
    const relay = `wss://relay-delthrow-probeok-${label}.example.com`;
    const legacy = makeStore({ cht: E(true, 600, 2) });
    writeStore(pubkey, legacy);
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
      assert.deepEqual(readStore(pubkey, relay), DEFAULT_STORE);
      assert.equal(window.localStorage.getItem(scoped), null);
      assert.notEqual(window.localStorage.getItem(legacyKey), null);
    } finally {
      window.localStorage.removeItem = origRemove;
    }
    assert.deepEqual(readStore(pubkey, relay), legacy);
    assert.equal(window.localStorage.getItem(legacyKey), null);
  });

  test(`${label}: readStore: legacy delete and the catch probe both throw — scoped kept but hidden while legacy remains`, () => {
    const pubkey = `pk-${label}-migrate-delthrow-probethrow`;
    const relay = `wss://relay-delthrow-probethrow-${label}.example.com`;
    const legacy = makeStore({ chb: E(true, 500, 1) });
    writeStore(pubkey, legacy);
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
      assert.deepEqual(readStore(pubkey, relay), DEFAULT_STORE);
      assert.notEqual(window.localStorage.getItem(scoped), null);
      assert.deepEqual(readStore(pubkey, relay), DEFAULT_STORE);
    } finally {
      window.localStorage.getItem = origGet;
      window.localStorage.removeItem = origRemove;
    }
    assert.deepEqual(readStore(pubkey, relay), legacy);
    assert.equal(window.localStorage.getItem(legacyKey), null);
  });
}
