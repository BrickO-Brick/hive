import assert from "node:assert/strict";
import test from "node:test";

import {
  boundChannelSectionsStore,
  DEFAULT_STORE,
  MAX_CHANNEL_SECTION_ASSIGNMENTS,
  MAX_CHANNEL_SECTIONS,
  parseChannelSectionPayload,
  readChannelSectionsStore,
  storageKey,
  stripOrphanedAssignments,
  writeChannelSectionsStore,
} from "./channelSectionsStorage.ts";
import { normalizeRelayUrl } from "@/features/profile/lib/selfProfileStorage";

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

function makeStore(overrides = {}) {
  return {
    version: 1,
    sections: overrides.sections ?? [{ id: "s1", name: "Test", order: 0 }],
    assignments: overrides.assignments ?? {},
    ...overrides,
  };
}
function makeSection(overrides = {}) {
  return { id: "s1", name: "Test", order: 0, ...overrides };
}

// ── parseChannelSectionPayload ────────────────────────────────────────────────

test("parseChannelSectionPayload: valid complete payload returns correct store", () => {
  const payload = {
    version: 1,
    sections: [{ id: "s1", name: "Work", order: 0 }],
    assignments: { chan1: "s1" },
  };
  assert.deepEqual(parseChannelSectionPayload(payload), payload);
});

for (const [title, input] of [
  ["null input", null],
  ["string input", "string"],
  ["number input", 42],
]) {
  test(`parseChannelSectionPayload: ${title} returns null`, () =>
    assert.equal(parseChannelSectionPayload(input), null));
}

// Carl P1.2: a future schema version must not be accepted as v1 state.
test("parseChannelSectionPayload: unsupported version returns null", () => {
  assert.equal(
    parseChannelSectionPayload({ version: 2, sections: [], assignments: {} }),
    null,
    "version 2 rejected",
  );
  assert.equal(
    parseChannelSectionPayload({ sections: [], assignments: {} }),
    null,
    "missing version rejected",
  );
  assert.equal(
    parseChannelSectionPayload({ version: 0, sections: [], assignments: {} }),
    null,
    "version 0 rejected",
  );
});

test("parseChannelSectionPayload: missing sections returns empty sections array", () => {
  assert.deepEqual(
    parseChannelSectionPayload({ version: 1, assignments: {} })?.sections,
    [],
  );
});

test("parseChannelSectionPayload: malformed section entries are filtered out", () => {
  const result = parseChannelSectionPayload({
    version: 1,
    sections: [
      { id: 123, name: "Bad ID", order: 0 },
      { id: "s1", name: 456, order: 0 },
      { id: "s2", name: "Good", order: "not-a-number" },
      null,
      "string-entry",
    ],
    assignments: {},
  });
  assert.deepEqual(result?.sections, []);
});

test("parseChannelSectionPayload: valid sections with some invalid ones filters correctly", () => {
  const result = parseChannelSectionPayload({
    version: 1,
    sections: [
      { id: "s1", name: "Valid", order: 0 },
      { id: 99, name: "Bad ID", order: 1 },
      { id: "s2", name: "Also Valid", order: 2 },
    ],
    assignments: {},
  });
  assert.deepEqual(result?.sections, [
    { id: "s1", name: "Valid", order: 0 },
    { id: "s2", name: "Also Valid", order: 2 },
  ]);
});

test("parseChannelSectionPayload: missing assignments returns empty assignments object", () =>
  assert.deepEqual(
    parseChannelSectionPayload({ version: 1, sections: [] })?.assignments,
    {},
  ));

test("parseChannelSectionPayload: assignments with non-string values are filtered out", () => {
  const result = parseChannelSectionPayload({
    version: 1,
    sections: [makeSection()],
    assignments: { chan1: "s1", chan2: 42, chan3: null, chan4: true },
  });
  assert.deepEqual(result?.assignments, { chan1: "s1" });
});

test("parseChannelSectionPayload: orphaned assignments are stripped", () => {
  const result = parseChannelSectionPayload({
    version: 1,
    sections: [{ id: "s1", name: "Exists", order: 0 }],
    assignments: { chan1: "s1", chan2: "missing-section" },
  });
  assert.deepEqual(result?.assignments, { chan1: "s1" });
});

