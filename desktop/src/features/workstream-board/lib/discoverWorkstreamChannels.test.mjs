import assert from "node:assert/strict";
import test from "node:test";

import {
  filterWorkstreamChannels,
  WORKSTREAM_CHANNEL_PREFIX,
} from "./discoverWorkstreamChannels.ts";

function buildChannel(overrides) {
  return {
    id: overrides.id ?? "channel-id",
    name: overrides.name,
    channelType: "stream",
    visibility: "open",
    description: "",
    topic: null,
    purpose: null,
    memberCount: overrides.memberPubkeys?.length ?? 0,
    memberPubkeys: overrides.memberPubkeys ?? [],
    lastMessageAt: null,
    archivedAt: null,
    participants: [],
    participantPubkeys: [],
    isMember: overrides.isMember ?? false,
    ttlSeconds: null,
    ttlDeadline: null,
  };
}

test("prefix constant matches the contract-specified prefix", () => {
  assert.equal(WORKSTREAM_CHANNEL_PREFIX, "loganj-ws-");
});

test("includes channels whose name starts exactly with the prefix", () => {
  const channels = [
    buildChannel({ id: "1", name: "loganj-ws-canvas-cards" }),
    buildChannel({ id: "2", name: "general" }),
  ];

  const result = filterWorkstreamChannels(channels);
  assert.deepEqual(
    result.map((c) => c.id),
    ["1"],
  );
});

test("excludes channels that merely contain the prefix mid-name", () => {
  const channels = [
    buildChannel({ id: "1", name: "not-loganj-ws-canvas-cards" }),
    buildChannel({ id: "2", name: "loganj-ws-canvas-cards" }),
  ];

  const result = filterWorkstreamChannels(channels);
  assert.deepEqual(
    result.map((c) => c.id),
    ["2"],
  );
});

test("excludes a near-miss name missing the trailing hyphen", () => {
  const channels = [
    buildChannel({ id: "1", name: "loganj-ws" }),
    buildChannel({ id: "2", name: "loganj-ws-" }),
  ];

  const result = filterWorkstreamChannels(channels);
  assert.deepEqual(
    result.map((c) => c.id),
    ["2"],
  );
});

test("applies no creator/membership filter — every matching name is included regardless of who created or joined it", () => {
  const channels = [
    // Different member sets stand in for "different creators" — the Channel
    // type carries no creator field on the list endpoint, so membership
    // overlap is the only axis available to prove no ownership filtering.
    buildChannel({
      id: "mine",
      name: "loganj-ws-mine",
      isMember: true,
      memberPubkeys: ["aa"],
    }),
    buildChannel({
      id: "someone-elses",
      name: "loganj-ws-someone-elses",
      isMember: false,
      memberPubkeys: ["bb", "cc"],
    }),
    buildChannel({
      id: "no-members",
      name: "loganj-ws-empty",
      isMember: false,
      memberPubkeys: [],
    }),
  ];

  const result = filterWorkstreamChannels(channels);
  assert.deepEqual(result.map((c) => c.id).sort(), [
    "mine",
    "no-members",
    "someone-elses",
  ]);
});

test("returns an empty array when nothing matches", () => {
  const channels = [
    buildChannel({ id: "1", name: "general" }),
    buildChannel({ id: "2", name: "random" }),
  ];

  assert.deepEqual(filterWorkstreamChannels(channels), []);
});

test("returns an empty array for an empty channel list", () => {
  assert.deepEqual(filterWorkstreamChannels([]), []);
});
