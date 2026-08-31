// Authoritative whole-blob sync suite — runs directly against
// ChannelSectionSyncManager. Covers the 15 structural invariants common to
// whole-blob lanes. Lane-specific tests stay in the lane files.

import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { relayClient } from "@/shared/api/relayClient";
import { ChannelSectionSyncManager } from "./channelSectionsSync.ts";
import { readChannelSectionsOutbox } from "./channelSectionsStorage.ts";
import {
  makeFakeWindow,
  installFakeWindow,
  makeTimerBed,
  installTauriMock,
  installEchoTauri,
} from "./sidebarSyncTestHelpers.mjs";

const RELAY = "wss://r.test";
const RELAY_KEY = encodeURIComponent(RELAY);
const watermarkLane = "channel-sections";

function makeStore(sections = []) {
  return { version: 1, sections, assignments: {} };
}
function nonEmptyStore() {
  return makeStore([{ id: "s1", name: "Work", order: 0 }]);
}
const decryptPayload = JSON.stringify(
  makeStore([{ id: "remote-section-from-relay", name: "Remote", order: 0 }]),
);
const emptyDecryptPayload = JSON.stringify(makeStore([]));

// ─── destroy() ───────────────────────────────────────────────────────────────

test("destroy: cancels pending publish without flushing to the relay", () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "publishEvent", () => Promise.resolve());
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelSectionSyncManager("pk-test", RELAY);
    manager.publishSections(nonEmptyStore());
    assert.ok(fw._hasTimer(), "debounce timer should be set");
    manager.destroy();
    assert.ok(!fw._hasTimer(), "debounce timer should be cleared on destroy");
    assert.equal(manager.getPendingStore(), null);
  } finally {
    restore();
    mock.reset();
  }
});

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
    const manager = new ChannelSectionSyncManager("pk-race", RELAY);
    manager.publishSections(nonEmptyStore());
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

// ─── Boot seed-publish guard ──────────────────────────────────────────────────

for (const { title, setupFetch, setupWatermark, pubkey, assertPending } of [
  {
    title: "fetch error does not trigger seed-publish",
    setupFetch: () =>
      mock.method(relayClient, "fetchEvents", () =>
        Promise.reject(new Error("relay timeout")),
      ),
    assertPending: (m) => assert.equal(m.getPendingStore(), null),
  },
  {
    title: "absent fetch with prior watermark blocks seed-publish",
    setupFetch: () =>
      mock.method(relayClient, "fetchEvents", () => Promise.resolve([])),
    setupWatermark: (fw) =>
      fw.localStorage.setItem(
        `buzz-sync-watermark.v1:${watermarkLane}:pk-stale:${RELAY_KEY}`,
        "1700000000",
      ),
    pubkey: "pk-stale",
    assertPending: (m) => assert.equal(m.getPendingStore(), null),
  },
  {
    title: "absent fetch with zero watermark seeds (first-sync preserved)",
    setupFetch: () =>
      mock.method(relayClient, "fetchEvents", () => Promise.resolve([])),
    pubkey: "pk-fresh",
    assertPending: (m) => assert.ok(m.getPendingStore() !== null),
  },
]) {
  test(`revert-fix: ${title}`, async () => {
    setupFetch();
    mock.method(relayClient, "publishEvent", () => Promise.resolve());
    const fw = makeFakeWindow();
    setupWatermark?.(fw);
    const restore = installFakeWindow(fw);
    try {
      const manager = new ChannelSectionSyncManager(pubkey ?? "pk-fail", RELAY);
      const result = await manager.bootstrap(nonEmptyStore());
      assert.equal(result.action, "hold");
      assertPending(manager);
      manager.destroy();
    } finally {
      restore();
      mock.reset();
    }
  });
}

// ─── Adopt-winner / local-winner ─────────────────────────────────────────────

