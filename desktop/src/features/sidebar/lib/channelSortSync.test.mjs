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

function makeStore(groups = {}) {
  return { version: 1, groups };
}

const RELAY = "wss://r.test";
const RELAY_KEY = encodeURIComponent(RELAY);

// ─── destroy() must cancel pending publish, not flush ─────────────────────────
test("destroy: cancels pending publish without flushing to the relay", () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  const publishCalls = [];
  mock.method(relayClient, "publishEvent", (...args) => {
    publishCalls.push(args);
    return Promise.resolve();
  });
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelSortSyncManager("pk-test", RELAY);
    manager.publishSortPrefs(makeStore({ channels: "recent" }));
    assert.ok(fw._hasTimer(), "debounce timer should be set");
    manager.destroy();
    assert.ok(!fw._hasTimer(), "debounce timer should be cleared on destroy");
    assert.equal(publishCalls.length, 0);
    assert.equal(manager.getPendingStore(), null);
  } finally {
    restore();
    mock.reset();
  }
});

// Regression guard for the timer-fired race: debounce fires → doPublish awaits
// fetchOwnBlobBeforePublish → destroy() called → publishEvent must not fire.
test("destroy: aborts in-flight doPublish after fetchOwnBlobBeforePublish resolves", async () => {
  let releaseFetch = null;
  const publishCalls = [];
  mock.method(
    relayClient,
    "fetchEvents",
    () =>
      new Promise((res) => {
        releaseFetch = () => res([]);
      }),
  );
  mock.method(relayClient, "publishEvent", (...args) => {
    publishCalls.push(args);
    return Promise.resolve();
  });
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelSortSyncManager("pk-race", RELAY);
    manager.publishSortPrefs(makeStore({ dms: "recent" }));
    fw._fireTimer(); // starts doPublish, which is now awaiting fetchOwnBlobBeforePublish
    manager.destroy();
    releaseFetch();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(
      publishCalls.length,
      0,
      "publishEvent must not fire after destroy",
    );
  } finally {
    restore();
    mock.reset();
  }
});

test("destroy: is safe to call with no pending publish", () => {
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelSortSyncManager("pk-no-pending", RELAY);
    assert.doesNotThrow(() => manager.destroy());
  } finally {
    restore();
  }
});

// ─── Boot seed-publish guard (the revert-fix regression suite) ────────────────
// Wiring tests 1-3 drive the production bootstrap() path; policy tested once
// in sidebarSyncWatermark.test.mjs.

// 1. fetch failed → hold, pendingStore null (mutation: remove failed guard → seed queued)
test("revert-fix: fetch failed (error) does not trigger seed-publish via bootstrap", async () => {
  mock.method(relayClient, "fetchEvents", () =>
    Promise.reject(new Error("relay timeout")),
  );
  mock.method(relayClient, "publishEvent", () => Promise.resolve());
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelSortSyncManager("pk-fail", RELAY);
    const result = await manager.bootstrap(makeStore({ channels: "recent" }));
    assert.equal(result.action, "hold");
    assert.equal(manager.getPendingStore(), null);
  } finally {
    restore();
    mock.reset();
  }
});

// 2. absent + persisted head > 0 → hold, zero publish calls (dev-build stale-copy case)
test("revert-fix: absent fetch with prior watermark blocks seed-publish via bootstrap", async () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "publishEvent", () => Promise.resolve());
  const fw = makeFakeWindow();
  fw.localStorage.setItem(
    `buzz-sync-watermark.v1:channel-sort:pk-stale:${RELAY_KEY}`,
    "1700000000",
  );
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelSortSyncManager("pk-stale", RELAY);
    const result = await manager.bootstrap(makeStore({ channels: "recent" }));
    assert.equal(result.action, "hold");
    assert.equal(manager.getPendingStore(), null);
  } finally {
    restore();
    mock.reset();
  }
});