test("parseChannelSectionPayload: preserves icon field; omits icon when empty or whitespace", () => {
  const withIcon = parseChannelSectionPayload({
    version: 1,
    sections: [{ id: "s1", name: "Work", icon: "🚀", order: 0 }],
    assignments: { chan1: "s1" },
  });
  assert.deepEqual(withIcon, {
    version: 1,
    sections: [{ id: "s1", name: "Work", icon: "🚀", order: 0 }],
    assignments: { chan1: "s1" },
  });
  const emptyIcons = parseChannelSectionPayload({
    version: 1,
    sections: [
      { id: "s1", name: "A", icon: "", order: 0 },
      { id: "s2", name: "B", icon: "   ", order: 1 },
      { id: "s3", name: "C", order: 2 },
    ],
    assignments: {},
  });
  assert.deepEqual(emptyIcons?.sections, [
    { id: "s1", name: "A", order: 0 },
    { id: "s2", name: "B", order: 1 },
    { id: "s3", name: "C", order: 2 },
  ]);
});

// ── stripOrphanedAssignments ──────────────────────────────────────────────────

for (const [title, store, expectSame] of [
  [
    "no orphans returns same reference",
    makeStore({
      sections: [makeSection({ id: "s1" })],
      assignments: { chan1: "s1" },
    }),
    true,
  ],
  [
    "all valid assignments returns same reference",
    makeStore({
      sections: [
        makeSection({ id: "s1" }),
        makeSection({ id: "s2", name: "B", order: 1 }),
      ],
      assignments: { chan1: "s1", chan2: "s2" },
    }),
    true,
  ],
  [
    "empty store returns same reference",
    makeStore({ sections: [], assignments: {} }),
    true,
  ],
]) {
  test(`stripOrphanedAssignments: ${title}`, () =>
    assert.equal(stripOrphanedAssignments(store), store));
}

test("stripOrphanedAssignments: orphaned assignments returns new object without them", () => {
  const store = makeStore({
    sections: [makeSection({ id: "s1" })],
    assignments: { chan1: "s1", chan2: "ghost" },
  });
  const result = stripOrphanedAssignments(store);
  assert.notEqual(result, store);
  assert.deepEqual(result.assignments, { chan1: "s1" });
});

// ── boundChannelSectionsStore ─────────────────────────────────────────────────

test("boundChannelSectionsStore caps sections and assignments", () => {
  const sections = Array.from({ length: MAX_CHANNEL_SECTIONS + 1 }, (_, i) =>
    makeSection({ id: `section-${i}`, order: i }),
  );
  const assignments = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_SECTION_ASSIGNMENTS + 1 }, (_, i) => [
      `channel-${i}`,
      "section-100",
    ]),
  );
  const bounded = boundChannelSectionsStore(
    makeStore({ sections, assignments }),
  );
  assert.equal(bounded.sections.length, MAX_CHANNEL_SECTIONS);
  assert.equal(
    bounded.sections.some((s) => s.id === "section-0"),
    false,
  );
  assert.equal(
    Object.keys(bounded.assignments).length,
    MAX_CHANNEL_SECTION_ASSIGNMENTS,
  );
  assert.equal(bounded.assignments["channel-0"], undefined);
});

// ── writeChannelSectionsStore + readChannelSectionsStore ──────────────────────

test("write + read: legacy (no relay) roundtrip", () => {
  const store = makeStore({
    sections: [makeSection({ id: "s1", name: "Work", order: 0 })],
    assignments: { chan1: "s1" },
  });
  assert.equal(writeChannelSectionsStore("pk-roundtrip", store), true);
  assert.deepEqual(readChannelSectionsStore("pk-roundtrip"), store);
});

for (const [title, pubkey, setupFn, expected] of [
  [
    "non-existent key returns DEFAULT_STORE",
    "pk-does-not-exist-xyz",
    () => {},
    DEFAULT_STORE,
  ],
  [
    "corrupt JSON returns DEFAULT_STORE",
    "pk-corrupt",
    (pk) => window.localStorage.setItem(storageKey(pk), "not-valid-json{{{"),
    DEFAULT_STORE,
  ],
  [
    "wrong version returns DEFAULT_STORE",
    "pk-wrong-version",
    (pk) =>
      window.localStorage.setItem(
        storageKey(pk),
        JSON.stringify({ version: 2, sections: [], assignments: {} }),
      ),
    DEFAULT_STORE,
  ],
]) {
  test(`readChannelSectionsStore: ${title}`, () => {
    setupFn(pubkey);
    assert.deepEqual(readChannelSectionsStore(pubkey), expected);
  });
}

test("writeChannelSectionsStore: returns false when setItem throws", () => {
  const original = window.localStorage.setItem;
  window.localStorage.setItem = () => {
    throw new Error("storage full");
  };
  try {
    assert.equal(writeChannelSectionsStore("pk-throws", makeStore()), false);
  } finally {
    window.localStorage.setItem = original;
  }
});

