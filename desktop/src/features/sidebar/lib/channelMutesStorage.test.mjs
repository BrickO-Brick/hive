// Compact mutes lane adapter contract.
// Full merge-lane storage invariants are covered by mergeLaneStorage.shared.test.mjs.
// This file proves only the mutes-specific wiring: correct value field name,
// storage key prefix, id projection — catches copy/paste field miswiring —
// PLUS the duplicated mutes algebra (mergeStores, boundMuteStore,
// isMutesStoreSubsumedBy) that is NOT exercised by the stars-based shared suite.

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CHANNEL_MUTE_ENTRIES,
  boundMuteStore,
  isMutesStoreSubsumedBy,
  mergeStores,
  mutedChannelIdsFromStore,
  parseMutePayload,
  storageKey,
} from "./channelMutesStorage.ts";

// ─── Wire-contract: value field, key prefix, id projection ───────────────────

test("mutes adapter: value field is 'muted', key prefix is buzz-channel-mutes.v1", () => {
  const raw = {
    version: 1,
    channels: { a: { muted: true, updatedAt: 100, rev: 1 } },
  };
  const parsed = parseMutePayload(raw);
  assert.ok(parsed !== null, "valid mutes payload parses");
  assert.equal(parsed.channels.a.muted, true, "muted field preserved");
  assert.equal(
    storageKey("pk1"),
    "buzz-channel-mutes.v1:pk1",
    "storage key prefix",
  );
});

test("mutes adapter: idsFromStore projects muted=true entries", () => {
  const store = {
    version: 1,
    channels: {
      a: { muted: true, updatedAt: 1, rev: 0 },
      b: { muted: false, updatedAt: 2, rev: 0 },
    },
  };
  const ids = mutedChannelIdsFromStore(store);
  assert.ok(ids.has("a"), "muted channel in set");
  assert.ok(!ids.has("b"), "unmuted channel excluded");
});

test("mutes adapter: wrong value field (starred) is rejected by parser", () => {
  const starPayload = {
    version: 1,
    channels: { a: { starred: true, updatedAt: 100, rev: 1 } },
  };
  const result = parseMutePayload(starPayload);
  assert.deepEqual(
    result?.channels ?? {},
    {},
    "starred entry filtered as malformed",
  );
});

// ─── Duplicated mutes algebra: mergeStores order ─────────────────────────────
// These laws hold in channelStarsStorage too (exercised by mergeLaneStorage.shared),
// but the implementations are independent — a mute-specific copy-paste error
// cannot be caught by the stars suite.

function muteStore(channels) {
  return { version: 1, channels };
}
function muteEntry(muted, updatedAt, rev = 0) {
  return { muted, updatedAt, rev };
}

for (const { title, a, b, expected } of [
  {
    title: "later updatedAt wins regardless of muted value",
    a: muteStore({ ch: muteEntry(true, 100, 0) }),
    b: muteStore({ ch: muteEntry(false, 200, 0) }),
    expected: { ch: muteEntry(false, 200, 0) },
  },
  {
    title: "equal updatedAt: higher rev wins",
    a: muteStore({ ch: muteEntry(true, 100, 1) }),
    b: muteStore({ ch: muteEntry(false, 100, 2) }),
    expected: { ch: muteEntry(false, 100, 2) },
  },
  {
    title: "full tie (equal updatedAt and rev): muted=true wins",
    a: muteStore({ ch: muteEntry(false, 100, 1) }),
    b: muteStore({ ch: muteEntry(true, 100, 1) }),
    expected: { ch: muteEntry(true, 100, 1) },
  },
  {
    title: "old-build rev=0 loses to new-build rev=1 at same second",
    a: muteStore({ ch: muteEntry(true, 100, 0) }),
    b: muteStore({ ch: muteEntry(false, 100, 1) }),
    expected: { ch: muteEntry(false, 100, 1) },
  },
  {
    title: "mergeStores is commutative",
    a: muteStore({ ch: muteEntry(true, 100, 3) }),
    b: muteStore({ ch: muteEntry(false, 200, 1) }),
    expected: { ch: muteEntry(false, 200, 1) },
  },
]) {
  test(`mutes mergeStores: ${title}`, () => {
    const ab = mergeStores(a, b);
    const ba = mergeStores(b, a);
    assert.deepEqual(ab.channels, expected, "a∪b");
    assert.deepEqual(ba.channels, expected, "b∪a (commutative)");
  });
}

// ─── Duplicated mutes algebra: boundMuteStore capacity + preserved key ───────

test("mutes boundMuteStore: caps at MAX_CHANNEL_MUTE_ENTRIES, retains newest", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_MUTE_ENTRIES + 2 }, (_, i) => [
      `ch${String(i).padStart(4, "0")}`,
      muteEntry(true, i, 0),
    ]),
  );
  const bounded = boundMuteStore({ version: 1, channels });
  assert.equal(
    Object.keys(bounded.channels).length,
    MAX_CHANNEL_MUTE_ENTRIES,
    "capped at limit",
  );
  // Oldest two (updatedAt 0 and 1) should be evicted.
  assert.ok(!bounded.channels["ch0000"], "oldest evicted");
  assert.ok(!bounded.channels["ch0001"], "second-oldest evicted");
});

test("mutes boundMuteStore: preserved key survives even when oldest", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_MUTE_ENTRIES + 1 }, (_, i) => [
      `ch${String(i).padStart(4, "0")}`,
      muteEntry(true, i, 0),
    ]),
  );
  const preservedKey = "ch0000"; // updatedAt=0, would normally be evicted
  const bounded = boundMuteStore({ version: 1, channels }, preservedKey);
  assert.ok(bounded.channels[preservedKey], "preserved key always retained");
  assert.equal(
    Object.keys(bounded.channels).length,
    MAX_CHANNEL_MUTE_ENTRIES,
    "still capped at limit",
  );
});

// ─── Duplicated mutes algebra: subsumption ───────────────────────────────────

test("mutes isMutesStoreSubsumedBy: head subsumes candidate when it carries strictly newer state", () => {
  const candidate = muteStore({ ch: muteEntry(true, 100, 1) });
  const head = muteStore({ ch: muteEntry(false, 200, 2) });
  assert.ok(
    isMutesStoreSubsumedBy(candidate, head),
    "head subsumes older candidate",
  );
});

test("mutes isMutesStoreSubsumedBy: head does NOT subsume candidate when candidate has newer state", () => {
  const candidate = muteStore({ ch: muteEntry(true, 300, 5) });
  const head = muteStore({ ch: muteEntry(false, 200, 2) });
  assert.ok(
    !isMutesStoreSubsumedBy(candidate, head),
    "newer candidate not subsumed",
  );
});

test("mutes isMutesStoreSubsumedBy: head subsumes candidate when identical", () => {
  const store = muteStore({ ch: muteEntry(true, 100, 1) });
  assert.ok(isMutesStoreSubsumedBy(store, store), "identical is subsumed");
});
