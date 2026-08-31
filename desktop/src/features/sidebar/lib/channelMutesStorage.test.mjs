// Compact mutes lane adapter contract.
// Full merge-lane storage invariants are covered by mergeLaneStorage.shared.test.mjs.
// This file proves only the mutes-specific wiring: correct value field name,
// storage key prefix, and id projection — catches copy/paste field miswiring.

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseMutePayload,
  mutedChannelIdsFromStore,
  storageKey,
} from "./channelMutesStorage.ts";

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
