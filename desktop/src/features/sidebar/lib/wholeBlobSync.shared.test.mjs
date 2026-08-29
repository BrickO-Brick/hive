// Shared parameterized test suite for whole-blob sync managers
// (ChannelSectionSyncManager, ChannelSortSyncManager).
//
// Covers all 17 structural invariants common to both lanes. Lane-specific
// tests (serialized generations, ambiguous ACK, malformed payload,
// unsupported-version, reconnect adopts, durable outbox, failed publish)
// stay in the lane test files.
//
// Usage:
//   import { runWholeBlobSyncSuite } from "./wholeBlobSync.shared.test.mjs";
//   runWholeBlobSyncSuite({ label: "sections", ... });

import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { relayClient } from "@/shared/api/relayClient";
import {
  makeFakeWindow,
  installFakeWindow,
  installTauriMock,
  installEchoTauri,
} from "./sidebarSyncTestHelpers.mjs";

const RELAY = "wss://r.test";
const RELAY_KEY = encodeURIComponent(RELAY);

/**
 * Run the 17-invariant whole-blob sync suite for one lane.
 *
 * @param {object} cfg
 * @param {string}   cfg.label             - Human-readable lane name.
 * @param {Function} cfg.SyncManager       - The manager class to instantiate.
 * @param {string}   cfg.publishMethod     - e.g. "publishSections" or "publishSortPrefs".
 * @param {string}   cfg.fetchRemoteMethod - e.g. "fetchRemoteSections" or "fetchRemoteSortPrefs".
 * @param {string}   cfg.subscribeMethod   - e.g. "subscribeToSections" or "subscribeToSortPrefs".
 * @param {string}   cfg.watermarkLane     - e.g. "channel-sections" or "channel-sort".
 * @param {Function} cfg.readOutbox        - readChannelSectionsOutbox | readChannelSortOutbox
 * @param {Function} cfg.makeNonEmptyStore - () => non-empty store for bootstrap seed test
 * @param {string}   cfg.decryptPayload    - JSON.stringify of a valid remote store for adopt tests
 * @param {string}   cfg.emptyDecryptPayload - JSON.stringify of valid but empty/cleared store
 * @param {Function} cfg.checkAdoptedStore - (store) => bool — verify adopted store has remote content
 * @param {Function} cfg.makeOverlapStoreA - () => store for overlap test's first edit
 * @param {Function} cfg.makeOverlapStoreB - () => store for overlap test's second edit (in-flight)
 * @param {Function} cfg.checkOverlapPending  - (store) => bool — verify B is pending
 * @param {Function} cfg.checkOverlapOutbox   - (outbox) => bool — verify outbox holds B
 * @param {Function} cfg.makeLiveDebounceStore - () => local edit store for live-during-debounce test
 * @param {string}   cfg.liveRemoteDecryptPayload - decrypt payload for live-during-debounce test
 * @param {Function} cfg.makeCollisionStoreA - () => first edit for single-edit collision test
 * @param {Function} cfg.makeCollisionWinnerStore - () => peer winner store for collision test
 * @param {Function} cfg.makeCollisionStoreSnd - () => second edit for second-edit-survives test
 * @param {Function} cfg.makeCollisionStoreLsr - () => loser edit for loser-adopts test
 */
