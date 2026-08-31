// Authoritative merge-lane storage suite — runs directly against
// channelStarsStorage.ts (the canonical merge-lane implementation).
//
// Covers all merge-lane storage invariants: parsePayload contract, mergeStores
// algebra, boundStore, idsFromStore, storageKey, readStore/writeStore, and the
// full claimLegacy state machine. Lane adapter files carry compact contracts
// that catch field/key/prefix wiring divergence without replaying this suite.

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
const E = (v, updatedAt, rev) => ({ starred: v, updatedAt, rev });
const S = (entry) => ({ version: 1, channels: { c: entry } });
function makeStore(channels = {}) {
  return { version: 1, channels };
}

// ── parsePayload ──────────────────────────────────────────────────────────────

test("parseStarPayload: valid payload round-trips (rev preserved)", () => {
  const payload = {
    version: 1,
    channels: { "chan-1": E(true, 1000, 3), "chan-2": E(false, 2000, 0) },
  };
  assert.deepEqual(parseStarPayload(payload), payload);
});

test("parseStarPayload: missing rev normalizes to 0 (old-build blob, entry kept)", () => {
  const result = parseStarPayload({
    version: 1,
    channels: { "chan-1": { starred: true, updatedAt: 1000 } },
  });
  assert.deepEqual(result.channels["chan-1"], E(true, 1000, 0));
});

test("parseStarPayload: malformed rev (string/negative/fraction/NaN/unsafe-int) normalizes to 0", () => {
  const result = parseStarPayload({
    version: 1,
    channels: {
      str: { starred: true, updatedAt: 1, rev: "5" },
      neg: { starred: true, updatedAt: 1, rev: -2 },
      frac: { starred: true, updatedAt: 1, rev: 1.5 },
      nan: { starred: true, updatedAt: 1, rev: NaN },
      boundary: { starred: true, updatedAt: 1, rev: Number.MAX_SAFE_INTEGER },
      huge: { starred: true, updatedAt: 1, rev: Number.MAX_SAFE_INTEGER + 1 },
    },
  });
  for (const id of ["str", "neg", "frac", "nan", "boundary", "huge"])
    assert.equal(result.channels[id].rev, 0, `${id} rev normalized to 0`);
});

for (const [title, input] of [
  ["missing version", { channels: { c: E(true, 1, 0) } }],
  ["wrong version (2)", { version: 2, channels: {} }],
  ["null input", null],
  ["string input", "string"],
  ["number input", 42],
]) {
  test(`parseStarPayload: ${title} returns null`, () =>
    assert.equal(parseStarPayload(input), null));
}

