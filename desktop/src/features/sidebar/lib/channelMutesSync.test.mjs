// Compact wire-contract adapter for ChannelMuteSyncManager.
// Shared merge-lane sync engine invariants are covered by mergeLaneSync.shared.test.mjs,
// which runs directly against ChannelStarSyncManager (same engine, different config).
// This file asserts only the mutes-specific wiring: event kind, d-tag, serialized
// payload shape, parser delegation, subsumption, and typed API.

import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { relayClient } from "@/shared/api/relayClient";
import {
  isMutesStoreSubsumedBy,
  parseMutePayload,
  readChannelMutesOutbox,
  writeChannelMutesOutbox,
} from "./channelMutesStorage.ts";
import { ChannelMuteSyncManager } from "./channelMutesSync.ts";
import {
  installEchoTauri,
  installFakeWindow,
  makeFakeWindow,
} from "./sidebarSyncTestHelpers.mjs";

const RELAY = "wss://r.test";

test("mutes wire: kind=30078, d-tag='channel-mutes', payload has 'channels' not 'sections'", async () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  let publishedEvent = null;
  mock.method(relayClient, "publishEvent", (evt) => {
    publishedEvent = evt;
    return Promise.resolve();
  });
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  const tauri = installEchoTauri("pk-wire-mutes");
  try {
    const m = new ChannelMuteSyncManager("pk-wire-mutes", RELAY);
    m.publishMutes({
      version: 1,
      channels: { ch1: { muted: true, updatedAt: 1, rev: 0 } },
    });
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(publishedEvent !== null, "publish must have been called");
    assert.equal(publishedEvent.kind, 30078, "kind must be 30078");
    const dTag = publishedEvent.tags.find((t) => t[0] === "d")?.[1];
    assert.equal(
      dTag,
      "channel-mutes",
      "d-tag must be 'channel-mutes' not 'channel-stars'",
    );
    // Plaintext must serialize 'channels' field.
    const plaintext = tauri.capturedPlaintext();
    const parsed = JSON.parse(plaintext);
    assert.ok("channels" in parsed, "payload must have 'channels' field");
    assert.ok(!("sections" in parsed), "payload must not have 'sections'");
    m.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

test("mutes wire: parser delegates to parseMutePayload (muted field, rejects starred)", () => {
  const valid = {
    version: 1,
    channels: { a: { muted: true, updatedAt: 1, rev: 0 } },
  };
  const parsed = parseMutePayload(valid);
  assert.ok(parsed !== null, "valid mute payload parses");
  assert.equal(parsed.channels.a.muted, true, "muted field present");
  const starPayload = {
    version: 1,
    channels: { a: { starred: true, updatedAt: 1, rev: 0 } },
  };
  const rejected = parseMutePayload(starPayload);
  assert.deepEqual(
    rejected?.channels ?? {},
    {},
    "starred entry rejected by mutes parser",
  );
});

test("mutes wire: outbox/subsumption callbacks are wired to mutes storage", () => {
  const store = {
    version: 1,
    channels: { ch: { muted: true, updatedAt: 100, rev: 1 } },
  };
  writeChannelMutesOutbox("pk-wiring-m", store, RELAY);
  assert.ok(
    readChannelMutesOutbox("pk-wiring-m", RELAY) !== null,
    "writeChannelMutesOutbox wired",
  );
  const head = {
    version: 1,
    channels: { ch: { muted: false, updatedAt: 200, rev: 2 } },
  };
  assert.ok(
    isMutesStoreSubsumedBy(store, head),
    "isMutesStoreSubsumedBy wired",
  );
});

test("mutes wire: typed API (publishMutes, getPendingMuteStore, fetchRemoteMutes, cancelPendingMutePublish)", () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const m = new ChannelMuteSyncManager("pk-api-m", RELAY);
    assert.equal(m.getPendingMuteStore(), null, "no pending initially");
    m.publishMutes({
      version: 1,
      channels: { c: { muted: true, updatedAt: 1, rev: 0 } },
    });
    assert.ok(m.getPendingMuteStore() !== null, "publishMutes sets pending");
    m.cancelPendingMutePublish();
    assert.ok(
      typeof m.cancelPendingMutePublish === "function",
      "cancelPendingMutePublish is callable",
    );
    assert.ok(
      typeof m.fetchRemoteMutes === "function",
      "fetchRemoteMutes exists",
    );
    m.destroy();
  } finally {
    restore();
    mock.reset();
  }
});