export function runWholeBlobSyncSuite({
  label,
  SyncManager,
  publishMethod,
  fetchRemoteMethod,
  subscribeMethod,
  watermarkLane,
  readOutbox,
  makeNonEmptyStore,
  decryptPayload,
  emptyDecryptPayload,
  checkAdoptedStore,
  makeOverlapStoreA,
  makeOverlapStoreB,
  checkOverlapPending,
  checkOverlapOutbox,
  makeLiveDebounceStore,
  liveRemoteDecryptPayload,
  makeCollisionStoreA,
  makeCollisionWinnerStore,
  makeCollisionStoreSnd,
  makeCollisionStoreLsr,
}) {
  // ─── destroy() ────────────────────────────────────────────────────────────

  test(`${label}: destroy: cancels pending publish without flushing to the relay`, () => {
    mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
    const publishCalls = [];
    mock.method(relayClient, "publishEvent", (...args) => {
      publishCalls.push(args);
      return Promise.resolve();
    });
    const fw = makeFakeWindow();
    const restore = installFakeWindow(fw);
    try {
      const manager = new SyncManager("pk-test", RELAY);
      manager[publishMethod](makeNonEmptyStore());
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

  test(`${label}: destroy: aborts in-flight doPublish after fetchOwnBlobBeforePublish resolves`, async () => {
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
      const manager = new SyncManager("pk-race", RELAY);
      manager[publishMethod](makeNonEmptyStore());
      fw._fireTimer();
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

  test(`${label}: destroy: is safe to call with no pending publish`, () => {
    const fw = makeFakeWindow();
    const restore = installFakeWindow(fw);
    try {
      const manager = new SyncManager("pk-no-pending", RELAY);
      assert.doesNotThrow(() => manager.destroy());
    } finally {
      restore();
    }
  });

  // ─── Boot seed-publish guard (revert-fix regression suite) ────────────────

  test(`${label}: revert-fix: fetch failed (error) does not trigger seed-publish via bootstrap`, async () => {
    mock.method(relayClient, "fetchEvents", () =>
      Promise.reject(new Error("relay timeout")),
    );
    mock.method(relayClient, "publishEvent", () => Promise.resolve());
    const fw = makeFakeWindow();
    const restore = installFakeWindow(fw);
    try {
      const manager = new SyncManager("pk-fail", RELAY);
      const result = await manager.bootstrap(makeNonEmptyStore());
      assert.equal(result.action, "hold");
      assert.equal(manager.getPendingStore(), null);
      manager.destroy();
    } finally {
      restore();
      mock.reset();
    }
  });

  test(`${label}: revert-fix: absent fetch with prior watermark blocks seed-publish via bootstrap`, async () => {
    mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
    mock.method(relayClient, "publishEvent", () => Promise.resolve());
    const fw = makeFakeWindow();
    fw.localStorage.setItem(
      `buzz-sync-watermark.v1:${watermarkLane}:pk-stale:${RELAY_KEY}`,
      "1700000000",
    );
    const restore = installFakeWindow(fw);
    try {
      const manager = new SyncManager("pk-stale", RELAY);
      const result = await manager.bootstrap(makeNonEmptyStore());
      assert.equal(result.action, "hold");
      assert.equal(manager.getPendingStore(), null);
      manager.destroy();
    } finally {
      restore();
      mock.reset();
    }
  });

  test(`${label}: revert-fix: absent fetch with zero watermark seeds via bootstrap (first-sync preserved)`, async () => {
    mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
    mock.method(relayClient, "publishEvent", () => Promise.resolve());
    const fw = makeFakeWindow();
    const restore = installFakeWindow(fw);
    try {
      const manager = new SyncManager("pk-fresh", RELAY);
      const result = await manager.bootstrap(makeNonEmptyStore());
      assert.equal(result.action, "hold");
      assert.ok(manager.getPendingStore() !== null);
      manager.destroy();
    } finally {
      restore();
      mock.reset();
    }
  });

  // ─── Adopt-winner / local-winner ─────────────────────────────────────────

  test(`${label}: adopt-winner: newer remote head at pre-publish adopts remote and skips publish`, async () => {
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
    const tauri = installTauriMock(decryptPayload);
    try {
      const manager = new SyncManager("pk-lww", RELAY);
      const adopted = [];
      manager.setOnRemoteAdopted((r) => adopted.push(r));
      manager[publishMethod](makeNonEmptyStore());
      assert.ok(
        readOutbox("pk-lww", RELAY) !== null,
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
        checkAdoptedStore(adopted[0].store),
        "adopted store must be the remote content",
      );
      assert.equal(manager.getPendingStore(), null, "pending must be cleared");
      assert.equal(
        readOutbox("pk-lww", RELAY),
        null,
        "outbox must be cleared on adopt",
      );
      manager.destroy();
    } finally {
      tauri.restore();
      restore();
      mock.reset();
    }
  });

  test(`${label}: adopt-winner: local edit at/ahead of head publishes and clears outbox`, async () => {
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
      const manager = new SyncManager("pk-win", RELAY);
      manager[publishMethod](makeNonEmptyStore());
      fw._fireTimer();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(publishCalls.length, 1, "local edit must be published");
      assert.equal(
        readOutbox("pk-win", RELAY),
        null,
        "outbox must be cleared once the edit is confirmed retained",
      );
      manager.destroy();
    } finally {
      tauri.restore();
      restore();
      mock.reset();
    }
  });

  // ─── Timestamp clamp ──────────────────────────────────────────────────────

  test(`${label}: timestamp clamp: published createdAt stays inside the relay future window`, async () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const farFutureHead = nowSecs + 3_600;
    let call = 0;
    mock.method(relayClient, "fetchEvents", () => {
      call++;
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
    const tauri = installTauriMock(emptyDecryptPayload);
    mock.method(relayClient, "publishEvent", (evt) => {
      signedCreatedAt = evt.created_at;
      return Promise.resolve();
    });
    try {
      const manager = new SyncManager("pk-clamp", RELAY);
      await manager[fetchRemoteMethod]();
      manager[publishMethod](makeNonEmptyStore());
      fw._fireTimer();
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(signedCreatedAt !== null, "publish must have been attempted");
      assert.ok(
        signedCreatedAt <= Math.floor(Date.now() / 1000) + 840,
        `createdAt must be clamped inside the future window — got ${signedCreatedAt}`,
      );
      manager.destroy();
    } finally {
      tauri.restore();
      restore();
      mock.reset();
    }
  });

  // ─── Unreadable head: retain, never overwrite ─────────────────────────────

  test(`${label}: unreadable head (decrypt failure) retains the pending edit and retries, never publishing`, async () => {
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
      const manager = new SyncManager("pk-undec", RELAY);
      manager[publishMethod](makeNonEmptyStore());
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
        readOutbox("pk-undec", RELAY) !== null,
        "durable outbox must survive an unreadable head",
      );
      assert.ok(fw._hasTimer(), "a retry must be scheduled");
      manager.destroy();
    } finally {
      tauri.restore();
      restore();
      mock.reset();
    }
  });

  // ─── Failed pre-publish fetch: retain, never publish ──────────────────────

  test(`${label}: failed pre-publish fetch retains the pending edit and retries, never publishing`, async () => {
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
      const manager = new SyncManager("pk-fetchfail", RELAY);
      manager[publishMethod](makeNonEmptyStore());
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
        readOutbox("pk-fetchfail", RELAY) !== null,
        "durable outbox must survive a failed fetch",
      );
      assert.ok(fw._hasTimer(), "a retry must be scheduled");
      manager.destroy();
    } finally {
      tauri.restore();
      restore();
      mock.reset();
    }
  });

  // ─── Overlapping publishes ─────────────────────────────────────────────────

  test(`${label}: overlapping publishes: older completion does not erase a newer queued edit`, async () => {
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
      const manager = new SyncManager("pk-overlap", RELAY);
      manager[publishMethod](makeOverlapStoreA());
      await fireDelay(2000);
      while (releaseFirst === null) await Promise.resolve();

      manager[publishMethod](makeOverlapStoreB());
      assert.ok(
        checkOverlapPending(manager.getPendingStore()),
        "B is now the pending edit",
      );
      assert.ok(
        checkOverlapOutbox(readOutbox("pk-overlap", RELAY)),
        "outbox holds B",
      );

      releaseFirst();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      assert.ok(
        checkOverlapPending(manager.getPendingStore()),
        "older completion must leave B pending",
      );
      assert.ok(
        readOutbox("pk-overlap", RELAY) !== null,
        "older completion must leave B's outbox intact",
      );
      assert.ok(
        [...timers.values()].some((t) => t.ms === 2000),
        "B's debounce timer must survive so it still publishes",
      );
      manager.destroy();
    } finally {
      tauri.restore();
      restore();
      mock.reset();
    }
  });

  // ─── Live remote during debounce is adopted at pre-publish ────────────────

  test(`${label}: live remote during debounce is adopted at pre-publish, not overwritten`, async () => {
    let liveCallback = null;
    mock.method(relayClient, "subscribeLive", (_filter, onEvent) => {
      liveCallback = onEvent;
      return Promise.resolve(async () => {});
    });
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
    // Multi-slot fakeWindow: the live-event callback may schedule its own timer
    // (retry, watermark flush) before the debounce fires, which would clobber a
    // single-slot fake window. Use a keyed map so we can fire the 2000ms debounce
    // independently of any 0ms or other timers the live path may schedule.
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
      for (let i = 0; i < 50; i++) await Promise.resolve();
    };
    const restore = installFakeWindow(fakeWindow);
    const tauri = installTauriMock(liveRemoteDecryptPayload);
    try {
      const manager = new SyncManager("pk-live-deb", RELAY);
      const adopted = [];
      manager.setOnRemoteAdopted((r) => adopted.push(r));
      await manager[subscribeMethod](() => {});
      manager[publishMethod](makeLiveDebounceStore());
      // Live event arrives during the debounce window — advances watermark past
      // the frozen baseline.
      liveCallback({
        pubkey: "pk-live-deb",
        content: "good-cipher",
        created_at: 500,
        id: "evt-live",
      });
      for (let i = 0; i < 50; i++) await Promise.resolve();
      await fireDelay(2000); // debounce → doPublish → pre-publish sees advanced head
      assert.equal(
        publishCalls.length,
        0,
        "must not publish over a remote that became head during the debounce",
      );
      assert.equal(adopted.length, 1, "the newer remote must be adopted");
      manager.destroy();
    } finally {
      tauri.restore();
      restore();
      mock.reset();
    }
  });

  // ─── Same-second collision: single-edit retry adopts winner ───────────────

  test(`${label}: same-second collision: single-edit retry adopts winner, does not republish`, async () => {
    let fetchCalls = 0;
    let publishCalls = 0;
    let storedHead = [];
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
    const tauri = installEchoTauri("pk-collide3");
    mock.method(relayClient, "fetchEvents", () => {
      fetchCalls++;
      if (fetchCalls === 1) return Promise.resolve([]);
      if (fetchCalls === 2) return Promise.resolve([]);
      return Promise.resolve(storedHead);
    });
    mock.method(relayClient, "publishEvent", (event) => {
      publishCalls++;
      storedHead = [
        tauri.mintHead(
          makeCollisionWinnerStore(),
          event.created_at,
          "0-peer-winner",
        ),
      ];
      return Promise.resolve();
    });
    try {
      const manager = new SyncManager("pk-collide3", RELAY);
      const adopted = [];
      manager.setOnRemoteAdopted((r) => adopted.push(r.eventId));
      manager[publishMethod](makeCollisionStoreA());
      await fireDelay(2000);
      for (let i = 0; i < 100; i++) await Promise.resolve();
      await fireDelay(2000);
      for (let i = 0; i < 100; i++) await Promise.resolve();
      assert.equal(
        publishCalls,
        1,
        "retry does not republish above the winner",
      );
      assert.equal(adopted.length, 1, "retry adopts the peer winner");
      assert.equal(
        manager.getPendingStore(),
        null,
        "pending edit is cleared by the adopt",
      );
      manager.destroy();
    } finally {
      tauri.restore();
      restore();
      mock.reset();
    }
  });

  // ─── Same-second collision: second edit queued during confirmation survives ─

  test(`${label}: same-second collision: second edit queued during confirmation survives`, async () => {
    let fetchCalls = 0;
    let releaseConfirmation = null;
    let publishCalls = 0;
    let storedHead = [];
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
    const tauri = installEchoTauri("pk-collide2");
    mock.method(relayClient, "fetchEvents", () => {
      fetchCalls++;
      if (fetchCalls <= 2) return Promise.resolve([]); // pre-pub empty, confirmation empty
      if (fetchCalls === 3)
        return new Promise((res) => {
          releaseConfirmation = () => res(storedHead);
        });
      return Promise.resolve(storedHead);
    });
    mock.method(relayClient, "publishEvent", (event) => {
      publishCalls++;
      storedHead = [
        tauri.mintHead(
          makeCollisionWinnerStore(),
          event.created_at,
          "0-peer-winner",
        ),
      ];
      return Promise.resolve();
    });
    try {
      const manager = new SyncManager("pk-collide2", RELAY);
      const adopted = [];
      manager.setOnRemoteAdopted((r) => adopted.push(r));

      manager[publishMethod](makeCollisionStoreA()); // first edit
      await fireDelay(2000); // publishes A; confirmation (fetchCalls=3) hangs
      while (releaseConfirmation === null) await Promise.resolve();

      // Second edit queued while confirmation is still in-flight.
      manager[publishMethod](makeCollisionStoreSnd());
      releaseConfirmation(); // confirmation returns peer winner
      for (let i = 0; i < 100; i++) await Promise.resolve();

      // After the fix: adoptRemote folds the winner into the NEW baseline (the
      // second edit's cycle) so pre-publish sees equality and publishes.
      await fireDelay(2000);
      for (let i = 0; i < 100; i++) await Promise.resolve();

      assert.equal(
        publishCalls,
        2,
        "second edit must publish above the confirmed winner",
      );
      assert.equal(
        adopted.length,
        0,
        "second edit must not adopt the winner away",
      );
      manager.destroy();
    } finally {
      tauri.restore();
      restore();
      mock.reset();
    }
  });

  // ─── Same-second collision: loser adopts the winner, next edit survives ───

  test(`${label}: same-second collision: loser adopts the winner and its next edit survives`, async () => {
    let fetchCalls = 0;
    let publishCalls = 0;
    let storedHead = [];
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
    const tauri = installEchoTauri("pk-loser");
    mock.method(relayClient, "fetchEvents", () => {
      fetchCalls++;
      if (fetchCalls === 1) return Promise.resolve([]);
      if (fetchCalls === 2) return Promise.resolve(storedHead); // confirmation → peer winner retained
      return Promise.resolve(storedHead);
    });
    mock.method(relayClient, "publishEvent", (event) => {
      publishCalls++;
      if (publishCalls === 1) {
        // First publish: relay retained the peer's same-second winner instead.
        storedHead = [
          tauri.mintHead(
            makeCollisionWinnerStore(),
            event.created_at,
            "0-peer-winner",
          ),
        ];
      }
      return Promise.resolve();
    });
    try {
      const manager = new SyncManager("pk-loser", RELAY);
      const adopted = [];
      manager.setOnRemoteAdopted((r) => adopted.push(r));

      manager[publishMethod](makeCollisionStoreLsr());
      await fireDelay(2000); // publishes, confirmation returns peer winner → adopt
      for (let i = 0; i < 100; i++) await Promise.resolve();

      assert.equal(adopted.length, 1, "loser must adopt the peer winner");
      assert.equal(
        manager.getPendingStore(),
        null,
        "pending cleared after adopt",
      );

      // A further edit after the adopt must succeed (loser advances past winner).
      manager[publishMethod](makeCollisionStoreA());
      await fireDelay(2000);
      for (let i = 0; i < 100; i++) await Promise.resolve();

      assert.equal(
        publishCalls,
        2,
        "the edit after the adopt must publish successfully",
      );
      manager.destroy();
    } finally {
      tauri.restore();
      restore();
      mock.reset();
    }
  });

  // ─── live-sub: undecryptable event advances watermark before decrypt ───────
  // NOTE: this test uses subscribeLive and fires a live-event callback that
  // spawns a dangling async chain (void decryptAndParse().then(...)). Placing
  // it last in the suite keeps those trailing microtasks from leaking into
  // timer-based tests that follow it.

  test(`${label}: revert-fix: undecryptable live event advances watermark before decrypt attempt`, async () => {
    let liveCallback = null;
    mock.method(relayClient, "subscribeLive", (_filter, onEvent) => {
      liveCallback = onEvent;
      return Promise.resolve(async () => {});
    });
    const fw = makeFakeWindow();
    const restore = installFakeWindow(fw);
    try {
      const manager = new SyncManager("pk-live", RELAY);
      assert.equal(
        fw.localStorage.getItem(
          `buzz-sync-watermark.v1:${watermarkLane}:pk-live:${RELAY_KEY}`,
        ),
        null,
        "watermark starts absent",
      );
      await manager[subscribeMethod](() => {});
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
            `buzz-sync-watermark.v1:${watermarkLane}:pk-live:${RELAY_KEY}`,
          ) ?? "0",
        ) >= 1700005555,
        "live undecryptable event must advance the watermark before decrypt is attempted",
      );
      manager.destroy();
    } finally {
      restore();
      mock.reset();
    }
  });
}
