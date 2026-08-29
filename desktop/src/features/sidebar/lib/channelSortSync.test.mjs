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
import { runWholeBlobSyncSuite } from "./wholeBlobSync.shared.test.mjs";

function makeStore(groups = {}) {
  return { version: 1, groups };
}

const RELAY = "wss://r.test";
const RELAY_KEY = encodeURIComponent(RELAY);

// ─── 17 shared whole-blob sync invariants ─────────────────────────────────────

runWholeBlobSyncSuite({
  label: "sort",
  SyncManager: ChannelSortSyncManager,
  publishMethod: "publishSortPrefs",
  fetchRemoteMethod: "fetchRemoteSortPrefs",
  subscribeMethod: "subscribeToSortPrefs",
  watermarkLane: "channel-sort",
  readOutbox: readChannelSortOutbox,
  makeStore,
  makeNonEmptyStore: () => makeStore({ channels: "recent" }),
  decryptPayload: JSON.stringify({
    version: 1,
    groups: { "remote-group-from-relay": "recent" },
  }),
  emptyDecryptPayload: JSON.stringify({ version: 1, groups: {} }),
  checkAdoptedStore: (store) => "remote-group-from-relay" in store.groups,
  makeOverlapStoreA: () => makeStore({ channels: "recent" }),
  makeOverlapStoreB: () => makeStore({ dms: "alpha" }),
  checkOverlapPending: (store) =>
    Object.keys(store?.groups ?? {}).includes("dms"),
  checkOverlapOutbox: (outbox) =>
    Object.keys(outbox?.store?.groups ?? {}).includes("dms"),
  makeLiveDebounceStore: () => makeStore({ "local-group": "alpha" }),
  liveRemoteDecryptPayload: JSON.stringify({
    version: 1,
    groups: { "remote-during-debounce": "recent" },
  }),
  makeCollisionStoreA: () => makeStore({ channels: "recent" }),
  makeCollisionWinnerStore: () => makeStore({ channels: "alpha" }),
  makeCollisionStoreSnd: () => makeStore({ dms: "recent" }),
  makeCollisionStoreLsr: () => makeStore({ loser: "recent" }),
});

// ─── Sort-specific: unsupported head payload version ─────────────────────────

// An unsupported/unparseable payload version is equally unreadable: it decrypts
// but `parseChannelSortPayload` rejects it, so the manager must `retain`, not
// overwrite.
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
      "must not publish over a head whose payload version we do not support",
    );
    assert.ok(
      manager.getPendingStore() !== null,
      "unsupported head must retain the pending edit",
    );
    assert.ok(fw._hasTimer(), "a retry must be scheduled");
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// ─── Sort-specific: reconnect keeps the frozen baseline ──────────────────────

// The reconnect handler re-drives a pending edit through retryPendingPublish(),
// NOT the public publishSortPrefs(). A remote that advanced while the edit was
// pending must be adopted on reconnect, not published over: retryPendingPublish
// keeps the generation and the baseline frozen at queue time, so the pre-publish
// check still sees the head as advanced and adopts.
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
      "must adopt the advanced remote, never publish the stale edit over it",
    );
    assert.equal(adopted.length, 1, "the advanced remote must be adopted");
    assert.ok(
      REMOTE_KEY in adopted[0].store.groups,
      "adopted store must be the remote content that won LWW",
    );
    assert.equal(
      manager.getPendingStore(),
      null,
      "the losing pending edit must be cleared on adopt",
    );
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// ─── Sort-specific: durable outbox resume ────────────────────────────────────

// An edit made <2s before quit (destroy inside the debounce) is persisted, and
// a fresh manager resuming from that outbox publishes it — the edit is not
// silently dropped at teardown.
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
    assert.ok(persisted !== null, "edit must be persisted before teardown");
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
      "outbox must be cleared once the resumed edit publishes",
    );
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// ─── Sort-specific: failed publish retries the retained edit ─────────────────

// A transient publish rejection keeps the pending edit and schedules a
// bounded-backoff retry that succeeds, rather than logging-and-dropping.
// Mutation: reverting scheduleRetry to a bare console.warn leaves pending null
// and never re-publishes.
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
    assert.equal(attempts, 1, "first publish attempt rejected");
    assert.ok(
      manager.getPendingStore() !== null,
      "failed publish must retain the pending edit",
    );
    assert.ok(fw._hasTimer(), "a bounded-backoff retry must be scheduled");
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(attempts, 2, "retry must re-attempt the publish");
    assert.equal(
      manager.getPendingStore(),
      null,
      "successful retry must clear the pending edit",
    );
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});
