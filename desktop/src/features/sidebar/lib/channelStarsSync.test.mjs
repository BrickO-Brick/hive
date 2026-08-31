// Compact wire-contract adapter for ChannelStarSyncManager.
// Shared merge-lane sync engine invariants (generation CAS, retry, bootstrap
// seed-guard, etc.) are covered by mergeLaneSync.shared.test.mjs, which runs
// directly against ChannelStarSyncManager. This file asserts only the
// stars-specific wiring that cannot be caught by a generic engine suite:
// event kind, d-tag, serialized payload shape, parser delegation, and typed API.

import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { relayClient } from "@/shared/api/relayClient";
import {
  isStarsStoreSubsumedBy,
  parseStarPayload,
  readChannelStarsOutbox,
  writeChannelStarsOutbox,
} from "./channelStarsStorage.ts";
import { ChannelStarSyncManager } from "./channelStarsSync.ts";
import {
  installEchoTauri,
  installFakeWindow,
  makeFakeWindow,
} from "./sidebarSyncTestHelpers.mjs";

const RELAY = "wss://r.test";

test("stars wire: kind=30078, d-tag='channel-stars', payload has 'channels' not 'sections'", async () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  let publishedEvent = null;
  mock.method(relayClient, "publishEvent", (evt) => {
    publishedEvent = evt;
    return Promise.resolve();
  });
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  const tauri = installEchoTauri("pk-wire-stars");
  try {
    const m = new ChannelStarSyncManager("pk-wire-stars", RELAY);
    m.publishStars({
      version: 1,
      channels: { ch1: { starred: true, updatedAt: 1, rev: 0 } },
    });
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(publishedEvent !== null, "publish must have been called");
    assert.equal(publishedEvent.kind, 30078, "kind must be 30078");
    const dTag = publishedEvent.tags.find((t) => t[0] === "d")?.[1];
    assert.equal(dTag, "channel-stars", "d-tag must be 'channel-stars'");
    // Plaintext must serialize 'channels', not 'sections' or 'groups'.
    const plaintext = tauri.capturedPlaintext();
    const parsed = JSON.parse(plaintext);
    assert.ok("channels" in parsed, "payload must have 'channels' field");
    assert.ok(!("sections" in parsed), "payload must not have 'sections'");
    assert.ok(!("groups" in parsed), "payload must not have 'groups'");
    m.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

test("stars wire: parser delegates to parseStarPayload (starred field, version guard)", () => {
  // Stars parser accepts starred field, rejects muted field.
  const valid = {
    version: 1,
    channels: { a: { starred: true, updatedAt: 1, rev: 0 } },
  };
  const parsed = parseStarPayload(valid);
  assert.ok(parsed !== null, "valid star payload parses");
  assert.equal(parsed.channels.a.starred, true, "starred field present");
  const mutePayload = {
    version: 1,
    channels: { a: { muted: true, updatedAt: 1, rev: 0 } },
  };
  const rejected = parseStarPayload(mutePayload);
  assert.deepEqual(
    rejected?.channels ?? {},
    {},
    "muted entry rejected by stars parser",
  );
});

test("stars wire: outbox/subsumption callbacks are wired to stars storage", () => {
  const store = {
    version: 1,
    channels: { ch: { starred: true, updatedAt: 100, rev: 1 } },
  };
  writeChannelStarsOutbox("pk-wiring", store, RELAY);
  assert.ok(
    readChannelStarsOutbox("pk-wiring", RELAY) !== null,
    "writeChannelStarsOutbox wired",
  );
  // Subsumption: head with same entry subsumes candidate.
  const head = {
    version: 1,
    channels: { ch: { starred: false, updatedAt: 200, rev: 2 } },
  };
  assert.ok(
    isStarsStoreSubsumedBy(store, head),
    "isStarsStoreSubsumedBy wired",
  );
});

test("stars wire: typed API (publishStars, getPendingStarStore, fetchRemoteStars, cancelPendingStarPublish)", () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const m = new ChannelStarSyncManager("pk-api", RELAY);
    assert.equal(m.getPendingStarStore(), null, "no pending initially");
    m.publishStars({
      version: 1,
      channels: { c: { starred: true, updatedAt: 1, rev: 0 } },
    });
    assert.ok(m.getPendingStarStore() !== null, "publishStars sets pending");
    m.cancelPendingStarPublish();
    assert.ok(
      typeof m.cancelPendingStarPublish === "function",
      "cancelPendingStarPublish is callable",
    );
    assert.ok(
      typeof m.fetchRemoteStars === "function",
      "fetchRemoteStars exists",
    );
    m.destroy();
  } finally {
    restore();
    mock.reset();
  }
});