// ── storageKey ────────────────────────────────────────────────────────────────

test("storageKey: format and relay normalization", () => {
  assert.equal(storageKey("abc123"), "buzz-channel-sections.v1:abc123");
  const relay = "wss://relay.example.com";
  assert.equal(
    storageKey("pk1", relay),
    `buzz-channel-sections.v1:pk1:${encodeURIComponent(normalizeRelayUrl(relay))}`,
  );
  assert.equal(storageKey("pk1"), "buzz-channel-sections.v1:pk1");
  assert.equal(storageKey("pk1", undefined), "buzz-channel-sections.v1:pk1");
  assert.notEqual(
    storageKey("pk1", "wss://relay-a.example.com"),
    storageKey("pk1", "wss://relay-b.example.com"),
  );
  assert.equal(
    storageKey("pk1", "WSS://Relay.Example/"),
    storageKey("pk1", "wss://relay.example"),
  );
});

// ── Relay-scoped key tests ────────────────────────────────────────────────────

test("scoped write/read roundtrip", () => {
  const store = makeStore({
    sections: [makeSection({ id: "s1", name: "Work", order: 0 })],
    assignments: { chan1: "s1" },
  });
  assert.equal(
    writeChannelSectionsStore(
      "pk-relay-roundtrip",
      store,
      "wss://relay.example.com",
    ),
    true,
  );
  assert.deepEqual(
    readChannelSectionsStore("pk-relay-roundtrip", "wss://relay.example.com"),
    store,
  );
});

test("scoped key isolated from other relay's data", () => {
  const storeA = makeStore({
    sections: [makeSection({ id: "sa", name: "A", order: 0 })],
    assignments: {},
  });
  writeChannelSectionsStore(
    "pk-isolation",
    storeA,
    "wss://relay-a.example.com",
  );
  assert.deepEqual(
    readChannelSectionsStore("pk-isolation", "wss://relay-b.example.com"),
    DEFAULT_STORE,
  );
});

test("migrates legacy unscoped data on first scoped read; globally one-time", () => {
  const legacyStore = makeStore({
    sections: [makeSection({ id: "sl", name: "Legacy", order: 0 })],
    assignments: {},
  });
  writeChannelSectionsStore("pk-migrate", legacyStore);
  assert.deepEqual(
    readChannelSectionsStore("pk-migrate", "wss://relay-migrate.example.com"),
    legacyStore,
  );
  assert.equal(
    window.localStorage.getItem(storageKey("pk-migrate")),
    null,
    "legacy key deleted after migration",
  );
  assert.deepEqual(
    readChannelSectionsStore("pk-migrate", "wss://relay-migrate.example.com"),
    legacyStore,
  );
  // Relay B must see DEFAULT_STORE — legacy data must not bleed in.
  writeChannelSectionsStore(
    "pk-migrate-once",
    makeStore({
      sections: [makeSection({ id: "sm", name: "M", order: 0 })],
      assignments: {},
    }),
  );
  readChannelSectionsStore(
    "pk-migrate-once",
    "wss://relay-migrate-once-a.example.com",
  );
  assert.deepEqual(
    readChannelSectionsStore(
      "pk-migrate-once",
      "wss://relay-migrate-once-b.example.com",
    ),
    DEFAULT_STORE,
  );
});

test("migration only copies non-empty legacy stores", () => {
  writeChannelSectionsStore("pk-migrate-empty", DEFAULT_STORE);
  assert.deepEqual(
    readChannelSectionsStore(
      "pk-migrate-empty",
      "wss://relay-migrate-empty.example.com",
    ),
    DEFAULT_STORE,
  );
});

test("scoped key takes precedence over legacy key after migration", () => {
  const relay = "wss://relay-precedence.example.com";
  writeChannelSectionsStore(
    "pk-precedence",
    makeStore({ sections: [makeSection({ id: "sold" })], assignments: {} }),
  );
  const newStore = makeStore({
    sections: [makeSection({ id: "snew", name: "New", order: 0 })],
    assignments: {},
  });
  writeChannelSectionsStore("pk-precedence", newStore, relay);
  assert.deepEqual(readChannelSectionsStore("pk-precedence", relay), newStore);
});

// NOTE: The seven migration-failure cases test the claimLegacy state machine from
// mergeLaneStorage.shared.ts, exercised in full by mergeLaneStorage.shared.test.mjs.
// The sections adapter uses that shared implementation via import, so duplicate
// coverage adds no mutation surface.
