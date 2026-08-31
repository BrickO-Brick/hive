import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { relayClient } from "@/shared/api/relayClient";
import { readChannelSortOutbox } from "./channelSortPreference.ts";
import { ChannelSortSyncManager } from "./channelSortSync.ts";
import {
  makeFakeWindow,
  installFakeWindow,
  installTauriMock,
  installEchoTauri,
} from "./sidebarSyncTestHelpers.mjs";

// Shared whole-blob engine invariants are covered by wholeBlobSync.shared.test.mjs.
// This file covers only sort-specific adapter and lane behavior.

function makeStore(groups = {}) {
  return { version: 1, groups };
}
const RELAY = "wss://r.test";

// Mutation: removing `version !== 1` check from parseChannelSortPayload accepts
// the v2 blob as v1 state; the manager falls through to a publish that overwrites
// authoritative state.
test("unsupported head payload version retains the pending edit, never publishing", async () => {
  mock.method(relayClient, "fetchEvents", () =>
    Promise.resolve([
      {
        pubkey: "pk-badver",
        content: "good-cipher",
        created_at: 500,
        id: "evt-badver",
      },
    ]),
  );
  const publishCalls = [];
  mock.method(relayClient, "publishEvent", (...args) => {
    publishCalls.push(args);
    return Promise.resolve();
  });
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  const tauri = installTauriMock(JSON.stringify({ version: 2, groups: {} }));
  try {
    const manager = new ChannelSortSyncManager("pk-badver", RELAY);
    manager.publishSortPrefs(makeStore({ channels: "recent" }));
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      publishCalls.length,
      0,
      "must not publish over unsupported version",
    );
    assert.ok(
      manager.getPendingStore() !== null,
      "unsupported head retains pending edit",
    );
    assert.ok(fw._hasTimer(), "retry scheduled");
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// Mutation: reverting the reconnect handler to publishSortPrefs(pending) resets
// the baseline to the just-fetched head, so the pre-publish check sees no
// advancement and publishes the stale edit over the remote.
test("reconnect adopts a remote that advanced while the edit was pending, never publishing over it", async () => {
  const REMOTE_KEY = "remote-group-won-lww";
  let call = 0;
  mock.method(relayClient, "fetchEvents", () => {
    call++;
    return Promise.resolve([
      {
        pubkey: "pk-recon",
        content: "good-cipher",
        created_at: call === 1 ? 100 : 200,
        id: call === 1 ? "evt-100" : "evt-200",
      },
    ]);
  });
  const publishCalls = [];
  mock.method(relayClient, "publishEvent", (...args) => {
    publishCalls.push(args);
    return Promise.resolve();
  });
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  const tauri = installTauriMock(
    JSON.stringify({ version: 1, groups: { [REMOTE_KEY]: "recent" } }),
  );
  try {
    const manager = new ChannelSortSyncManager("pk-recon", RELAY);
    const adopted = [];
    manager.setOnRemoteAdopted((r) => adopted.push(r));
    await manager.fetchRemoteSortPrefs();
    manager.publishSortPrefs(makeStore({ "local-group": "recent" }));
    await manager.fetchRemoteSortPrefs();
    manager.retryPendingPublish();
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      publishCalls.length,
      0,
      "must adopt the advanced remote, never publish",
    );
    assert.equal(adopted.length, 1, "advanced remote adopted");
    assert.ok(
      REMOTE_KEY in adopted[0].store.groups,
      "adopted store is the remote that won LWW",
    );
    assert.equal(
      manager.getPendingStore(),
      null,
      "losing pending edit cleared on adopt",
    );
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// Mutation: dropping writeChannelSortOutbox leaves the outbox null → no resume.
test("durable outbox: edit destroyed inside the debounce resumes and publishes on remount", async () => {
  let storedHead = [];
  mock.method(relayClient, "fetchEvents", () => Promise.resolve(storedHead));
  const publishCalls = [];
  mock.method(relayClient, "publishEvent", (event) => {
    publishCalls.push(event);
    storedHead = [event];
    return Promise.resolve();
  });
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  const tauri = installEchoTauri("pk-resume");
  try {
    const m1 = new ChannelSortSyncManager("pk-resume", RELAY);
    m1.publishSortPrefs(makeStore({ channels: "recent" }));
    const persisted = readChannelSortOutbox("pk-resume", RELAY);
    assert.ok(persisted !== null, "edit persisted before teardown");
    m1.destroy();
    assert.equal(publishCalls.length, 0, "destroy must not flush");
    const m2 = new ChannelSortSyncManager("pk-resume", RELAY);
    m2.publishSortPrefs(persisted.store);
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(publishCalls.length, 1, "resumed edit must publish");
    assert.equal(
      readChannelSortOutbox("pk-resume", RELAY),
      null,
      "outbox cleared after publish",
    );
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// Mutation: reverting scheduleRetry to a bare console.warn leaves pending null.
test("failed publish retries the retained edit without a later edit", async () => {
  let storedHead = [];
  mock.method(relayClient, "fetchEvents", () => Promise.resolve(storedHead));
  let attempts = 0;
  mock.method(relayClient, "publishEvent", (event) => {
    attempts++;
    if (attempts === 1) return Promise.reject(new Error("socket timeout"));
    storedHead = [event];
    return Promise.resolve();
  });
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  const tauri = installEchoTauri("pk-retry");
  try {
    const manager = new ChannelSortSyncManager("pk-retry", RELAY);
    manager.publishSortPrefs(makeStore({ channels: "recent" }));
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(attempts, 1, "first publish rejected");
    assert.ok(
      manager.getPendingStore() !== null,
      "failed publish retains pending edit",
    );
    assert.ok(fw._hasTimer(), "bounded-backoff retry scheduled");
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(attempts, 2, "retry re-attempts the publish");
    assert.equal(
      manager.getPendingStore(),
      null,
      "successful retry clears pending",
    );
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});