test("parseStarPayload: malformed entries filtered; valid entry kept", () => {
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

test("parseStarPayload: NaN/Infinity/negative/unsafe updatedAt entries filtered", () => {
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

// ── mergeStores ───────────────────────────────────────────────────────────────

test("mergeStores: non-overlapping channels returns union", () =>
  assert.deepEqual(
    mergeStores(
      makeStore({ a: E(true, 100, 1) }),
      makeStore({ b: E(false, 200, 1) }),
    ),
    makeStore({ a: E(true, 100, 1), b: E(false, 200, 1) }),
  ));

for (const [title, a, b, expected] of [
  [
    "strictly-later updatedAt wins (primary key)",
    S(E(false, 200, 0)),
    S(E(true, 100, 7)),
    E(false, 200, 0),
  ],
  [
    "equal updatedAt: higher rev wins (tiebreak)",
    S(E(false, 100, 5)),
    S(E(true, 100, 2)),
    E(false, 100, 5),
  ],
  [
    "equal updatedAt AND rev: true-value wins (leaf)",
    S(E(false, 100, 3)),
    S(E(true, 100, 3)),
    E(true, 100, 3),
  ],
  [
    "false with higher updatedAt overrides true",
    S(E(true, 100, 9)),
    S(E(false, 999, 1)),
    E(false, 999, 1),
  ],
]) {
  test(`mergeStores: ${title}`, () =>
    assert.deepEqual(mergeStores(a, b).channels.c, expected));
}

test("mergeStores: same-second old-build click (rev 0) loses to earlier new-build rev; heals next second", () => {
  assert.deepEqual(
    mergeStores(S(E(true, 100, 2)), S(E(false, 100, 0))).channels.c,
    E(true, 100, 2),
    "earlier new-build rev-2 true wins same-second tie",
  );
  assert.deepEqual(
    mergeStores(S(E(true, 100, 2)), S(E(false, 101, 0))).channels.c,
    E(false, 101, 0),
    "strictly-later-second old-build false wins — residual is transient",
  );
});

test("mergeStores: boundary (MAX_SAFE_INTEGER) rev cannot wedge later same-second toggles", () => {
  const wedged = parseStarPayload({
    version: 1,
    channels: {
      c: { starred: true, updatedAt: 100, rev: Number.MAX_SAFE_INTEGER },
    },
  });
  assert.equal(wedged.channels.c.rev, 0, "boundary rev normalized to 0");
  const mint = (store, v) => {
    const rev = Math.max(store.channels.c?.rev ?? 0, 0) + 1;
    return { store: S(E(v, 100, rev)), rev };
  };
  let state = wedged;
  let prevRev = 0;
  for (const v of [false, true, false, true]) {
    const { store: click, rev } = mint(state, v);
    assert.ok(rev > prevRev, `mint rev ${rev} advances past ${prevRev}`);
    state = mergeStores(state, click);
    assert.deepEqual(
      state.channels.c,
      E(v, 100, rev),
      `toggle to ${v} (rev ${rev}) wins`,
    );
    prevRev = rev;
  }
});

test("mergeStores: empty-store cases", () => {
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

// ── mergeStores: algebra ──────────────────────────────────────────────────────

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

for (const [title, check, seed] of [
  [
    "commutative — merge(a,b) === merge(b,a)",
    (a, b) => assert.deepEqual(mergeStores(a, b), mergeStores(b, a)),
    12345,
  ],
  [
    "associative — merge(merge(a,b),c) === merge(a,merge(b,c))",
    (a, b, c) =>
      assert.deepEqual(
        mergeStores(mergeStores(a, b), c),
        mergeStores(a, mergeStores(b, c)),
      ),
    67890,
  ],
  [
    "idempotent — merge(a, merge(a,b)) === merge(a,b)",
    (a, b) => {
      const ab = mergeStores(a, b);
      assert.deepEqual(mergeStores(a, ab), ab);
      assert.deepEqual(mergeStores(ab, ab), ab);
    },
    24680,
  ],
]) {
  test(`mergeStores: ${title}`, () => {
    const rng = lcg(seed);
    const ids = ["a", "b", "c", "d"];
    for (let i = 0; i < 200; i++)
      check(randStore(rng, ids), randStore(rng, ids), randStore(rng, ids));
  });
}

// ── v1-blob compat ────────────────────────────────────────────────────────────

test("v1 compat: rev-carrying blob round-trips through a rev-less parser view", () => {
  const roundTripped = parseStarPayload(
    JSON.parse(JSON.stringify(makeStore({ c: E(true, 100, 7) }))),
  );
  assert.equal(roundTripped.version, 1);
  assert.equal(roundTripped.channels.c.starred, true);
  assert.equal(roundTripped.channels.c.updatedAt, 100);
});

test("v1 compat: old-build unstar (no rev, updatedAt+1) beats our stale star", () => {
  assert.deepEqual(
    mergeStores(
      S(E(true, 100, 7)),
      parseStarPayload({
        version: 1,
        channels: { c: { starred: false, updatedAt: 101 } },
      }),
    ).channels.c,
    E(false, 101, 0),
  );
});

// ── boundStore ────────────────────────────────────────────────────────────────

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

test("boundStarStore: uses channel ID as updatedAt tie-breaker", () => {
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

test("mergeStores: fresh at-capacity unstar defeats older remote star", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_ENTRIES }, (_, i) => [
      `active-${i}`,
      E(true, i + 1, 0),
    ]),
  );
  channels.toggled = E(false, 9999, 1);
  const bounded = boundStarStore(makeStore(channels));
  assert.deepEqual(
    mergeStores(bounded, makeStore({ toggled: E(true, 9998, 5) })).channels
      .toggled,
    E(false, 9999, 1),
  );
});

test("mergeStores: evicted remote ID re-enters and oldest state is re-trimmed", () => {
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

test("finding 3 easy branch: fresh click beats evicted high-rev entry at older updatedAt", () =>
  assert.deepEqual(
    mergeStores(S(E(true, 1000, 1)), S(E(false, 500, 100))).channels.c,
    E(true, 1000, 1),
  ));

test("finding 3 hard branch: equal-second evicted click (rev 1) loses to observed remote (rev 100)", () => {
  const NOW = 777;
  const TARGET = "aaa-target";
  const channels = { [TARGET]: E(true, NOW, 7) };
  for (let i = 0; i < MAX_ENTRIES; i++)
    channels[`z-${String(i).padStart(3, "0")}`] = E(true, NOW, 0);
  const bounded = boundStarStore(makeStore(channels));
  assert.equal(
    bounded.channels[TARGET],
    undefined,
    "TARGET evicted by id tiebreak",
  );
  assert.deepEqual(
    mergeStores(
      makeStore({ [TARGET]: E(true, NOW, 1) }),
      makeStore({ [TARGET]: E(false, NOW, 100) }),
    ).channels[TARGET],
    E(false, NOW, 100),
  );
  assert.deepEqual(
    mergeStores(
      makeStore({ [TARGET]: E(false, NOW, 100) }),
      makeStore({ [TARGET]: E(true, NOW, 1) }),
    ).channels[TARGET],
    E(false, NOW, 100),
  );
});

// ── idsFromStore ──────────────────────────────────────────────────────────────

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

// ── storageKey + readStore/writeStore ─────────────────────────────────────────

test("storageKey: with/without relayUrl", () => {
  const relay = "wss://relay.example.com";
  assert.equal(
    storageKey("pk1", relay),
    `${storageKeyPrefix}:pk1:${encodeURIComponent(normalizeRelayUrl(relay))}`,
  );
  assert.equal(storageKey("pk1"), `${storageKeyPrefix}:pk1`);
  assert.equal(storageKey("pk1", undefined), `${storageKeyPrefix}:pk1`);
  assert.notEqual(
    storageKey("pk1", "wss://relay-a.example.com"),
    storageKey("pk1", "wss://relay-b.example.com"),
  );
  assert.equal(
    storageKey("pk1", "WSS://Relay.Example/"),
    storageKey("pk1", "wss://relay.example"),
  );
});

test("readChannelStarsStore + writeChannelStarsStore: scoped write/read roundtrip", () => {
  const store = makeStore({ chan1: E(true, 1000, 1) });
  assert.ok(
    writeChannelStarsStore(
      "pk-stars-roundtrip",
      store,
      "wss://relay.example.com",
    ) !== null,
  );
  assert.deepEqual(
    readChannelStarsStore("pk-stars-roundtrip", "wss://relay.example.com"),
    store,
  );
});

test("readChannelStarsStore: scoped key isolated from other relay's data", () => {
  writeChannelStarsStore(
    "pk-stars-isolation",
    makeStore({ cha: E(true, 100, 1) }),
    "wss://relay-a.example.com",
  );
  assert.deepEqual(
    readChannelStarsStore("pk-stars-isolation", "wss://relay-b.example.com"),
    DEFAULT_STORE,
  );
});

test("readChannelStarsStore: migrates legacy unscoped data on first scoped read", () => {
  const legacy = makeStore({ chl: E(true, 500, 2) });
  writeChannelStarsStore("pk-stars-migrate", legacy);
  assert.deepEqual(
    readChannelStarsStore(
      "pk-stars-migrate",
      "wss://relay-migrate.example.com",
    ),
    legacy,
  );
  assert.equal(
    window.localStorage.getItem(storageKey("pk-stars-migrate")),
    null,
  );
  assert.deepEqual(
    readChannelStarsStore(
      "pk-stars-migrate",
      "wss://relay-migrate.example.com",
    ),
    legacy,
  );
});

test("readChannelStarsStore: migration is globally one-time — relay B sees DEFAULT after relay A migrates", () => {
  writeChannelStarsStore(
    "pk-stars-migrate-once",
    makeStore({ chm: E(true, 1, 1) }),
  );
  readChannelStarsStore(
    "pk-stars-migrate-once",
    "wss://relay-a-once.example.com",
  );
  assert.deepEqual(
    readChannelStarsStore(
      "pk-stars-migrate-once",
      "wss://relay-b-once.example.com",
    ),
    DEFAULT_STORE,
  );
});

test("readChannelStarsStore: migration only copies non-empty legacy stores", () => {
  writeChannelStarsStore("pk-stars-migrate-empty", DEFAULT_STORE);
  assert.deepEqual(
    readChannelStarsStore(
      "pk-stars-migrate-empty",
      "wss://relay-empty.example.com",
    ),
    DEFAULT_STORE,
  );
  assert.notEqual(
    window.localStorage.getItem(storageKey("pk-stars-migrate-empty")),
    null,
  );
});

test("readChannelStarsStore: scoped key takes precedence over legacy key", () => {
  const relay = "wss://relay-precedence.example.com";
  writeChannelStarsStore(
    "pk-stars-precedence",
    makeStore({ old: E(true, 1, 1) }),
  );
  const scoped = makeStore({ new: E(true, 2, 1) });
  writeChannelStarsStore("pk-stars-precedence", scoped, relay);
  assert.deepEqual(readChannelStarsStore("pk-stars-precedence", relay), scoped);
});

// ── claimLegacy state machine ─────────────────────────────────────────────────

for (const {
  title,
  pubkey,
  relayA,
  relayB,
  setupFailure,
  assertions,
  assertionsAfterRestore,
} of [
  {
    title: "scoped-write failure returns DEFAULT; relay B still claims legacy",
    pubkey: "pk-stars-migrate-writefail",
    relayA: "wss://relay-a-writefail-stars.example.com",
    relayB: "wss://relay-b-writefail-stars.example.com",
    setupFailure: (ls, scopedA) => {
      const orig = ls.setItem;
      ls.setItem = (k, v) => {
        if (k === scopedA) throw new Error("QuotaExceededError");
        return orig.call(ls, k, v);
      };
      return () => {
        ls.setItem = orig;
      };
    },
    assertions: (pubkey, relayA, relayB, legacy) => {
      assert.deepEqual(readChannelStarsStore(pubkey, relayA), DEFAULT_STORE);
      assert.equal(
        window.localStorage.getItem(storageKey(pubkey, relayA)),
        null,
      );
      assert.notEqual(
        window.localStorage.getItem(storageKey(pubkey)),
        null,
        "legacy not yet deleted",
      );
      assert.deepEqual(readChannelStarsStore(pubkey, relayB), legacy);
      assert.equal(
        window.localStorage.getItem(storageKey(pubkey)),
        null,
        "relay B claims+deletes legacy",
      );
      assert.deepEqual(readChannelStarsStore(pubkey, relayA), DEFAULT_STORE);
    },
  },
  {
    title: "legacy delete no-op rolls back and returns DEFAULT",
    pubkey: "pk-stars-migrate-delfail",
    relayA: "wss://relay-delfail-stars.example.com",
    setupFailure: (ls, _scopedA, legacyKey) => {
      const orig = ls.removeItem;
      ls.removeItem = (k) => {
        if (k === legacyKey) return;
        return orig.call(ls, k);
      };
      return () => {
        ls.removeItem = orig;
      };
    },
    assertions: (pubkey, relayA) => {
      assert.deepEqual(readChannelStarsStore(pubkey, relayA), DEFAULT_STORE);
      assert.equal(
        window.localStorage.getItem(storageKey(pubkey, relayA)),
        null,
      );
    },
    assertionsAfterRestore: (pubkey, relayA, _relayB, legacy) => {
      assert.deepEqual(
        readChannelStarsStore(pubkey, relayA),
        legacy,
        "legacy claimable after storage recovers",
      );
      assert.equal(
        window.localStorage.getItem(storageKey(pubkey)),
        null,
        "legacy deleted by healthy claim",
      );
    },
  },
  {
    title:
      "legacy delete + rollback both throw — DEFAULT until storage recovers",
    pubkey: "pk-stars-migrate-delrollbackthrow",
    relayA: "wss://relay-delrollbackthrow-stars.example.com",
    setupFailure: (ls) => {
      const orig = ls.removeItem;
      ls.removeItem = () => {
        throw new Error("SecurityError");
      };
      return () => {
        ls.removeItem = orig;
      };
    },
    assertions: (pubkey, relayA, _relayB, _legacy, _scopedA, legacyKey) => {
      assert.deepEqual(readChannelStarsStore(pubkey, relayA), DEFAULT_STORE);
      assert.deepEqual(readChannelStarsStore(pubkey, relayA), DEFAULT_STORE);
      assert.notEqual(
        window.localStorage.getItem(legacyKey),
        null,
        "legacy still present",
      );
    },
    assertionsAfterRestore: (pubkey, relayA, _relayB, legacy) => {
      assert.deepEqual(
        readChannelStarsStore(pubkey, relayA),
        legacy,
        "legacy claimable after storage recovers",
      );
    },
  },
  {
    title:
      "legacy delete succeeds; confirmation read throws — scoped copy retained, no data loss",
    pubkey: "pk-stars-migrate-confirmthrow",
    relayA: "wss://relay-confirmthrow-stars.example.com",
    setupFailure: (ls, _scopedA, legacyKey) => {
      const origGet = ls.getItem;
      const origRemove = ls.removeItem;
      let legacyDeleted = false;
      let threwOnce = false;
      ls.removeItem = (k) => {
        if (k === legacyKey) legacyDeleted = true;
        return origRemove.call(ls, k);
      };
      ls.getItem = (k) => {
        if (k === legacyKey && legacyDeleted && !threwOnce) {
          threwOnce = true;
          throw new Error("SecurityError");
        }
        return origGet.call(ls, k);
      };
      return () => {
        ls.getItem = origGet;
        ls.removeItem = origRemove;
      };
    },
    assertions: (pubkey, relayA, _relayB, legacy, scopedA) => {
      assert.deepEqual(readChannelStarsStore(pubkey, relayA), DEFAULT_STORE);
      assert.notEqual(window.localStorage.getItem(scopedA), null);
      assert.equal(window.localStorage.getItem(storageKey(pubkey)), null);
      assert.deepEqual(readChannelStarsStore(pubkey, relayA), legacy);
    },
  },
  {
    title:
      "legacy delete throws while probe stays healthy — rollback, DEFAULT, single future claimant",
    pubkey: "pk-stars-migrate-delthrow-probeok",
    relayA: "wss://relay-delthrow-probeok-stars.example.com",
    setupFailure: (ls, _scopedA, legacyKey) => {
      const orig = ls.removeItem;
      let thrown = false;
      ls.removeItem = (k) => {
        if (k === legacyKey && !thrown) {
          thrown = true;
          throw new Error("SecurityError");
        }
        return orig.call(ls, k);
      };
      return () => {
        ls.removeItem = orig;
      };
    },
    assertions: (pubkey, relayA, _relayB, legacy, scopedA, legacyKey) => {
      assert.deepEqual(readChannelStarsStore(pubkey, relayA), DEFAULT_STORE);
      assert.equal(window.localStorage.getItem(scopedA), null);
      assert.notEqual(window.localStorage.getItem(legacyKey), null);
      assert.deepEqual(readChannelStarsStore(pubkey, relayA), legacy);
      assert.equal(window.localStorage.getItem(legacyKey), null);
    },
  },
  {
    title:
      "delete and probe both throw — scoped kept but hidden while legacy remains",
    pubkey: "pk-stars-migrate-delthrow-probethrow",
    relayA: "wss://relay-delthrow-probethrow-stars.example.com",
    setupFailure: (ls, _scopedA, legacyKey) => {
      const origGet = ls.getItem;
      const origRemove = ls.removeItem;
      let removeAttempted = false;
      ls.removeItem = (k) => {
        if (k === legacyKey) {
          removeAttempted = true;
          throw new Error("SecurityError");
        }
        return origRemove.call(ls, k);
      };
      ls.getItem = (k) => {
        if (k === legacyKey && removeAttempted)
          throw new Error("SecurityError");
        return origGet.call(ls, k);
      };
      return () => {
        ls.getItem = origGet;
        ls.removeItem = origRemove;
      };
    },
    assertions: (pubkey, relayA, _relayB, _legacy, scopedA) => {
      assert.deepEqual(readChannelStarsStore(pubkey, relayA), DEFAULT_STORE);
      assert.notEqual(window.localStorage.getItem(scopedA), null);
      assert.deepEqual(readChannelStarsStore(pubkey, relayA), DEFAULT_STORE);
    },
    assertionsAfterRestore: (
      pubkey,
      relayA,
      _relayB,
      legacy,
      _scopedA,
      legacyKey,
    ) => {
      assert.deepEqual(
        readChannelStarsStore(pubkey, relayA),
        legacy,
        "legacy claimable after storage recovers",
      );
      assert.equal(window.localStorage.getItem(legacyKey), null);
    },
  },
]) {
  test(`claimLegacy: ${title}`, () => {
    const legacy = makeStore({ ch: E(true, 500, 2) });
    writeChannelStarsStore(pubkey, legacy);
    const scopedA = storageKey(pubkey, relayA);
    const legacyKey = storageKey(pubkey);
    const restore = setupFailure(window.localStorage, scopedA, legacyKey);
    try {
      assertions(pubkey, relayA, relayB, legacy, scopedA, legacyKey);
    } finally {
      restore();
    }
    assertionsAfterRestore?.(
      pubkey,
      relayA,
      relayB,
      legacy,
      scopedA,
      legacyKey,
    );
  });
}