// 3. absent + head 0 + local non-empty → seed-publish queued (first-sync preserved)
test("revert-fix: absent fetch with zero watermark seeds via bootstrap (first-sync preserved)", async () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "publishEvent", () => Promise.resolve());
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelSortSyncManager("pk-fresh", RELAY);
    const result = await manager.bootstrap(makeStore({ channels: "recent" }));
    assert.equal(result.action, "hold");
    assert.ok(manager.getPendingStore() !== null);
  } finally {
    restore();
    mock.reset();
  }
});

// ─── Whole-blob LWW: adopt-winner and local-winner ────────────────────────────

// 4a. Adopt-winner: a newer remote head at pre-publish time supersedes the local
//     edit — the manager must NOT publish, must hand the remote to the adopt
//     sink, and must clear pending/outbox so the loser can't be replayed.
// Mutation: reverting adopt→republish makes onRemoteAdopted never fire and
// publishEvent fire instead.
test("adopt-winner: newer remote head at pre-publish adopts remote and skips publish", async () => {
  const REMOTE_KEY = "remote-group-from-relay";
  mock.method(relayClient, "fetchEvents", () =>
    Promise.resolve([
      {
        pubkey: "pk-lww",
        content: "good-cipher",
        created_at: 200,
        id: "evt-remote",
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
  const tauri = installTauriMock(
    JSON.stringify({ version: 1, groups: { [REMOTE_KEY]: "recent" } }),
  );
  try {
    const manager = new ChannelSortSyncManager("pk-lww", RELAY);
    const adopted = [];
    manager.setOnRemoteAdopted((r) => adopted.push(r));
    manager.publishSortPrefs(makeStore({ "local-group": "recent" }));
    assert.ok(
      readChannelSortOutbox("pk-lww", RELAY) !== null,
      "edit must be persisted to the durable outbox",
    );
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      publishCalls.length,
      0,
      "must not publish when a newer remote head wins LWW",
    );
    assert.equal(adopted.length, 1, "adopt sink must receive the remote");
    assert.ok(
      REMOTE_KEY in adopted[0].store.groups,
      "adopted store must be the remote content",
    );
    assert.equal(manager.getPendingStore(), null, "pending must be cleared");
    assert.equal(
      readChannelSortOutbox("pk-lww", RELAY),
      null,
      "outbox must be cleared on adopt so the loser is never replayed",
    );
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// 4b. Local edit wins (no newer remote head): publishes and clears the outbox.
test("adopt-winner: local edit at/ahead of head publishes and clears outbox", async () => {
  // The relay retains our own write, so the post-ACK confirmation fetch reads
  // it back and confirms — clearing the outbox.
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
  const tauri = installEchoTauri("pk-win");
  try {
    const manager = new ChannelSortSyncManager("pk-win", RELAY);
    manager.publishSortPrefs(makeStore({ channels: "recent" }));
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(publishCalls.length, 1, "local edit must be published");
    assert.equal(
      readChannelSortOutbox("pk-win", RELAY),
      null,
      "outbox must be cleared once the edit is confirmed retained",
    );
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// 4c. Timestamp clamp: a remote head far in the future must not make the
//     published createdAt walk past the relay's ±15min window.
// Mutation test: removing the clamp lets createdAt = lastRemote+1 (~now+3600),
// which exceeds now + MAX_PUBLISH_FUTURE_SECS.
test("timestamp clamp: published createdAt stays inside the relay future window", async () => {
  const nowSecs = Math.floor(Date.now() / 1000);
  const farFutureHead = nowSecs + 3_600; // 1h ahead — beyond the ±15min window
  let call = 0;
  mock.method(relayClient, "fetchEvents", () => {
    call++;
    // First call primes lastRemoteCreatedAt to farFutureHead; the pre-publish
    // call returns a decryptable head at created_at=0 so the local edit wins
    // LWW and publishes (an undecryptable head would now `retain`, not publish).
    return Promise.resolve([
      {
        pubkey: "pk-clamp",
        content: "good-cipher",
        created_at: call === 1 ? farFutureHead : 0,
        id: "evt-clamp",
      },
    ]);
  });
  let signedCreatedAt = null;
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  const tauri = installTauriMock(JSON.stringify({ version: 1, groups: {} }));
  mock.method(relayClient, "publishEvent", (evt) => {
    signedCreatedAt = evt.created_at;
    return Promise.resolve();
  });
  try {
    const manager = new ChannelSortSyncManager("pk-clamp", RELAY);
    await manager.fetchRemoteSortPrefs(); // prime lastRemoteCreatedAt
    manager.publishSortPrefs(makeStore({ channels: "recent" }));
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(signedCreatedAt !== null, "publish must have been attempted");
    assert.ok(
      signedCreatedAt <= Math.floor(Date.now() / 1000) + 840,
      `createdAt must be clamped inside the future window — got ${signedCreatedAt}`,
    );
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// ─── Unreadable head: retain, never overwrite (Carl P1) ───────────────────────

// A pre-publish head event exists but cannot be decrypted (transient keychain
// fault, future NIP-44 scheme). We cannot inspect it to decide adopt-or-publish,
// so publishing our blob over it would blindly clobber authoritative state.
// Fix: `retain` — keep the durable pending edit and retry, never publish.
// Mutation: reverting `retain` to `publish` fires publishEvent and drops the
// head's unread state.
test("unreadable head (decrypt failure) retains the pending edit and retries, never publishing", async () => {
  mock.method(relayClient, "fetchEvents", () =>
    Promise.resolve([
      {
        pubkey: "pk-undec",
        content: "bad-cipher",
        created_at: 500,
        id: "evt-undec",
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
  const tauri = installTauriMock("{}");
  try {
    const manager = new ChannelSortSyncManager("pk-undec", RELAY);
    manager.publishSortPrefs(makeStore({ channels: "recent" }));
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      publishCalls.length,
      0,
      "must not publish over a head we could not read",
    );
    assert.ok(
      manager.getPendingStore() !== null,
      "unreadable head must retain the pending edit",
    );
    assert.ok(
      readChannelSortOutbox("pk-undec", RELAY) !== null,
      "durable outbox must survive an unreadable head",
    );
    assert.ok(fw._hasTimer(), "a retry must be scheduled");
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

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
  // Decrypts cleanly but carries a future schema version the parser rejects.
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

// ─── Failed pre-publish fetch: retain, never publish (Carl P1) ────────────────

// The pre-publish fetch THROWS (timeout / auth / socket) — this is NOT proof
// that no head exists. Publishing here would sign above a stale watermark and
// could erase an unseen newer head during a transient outage. Fix: `retain` —
// keep the durable pending edit and retry, never publish on a failed fetch.
// Mutation: reverting the catch to `publish` fires publishEvent over the unseen
// head.
test("failed pre-publish fetch retains the pending edit and retries, never publishing", async () => {
  mock.method(relayClient, "fetchEvents", () =>
    Promise.reject(new Error("socket timeout")),
  );
  const publishCalls = [];
  mock.method(relayClient, "publishEvent", (...args) => {
    publishCalls.push(args);
    return Promise.resolve();
  });
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  const tauri = installTauriMock("{}");
  try {
    const manager = new ChannelSortSyncManager("pk-fetchfail", RELAY);
    manager.publishSortPrefs(makeStore({ channels: "recent" }));
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      publishCalls.length,
      0,
      "must not publish when the pre-publish fetch failed",
    );
    assert.ok(
      manager.getPendingStore() !== null,
      "a failed fetch must retain the pending edit",
    );
    assert.ok(
      readChannelSortOutbox("pk-fetchfail", RELAY) !== null,
      "durable outbox must survive a failed fetch",
    );
    assert.ok(fw._hasTimer(), "a retry must be scheduled");
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// ─── Reconnect keeps the frozen baseline (Carl P1) ────────────────────────────

// The reconnect handler re-drives a pending edit through retryPendingPublish(),
// NOT the public publishSortPrefs(). A remote that advanced while the edit was
// pending must be adopted on reconnect, not published over: retryPendingPublish
// keeps the generation and the baseline frozen at queue time, so the pre-publish
// check still sees the head as advanced and adopts. Mutation: reverting the
// reconnect handler to publishSortPrefs(pending) resets the baseline to the
// just-fetched head, so the pre-publish check sees no advancement and publishes
// the stale edit over the remote (adopt never fires, publishEvent does).
test("reconnect adopts a remote that advanced while the edit was pending, never publishing over it", async () => {
  const REMOTE_KEY = "remote-group-won-lww";
  let call = 0;
  // call 1: prime lastRemoteHead to the baseline head (created_at 100).
  // call 2+: the remote has since advanced to 200 (reconnect fetch + pre-publish
  // fetch both see the advanced head).
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
    // Prime the baseline: the head stood at created_at 100 when the edit began.
    await manager.fetchRemoteSortPrefs();
    manager.publishSortPrefs(makeStore({ "local-group": "recent" }));

    // Reconnect fires: the hook re-fetches (head now 200) then wakes the
    // existing generation via retryPendingPublish — WITHOUT bumping generation
    // or resetting the frozen baseline.
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

// ─── Durable lane: outbox resume, retry, and cross-generation safety ──────────

// 5. Durable outbox resume: an edit made <2s before quit (destroy inside the
//    debounce) is persisted, and a fresh manager resuming from that outbox
//    publishes it — the edit is not silently dropped at teardown.
// Mutation: dropping writeChannelSortOutbox leaves the outbox null → no resume.
test("durable outbox: edit destroyed inside the debounce resumes and publishes on remount", async () => {
  // The relay retains the resumed write; the post-ACK confirmation reads it
  // back and confirms, clearing the outbox.
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
    // Window 1: edit then destroy before the debounce fires.
    const m1 = new ChannelSortSyncManager("pk-resume", RELAY);
    m1.publishSortPrefs(makeStore({ channels: "recent" }));
    const persisted = readChannelSortOutbox("pk-resume", RELAY);
    assert.ok(persisted !== null, "edit must be persisted before teardown");
    m1.destroy();
    assert.equal(publishCalls.length, 0, "destroy must not flush");

    // Window 2: resume the persisted outbox (the hook does this after bootstrap
    // via readChannelSortOutbox, which enumerates every window's outbox key).
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

// 6. Failed publish retries with no later edit: a transient publish rejection
//    keeps the pending edit and schedules a bounded-backoff retry that succeeds,
//    rather than logging-and-dropping (the pre-fix behaviour).
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
    fw._fireTimer(); // debounce → doPublish → publish rejects → scheduleRetry
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(attempts, 1, "first publish attempt rejected");
    assert.ok(
      manager.getPendingStore() !== null,
      "failed publish must retain the pending edit",
    );
    assert.ok(fw._hasTimer(), "a bounded-backoff retry must be scheduled");
    fw._fireTimer(); // retry → doPublish → publish resolves
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

// 7. Overlapping publishes: an older completion must not erase a newer queued
//    edit or its outbox (generation compare-and-swap).
// Mutation: dropping the gen guard in discardPending clears B on A's completion.
test("overlapping publishes: older completion does not erase a newer queued edit", async () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  let releaseFirst = null;
  let publishCalls = 0;
  mock.method(relayClient, "publishEvent", () => {
    publishCalls++;
    if (publishCalls === 1) {
      return new Promise((res) => {
        releaseFirst = res;
      });
    }
    return Promise.resolve();
  });
  const storage = new Map();
  const timers = new Map();
  let nextId = 1;
  const fakeWindow = {
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
      get length() {
        return storage.size;
      },
      key: (i) => [...storage.keys()][i] ?? null,
    },
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  const fireDelay = async (ms) => {
    const entry = [...timers.entries()].find(([, v]) => v.ms === ms);
    assert.ok(entry, `expected a timer scheduled at ${ms}ms`);
    timers.delete(entry[0]);
    entry[1].fn();
    await Promise.resolve();
    await Promise.resolve();
  };
  const restore = installFakeWindow(fakeWindow);
  const tauri = installTauriMock("{}");
  try {
    const manager = new ChannelSortSyncManager("pk-overlap", RELAY);
    manager.publishSortPrefs(makeStore({ channels: "recent" })); // A
    await fireDelay(2000); // debounce → doPublish(A) awaits publishEvent
    while (releaseFirst === null) await Promise.resolve();

    manager.publishSortPrefs(makeStore({ dms: "alpha" })); // B while A in flight
    assert.deepEqual(
      Object.keys(manager.getPendingStore()?.groups ?? {}),
      ["dms"],
      "B is now the pending edit",
    );
    assert.deepEqual(
      Object.keys(
        readChannelSortOutbox("pk-overlap", RELAY)?.store.groups ?? {},
      ),
      ["dms"],
      "outbox holds B",
    );

    releaseFirst(); // A completes — must NOT clear B's pending/outbox
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(
      Object.keys(manager.getPendingStore()?.groups ?? {}),
      ["dms"],
      "older completion must leave B pending",
    );
    assert.ok(
      readChannelSortOutbox("pk-overlap", RELAY) !== null,
      "older completion must leave B's outbox intact",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// 8. Live remote during debounce is adopted at pre-publish, not overwritten. The
//    live event advances the mutable watermark before doPublish runs, so
//    comparing the fetched head against the watermark would see equality and
//    publish over the newer remote. The pre-publish check compares against the
//    baseline frozen at publishSortPrefs instead.
// Mutation: comparing against lastRemoteCreatedAt rather than publishBaseline
// republishes local over the newer remote.
test("live remote during debounce is adopted at pre-publish, not overwritten", async () => {
  const REMOTE_KEY = "remote-during-debounce";
  let liveCallback = null;
  mock.method(relayClient, "subscribeLive", (_filter, onEvent) => {
    liveCallback = onEvent;
    return Promise.resolve(async () => {});
  });
  // Pre-publish fetch returns the same newer head the live event delivered.
  mock.method(relayClient, "fetchEvents", () =>
    Promise.resolve([
      {
        pubkey: "pk-live-deb",
        content: "good-cipher",
        created_at: 500,
        id: "evt-live",
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
  const tauri = installTauriMock(
    JSON.stringify({ version: 1, groups: { [REMOTE_KEY]: "recent" } }),
  );
  try {
    const manager = new ChannelSortSyncManager("pk-live-deb", RELAY);
    const adopted = [];
    manager.setOnRemoteAdopted((r) => adopted.push(r));
    await manager.subscribeToSortPrefs(() => {});
    // Local edit queued first, freezing the baseline at the empty head.
    manager.publishSortPrefs(makeStore({ "local-group": "alpha" }));
    // A newer remote head arrives during the debounce window (advances the
    // mutable watermark to created_at=500).
    liveCallback({
      pubkey: "pk-live-deb",
      content: "good-cipher",
      created_at: 500,
      id: "evt-live",
    });
    await new Promise((r) => setTimeout(r, 0));
    fw._fireTimer(); // debounce → doPublish → pre-publish sees advanced head
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      publishCalls.length,
      0,
      "must not publish over a remote that became head during the debounce",
    );
    assert.equal(adopted.length, 1, "the newer remote must be adopted");
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// 9. live-sub: undecryptable event on live path records head before decrypt.
// Mutation test: removing recordRemoteHead before decrypt in the live callback
// leaves watermark at 0 after a live event.
test("revert-fix: undecryptable live event advances watermark before decrypt attempt", async () => {
  let liveCallback = null;
  mock.method(relayClient, "subscribeLive", (_filter, onEvent) => {
    liveCallback = onEvent;
    return Promise.resolve(async () => {});
  });
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelSortSyncManager("pk-live", RELAY);
    assert.equal(
      fw.localStorage.getItem(
        `buzz-sync-watermark.v1:channel-sort:pk-live:${RELAY_KEY}`,
      ),
      null,
      "watermark starts absent",
    );
    await manager.subscribeToSortPrefs(() => {});
    assert.ok(
      liveCallback !== null,
      "subscribeLive must have captured the callback",
    );
    liveCallback({
      pubkey: "pk-live",
      content: "!bad-cipher!",
      created_at: 1700005555,
      id: "live-evt-1",
    });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(
      Number(
        fw.localStorage.getItem(
          `buzz-sync-watermark.v1:channel-sort:pk-live:${RELAY_KEY}`,
        ) ?? "0",
      ) >= 1700005555,
      "live undecryptable event must advance the watermark before decrypt is attempted",
    );
  } finally {
    restore();
    mock.reset();
  }
});

// Same-second whole-blob collision (Carl r6 P1): two windows publish distinct
// sort blobs stamped at the same created_at; the relay retains only the lower
// event id and OKs the loser as a no-op (`Duplicate`). A publish OK is NOT proof
// of retention. The loser must fetch the authoritative head, see a DIFFERENT
// readable event, and ADOPT it — never record its own non-retained tuple as the
// baseline. Its NEXT edit must then survive: it publishes above the adopted
// winner rather than being mistaken for a competing remote and adopted away.
// Mutation: recording the attempted tuple on OK alone (dropping
// confirmRetainedHead) makes the loser fold a nonexistent head and erase its
// next edit.
test("same-second collision: loser adopts the winner and its next edit survives", async () => {
  let publishCalls = 0;
  let storedHead = [];
  mock.method(relayClient, "fetchEvents", () => Promise.resolve(storedHead));
  const storage = new Map();
  const timers = new Map();
  let nextId = 1;
  const win = {
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  const fireDelay = async (ms) => {
    const entry = [...timers.entries()].find(([, v]) => v.ms === ms);
    assert.ok(entry, `expected a timer scheduled at ${ms}ms`);
    timers.delete(entry[0]);
    entry[1].fn();
    for (let i = 0; i < 100; i++) await Promise.resolve();
  };
  const restore = installFakeWindow(win);
  const tauri = installEchoTauri("pk-collide");
  mock.method(relayClient, "publishEvent", (event) => {
    publishCalls++;
    if (publishCalls === 1) {
      // Our blob is OK'd but immediately superseded: the retained head is a
      // peer window's distinct blob at the same second (lower event id wins).
      storedHead = [
        tauri.mintHead(makeStore({ channels: "alpha" }), event.created_at),
      ];
      return Promise.resolve();
    }
    storedHead = [event];
    return Promise.resolve();
  });
  try {
    const manager = new ChannelSortSyncManager("pk-collide", RELAY);
    const adopted = [];
    manager.setOnRemoteAdopted((r) => adopted.push(r.eventId));

    manager.publishSortPrefs(makeStore({ channels: "recent" }));
    await fireDelay(2000); // publish OK, but the peer blob is what's retained
    for (let i = 0; i < 100; i++) await Promise.resolve();

    assert.equal(adopted.length, 1, "loser adopts the true retained winner");
    assert.equal(
      manager.getPendingStore(),
      null,
      "the losing edit is resolved by adopting the winner, not left dangling",
    );

    manager.publishSortPrefs(makeStore({ channels: "name" }));
    await fireDelay(2000);
    for (let i = 0; i < 100; i++) await Promise.resolve();

    assert.equal(publishCalls, 2, "the next edit publishes above the winner");
    assert.equal(
      adopted.length,
      1,
      "the next edit is NOT adopted away — no phantom-baseline poisoning",
    );
    assert.equal(
      manager.getPendingStore(),
      null,
      "the next edit clears via its own confirmed publish",
    );
    assert.equal(
      readChannelSortOutbox("pk-collide", RELAY),
      null,
      "the next edit's durable outbox is cleared on confirmation",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});