test("adopt-winner: newer remote head at pre-publish adopts remote and skips publish", async () => {
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
    const manager = new ChannelSectionSyncManager("pk-lww", RELAY);
    const adopted = [];
    manager.setOnRemoteAdopted((r) => adopted.push(r));
    manager.publishSections(nonEmptyStore());
    assert.ok(
      readChannelSectionsOutbox("pk-lww", RELAY) !== null,
      "edit must be in durable outbox",
    );
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      publishCalls.length,
      0,
      "must not publish when remote wins LWW",
    );
    assert.equal(adopted.length, 1, "adopt sink must receive the remote");
    assert.ok(
      adopted[0].store.sections.some(
        (s) => s.id === "remote-section-from-relay",
      ),
    );
    assert.equal(manager.getPendingStore(), null);
    assert.equal(
      readChannelSectionsOutbox("pk-lww", RELAY),
      null,
      "outbox cleared on adopt",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

test("adopt-winner: local edit at/ahead of head publishes and clears outbox", async () => {
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
    const manager = new ChannelSectionSyncManager("pk-win", RELAY);
    manager.publishSections(nonEmptyStore());
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(publishCalls.length, 1, "local edit must be published");
    assert.equal(
      readChannelSectionsOutbox("pk-win", RELAY),
      null,
      "outbox cleared after confirmed publish",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// ─── Timestamp clamp ─────────────────────────────────────────────────────────

test("timestamp clamp: published createdAt stays inside the relay future window", async () => {
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
    const manager = new ChannelSectionSyncManager("pk-clamp", RELAY);
    await manager.fetchRemoteSections();
    manager.publishSections(nonEmptyStore());
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(signedCreatedAt !== null, "publish must have been attempted");
    assert.ok(
      signedCreatedAt <= Math.floor(Date.now() / 1000) + 840,
      `createdAt must be clamped — got ${signedCreatedAt}`,
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// ─── Retain / retry on bad head ───────────────────────────────────────────────

for (const { title, pubkey, content, tauri: tauriPayload } of [
  {
    title: "unreadable head (decrypt failure)",
    pubkey: "pk-undec",
    content: "bad-cipher",
    tauri: installTauriMock.bind(null, "{}"),
  },
  {
    title: "failed pre-publish fetch",
    pubkey: "pk-fetchfail",
    content: null,
    tauri: installTauriMock.bind(null, "{}"),
  },
]) {
  test(`${title} retains the pending edit and retries, never publishing`, async () => {
    if (content === null) {
      mock.method(relayClient, "fetchEvents", () =>
        Promise.reject(new Error("socket timeout")),
      );
    } else {
      mock.method(relayClient, "fetchEvents", () =>
        Promise.resolve([{ pubkey, content, created_at: 500, id: "evt" }]),
      );
    }
    const publishCalls = [];
    mock.method(relayClient, "publishEvent", (...args) => {
      publishCalls.push(args);
      return Promise.resolve();
    });
    const fw = makeFakeWindow();
    const restore = installFakeWindow(fw);
    const t = tauriPayload();
    try {
      const manager = new ChannelSectionSyncManager(pubkey, RELAY);
      manager.publishSections(nonEmptyStore());
      fw._fireTimer();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(publishCalls.length, 0, "must not publish");
      assert.ok(manager.getPendingStore() !== null, "pending edit retained");
      assert.ok(
        readChannelSectionsOutbox(pubkey, RELAY) !== null,
        "durable outbox intact",
      );
      assert.ok(fw._hasTimer(), "retry scheduled");
      manager.destroy();
    } finally {
      t.restore();
      restore();
      mock.reset();
    }
  });
}

// ─── Overlapping publishes ────────────────────────────────────────────────────

test("overlapping publishes: older completion does not erase a newer queued edit", async () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  let releaseFirst = null;
  let publishCalls = 0;
  mock.method(relayClient, "publishEvent", () => {
    publishCalls++;
    if (publishCalls === 1)
      return new Promise((res) => {
        releaseFirst = res;
      });
    return Promise.resolve();
  });
  const { timers, fireDelay, restore } = makeTimerBed();
  const tauri = installTauriMock("{}");
  try {
    const manager = new ChannelSectionSyncManager("pk-overlap", RELAY);
    const storeA = makeStore([{ id: "a", name: "A", order: 0 }]);
    const storeB = makeStore([{ id: "b", name: "B", order: 0 }]);
    manager.publishSections(storeA);
    await fireDelay(2000);
    while (releaseFirst === null) await Promise.resolve();
    manager.publishSections(storeB);
    assert.ok(
      manager.getPendingStore()?.sections?.[0]?.id === "b",
      "B is pending",
    );
    assert.ok(
      readChannelSectionsOutbox("pk-overlap", RELAY)?.store?.sections?.[0]
        ?.id === "b",
      "outbox holds B",
    );
    releaseFirst();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.ok(
      manager.getPendingStore()?.sections?.[0]?.id === "b",
      "older completion leaves B pending",
    );
    assert.ok(
      readChannelSectionsOutbox("pk-overlap", RELAY) !== null,
      "older completion leaves B outbox intact",
    );
    assert.ok(
      [...timers.values()].some((t) => t.ms === 2000),
      "B debounce timer survives",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// ─── Live remote during debounce ──────────────────────────────────────────────

test("live remote during debounce is adopted at pre-publish, not overwritten", async () => {
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
  const liveRemoteDecryptPayload = JSON.stringify(
    makeStore([{ id: "remote-during-debounce", name: "Remote", order: 0 }]),
  );
  const { fireDelay, restore } = makeTimerBed();
  const tauri = installTauriMock(liveRemoteDecryptPayload);
  try {
    const manager = new ChannelSectionSyncManager("pk-live-deb", RELAY);
    const adopted = [];
    manager.setOnRemoteAdopted((r) => adopted.push(r));
    await manager.subscribeToSections(() => {});
    manager.publishSections(
      makeStore([{ id: "local", name: "Local", order: 0 }]),
    );
    liveCallback({
      pubkey: "pk-live-deb",
      content: "good-cipher",
      created_at: 500,
      id: "evt-live",
    });
    for (let i = 0; i < 50; i++) await Promise.resolve();
    await fireDelay(2000);
    assert.equal(
      publishCalls.length,
      0,
      "must not publish over a remote that became head during debounce",
    );
    assert.equal(adopted.length, 1, "newer remote must be adopted");
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// ─── Same-second collision ────────────────────────────────────────────────────

test("same-second collision: second edit queued during confirmation survives", async () => {
  let fetchCalls = 0;
  let releaseConfirmation = null;
  let publishCalls = 0;
  let storedHead = [];
  const { fireDelay, restore } = makeTimerBed();
  const tauri = installEchoTauri("pk-collide2");
  mock.method(relayClient, "fetchEvents", () => {
    fetchCalls++;
    if (fetchCalls === 1) return Promise.resolve([]);
    if (fetchCalls === 2)
      return new Promise((res) => {
        releaseConfirmation = () => res(storedHead);
      });
    return Promise.resolve(storedHead);
  });
  const winnerStore = makeStore([{ id: "peer", name: "Peer", order: 0 }]);
  mock.method(relayClient, "publishEvent", (event) => {
    publishCalls++;
    if (publishCalls === 1) {
      storedHead = [
        tauri.mintHead(winnerStore, event.created_at, "0-peer-winner"),
      ];
      return Promise.resolve();
    }
    storedHead = [event];
    return Promise.resolve();
  });
  try {
    const manager = new ChannelSectionSyncManager("pk-collide2", RELAY);
    const adopted = [];
    manager.setOnRemoteAdopted((r) => adopted.push(r));
    manager.publishSections(
      makeStore([{ id: "mine", name: "Mine", order: 0 }]),
    );
    await fireDelay(2000);
    while (releaseConfirmation === null) await Promise.resolve();
    manager.publishSections(
      makeStore([{ id: "second", name: "Second", order: 0 }]),
    );
    releaseConfirmation();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    assert.equal(
      adopted.length,
      0,
      "stale-gen adopt must not fire onRemoteAdopted for the newer pending edit",
    );
    assert.notEqual(
      manager.getPendingStore(),
      null,
      "edit-2 still pending after stale-gen adopt",
    );
    await fireDelay(2000);
    for (let i = 0; i < 100; i++) await Promise.resolve();
    assert.equal(publishCalls, 2, "edit-2 publishes above the peer winner");
    assert.equal(adopted.length, 0, "edit-2 must not be adopted away");
    assert.equal(
      manager.getPendingStore(),
      null,
      "edit-2 clears via confirmed publish",
    );
    assert.equal(
      readChannelSectionsOutbox("pk-collide2", RELAY),
      null,
      "edit-2 outbox cleared",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

test("same-second collision: loser adopts the winner and its next edit survives", async () => {
  let fetchCalls = 0;
  let publishCalls = 0;
  let storedHead = [];
  const { fireDelay, restore } = makeTimerBed();
  const tauri = installEchoTauri("pk-loser");
  mock.method(relayClient, "fetchEvents", () => {
    fetchCalls++;
    return Promise.resolve(fetchCalls === 1 ? [] : storedHead);
  });
  const winnerStore = makeStore([{ id: "peer", name: "Peer", order: 0 }]);
  mock.method(relayClient, "publishEvent", (event) => {
    publishCalls++;
    if (publishCalls === 1)
      storedHead = [
        tauri.mintHead(winnerStore, event.created_at, "0-peer-winner"),
      ];
    return Promise.resolve();
  });
  try {
    const manager = new ChannelSectionSyncManager("pk-loser", RELAY);
    const adopted = [];
    manager.setOnRemoteAdopted((r) => adopted.push(r));
    manager.publishSections(
      makeStore([{ id: "loser", name: "Loser", order: 0 }]),
    );
    await fireDelay(2000);
    for (let i = 0; i < 100; i++) await Promise.resolve();
    assert.equal(adopted.length, 1, "loser must adopt the peer winner");
    assert.equal(
      manager.getPendingStore(),
      null,
      "pending cleared after adopt",
    );
    manager.publishSections(
      makeStore([{ id: "mine", name: "Mine", order: 0 }]),
    );
    await fireDelay(2000);
    for (let i = 0; i < 100; i++) await Promise.resolve();
    assert.equal(publishCalls, 2, "edit after adopt must publish successfully");
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// ─── live-sub: undecryptable event advances watermark ────────────────────────

test("revert-fix: undecryptable live event advances watermark before decrypt attempt", async () => {
  let liveCallback = null;
  mock.method(relayClient, "subscribeLive", (_filter, onEvent) => {
    liveCallback = onEvent;
    return Promise.resolve(async () => {});
  });
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelSectionSyncManager("pk-live", RELAY);
    assert.equal(
      fw.localStorage.getItem(
        `buzz-sync-watermark.v1:${watermarkLane}:pk-live:${RELAY_KEY}`,
      ),
      null,
      "watermark starts absent",
    );
    await manager.subscribeToSections(() => {});
    assert.ok(liveCallback !== null, "subscribeLive captured the callback");
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
      "live undecryptable event must advance watermark before decrypt",
    );
    manager.destroy();
  } finally {
    restore();
    mock.reset();
  }
});
