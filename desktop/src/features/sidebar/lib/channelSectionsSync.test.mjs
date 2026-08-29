import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { relayClient } from "@/shared/api/relayClient";
import { readChannelSectionsOutbox } from "./channelSectionsStorage.ts";
import { ChannelSectionSyncManager } from "./channelSectionsSync.ts";
import {
  makeFakeWindow,
  installFakeWindow,
  installTauriMock,
  installEchoTauri,
} from "./sidebarSyncTestHelpers.mjs";
import { runWholeBlobSyncSuite } from "./wholeBlobSync.shared.test.mjs";

function makeSectionsStore(sections = []) {
  return { version: 1, sections, assignments: {} };
}

const RELAY = "wss://r.test";

// ─── 17 shared whole-blob sync invariants ─────────────────────────────────────

runWholeBlobSyncSuite({
  label: "sections",
  SyncManager: ChannelSectionSyncManager,
  publishMethod: "publishSections",
  fetchRemoteMethod: "fetchRemoteSections",
  subscribeMethod: "subscribeToSections",
  watermarkLane: "channel-sections",
  readOutbox: readChannelSectionsOutbox,
  makeNonEmptyStore: () =>
    makeSectionsStore([{ id: "s1", name: "Work", order: 0 }]),
  decryptPayload: JSON.stringify({
    version: 1,
    sections: [{ id: "remote-section-from-relay", name: "Remote", order: 0 }],
    assignments: {},
  }),
  emptyDecryptPayload: JSON.stringify({
    version: 1,
    sections: [],
    assignments: {},
  }),
  checkAdoptedStore: (store) =>
    store.sections.some((s) => s.id === "remote-section-from-relay"),
  makeOverlapStoreA: () =>
    makeSectionsStore([{ id: "a", name: "A", order: 0 }]),
  makeOverlapStoreB: () =>
    makeSectionsStore([{ id: "b", name: "B", order: 0 }]),
  checkOverlapPending: (store) => store?.sections?.[0]?.id === "b",
  checkOverlapOutbox: (outbox) => outbox?.store?.sections?.[0]?.id === "b",
  makeLiveDebounceStore: () =>
    makeSectionsStore([{ id: "local", name: "Local", order: 0 }]),
  liveRemoteDecryptPayload: JSON.stringify({
    version: 1,
    sections: [{ id: "remote-during-debounce", name: "Remote", order: 0 }],
    assignments: {},
  }),
  makeCollisionStoreA: () =>
    makeSectionsStore([{ id: "mine", name: "Mine", order: 0 }]),
  makeCollisionWinnerStore: () =>
    makeSectionsStore([{ id: "peer", name: "Peer", order: 0 }]),
  makeCollisionStoreSnd: () =>
    makeSectionsStore([{ id: "second", name: "Second", order: 0 }]),
  makeCollisionStoreLsr: () =>
    makeSectionsStore([{ id: "loser", name: "Loser", order: 0 }]),
});

// ─── Sections-specific: malformed (non-JSON) head payload ─────────────────────

// A malformed payload that decrypts to non-JSON is equally unreadable:
// `decryptAndParse` throws in `JSON.parse` and returns null, so the manager
// must `retain`, not overwrite.
test("malformed (non-JSON) head payload retains the pending edit, never publishing", async () => {
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
  const tauri = installTauriMock("not-json{");
  try {
    const manager = new ChannelSectionSyncManager("pk-badver", RELAY);
    manager.publishSections(
      makeSectionsStore([{ id: "s1", name: "Work", order: 0 }]),
    );
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      publishCalls.length,
      0,
      "must not publish over a head whose payload we could not parse",
    );
    assert.ok(
      manager.getPendingStore() !== null,
      "malformed head must retain the pending edit",
    );
    assert.ok(fw._hasTimer(), "a retry must be scheduled");
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// ─── Sections-specific: unsupported version (Carl P1.2 regression) ────────────

// Carl P1.2 regression (sections): an unsupported/future payload version
// arriving from the relay must trigger the retain/retry path, never publish
// over it. Sort, stars, and mutes all check `version !== 1` in their parsers;
// sections was the odd one out. `parseChannelSectionPayload` now rejects
// non-v1 payloads so `decryptAndParse` returns null and the manager retains.
//
// Mutation: removing `if (obj.version !== 1) return null` from
// `parseChannelSectionPayload` causes the parser to accept the v2 blob as v1
// state, `decryptAndParse` returns a non-null result, and the manager falls
// through to a publish that overwrites authoritative state this client does not
// understand.
test("unsupported head payload version (sections) retains the pending edit, never publishing", async () => {
  mock.method(relayClient, "fetchEvents", () =>
    Promise.resolve([
      {
        pubkey: "pk-secver",
        content: "good-cipher",
        created_at: 500,
        id: "evt-secver",
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
    JSON.stringify({ version: 2, sections: [], assignments: {} }),
  );
  try {
    const manager = new ChannelSectionSyncManager("pk-secver", RELAY);
    manager.publishSections(
      makeSectionsStore([{ id: "s1", name: "Work", order: 0 }]),
    );
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

// ─── Sections-specific: serialized generations ───────────────────────────────

// An older in-flight publish that completes after a newer edit is queued must
// NOT be mistaken for a remote that advanced past the newer edit's baseline.
// Mutation: freezing the baseline at publishSections (before the prior cycle
// completes) makes B see A as a post-baseline remote and adopt it.
test("serialized generations: older completion does not make the newer edit adopt it", async () => {
  let releaseFirst = null;
  let publishCalls = 0;
  let storedHead = [];
  mock.method(relayClient, "fetchEvents", () => Promise.resolve(storedHead));
  mock.method(relayClient, "publishEvent", (event) => {
    publishCalls++;
    if (publishCalls === 1) {
      return new Promise((res) => {
        releaseFirst = () => {
          storedHead = [event];
          res();
        };
      });
    }
    storedHead = [event];
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
  const restore = installFakeWindow(fakeWindow);
  const tauri = installEchoTauri("pk-serial");
  try {
    const manager = new ChannelSectionSyncManager("pk-serial", RELAY);
    const adopted = [];
    manager.setOnRemoteAdopted((remote) => adopted.push(remote.eventId));
    manager.publishSections(
      makeSectionsStore([{ id: "a", name: "A", order: 0 }]),
    );
    await fireDelay(2000);
    while (releaseFirst === null) await Promise.resolve();
    manager.publishSections(
      makeSectionsStore([{ id: "b", name: "B", order: 0 }]),
    );
    assert.deepEqual(
      manager.getPendingStore()?.sections.map((s) => s.id),
      ["b"],
      "B is the pending edit while A is in flight",
    );
    releaseFirst();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    if ([...timers.values()].some((t) => t.ms === 2000)) await fireDelay(2000);
    assert.deepEqual(adopted, [], "B must not adopt the older generation A");
    assert.equal(
      publishCalls,
      2,
      "B publishes above A rather than adopting A's accepted head",
    );
    assert.equal(
      manager.getPendingStore(),
      null,
      "B's pending clears via its own confirmed publish",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// A stale generation must never sign/publish after a newer edit is queued.
// Mutation: dropping the post-fetch generation re-check in doPublish lets the
// stale A continue to publishEvent.
test("serialized generations: a stale generation aborts before publishing", async () => {
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
  const storage = new Map();
  const timers = new Map();
  let nextId = 1;
  const fakeWindow = {
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
  const restore = installFakeWindow(fakeWindow);
  const tauri = installTauriMock("{}");
  try {
    const manager = new ChannelSectionSyncManager("pk-stale", RELAY);
    manager.publishSections(
      makeSectionsStore([{ id: "a", name: "A", order: 0 }]),
    );
    await fireDelay(2000);
    while (releaseFetch === null) await Promise.resolve();
    manager.publishSections(
      makeSectionsStore([{ id: "b", name: "B", order: 0 }]),
    );
    releaseFetch();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    assert.equal(
      publishCalls.length,
      0,
      "stale generation A must not sign/publish after B was queued",
    );
    assert.deepEqual(
      manager.getPendingStore()?.sections.map((s) => s.id),
      ["b"],
      "B remains the pending edit",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// ─── Sections-specific: ambiguous ACK ────────────────────────────────────────

// Installs a Tauri mock whose sign_event returns a caller-controlled id per
// call (so overlapping publishes get distinct event ids) and whose
// nip44_encrypt_to_self can be made to block.
function installSeamTauriMock(payload, signIds) {
  const orig = globalThis.window?.__TAURI_INTERNALS__;
  if (typeof globalThis.window === "undefined") globalThis.window = {};
  let signCall = 0;
  let releaseEncrypt = null;
  let blockNextEncrypt = false;
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      if (cmd === "nip44_decrypt_from_self") return Promise.resolve(payload);
      if (cmd === "nip44_encrypt_to_self") {
        if (!blockNextEncrypt) return Promise.resolve("ct");
        blockNextEncrypt = false;
        return new Promise((res) => {
          releaseEncrypt = () => res("ct");
        });
      }
      if (cmd === "sign_event") {
        const id = signIds[Math.min(signCall, signIds.length - 1)];
        signCall++;
        return Promise.resolve(
          JSON.stringify({
            id,
            pubkey: "pk",
            content: "ct",
            created_at: args?.createdAt ?? 0,
            kind: args?.kind ?? 0,
            tags: args?.tags ?? [],
            sig: "s",
          }),
        );
      }
      return Promise.reject(new Error(`unmocked: ${cmd}`));
    },
  };
  return {
    restore: () => {
      if (orig !== undefined) globalThis.window.__TAURI_INTERNALS__ = orig;
      else delete globalThis.window.__TAURI_INTERNALS__;
    },
    armEncryptBlock: () => {
      blockNextEncrypt = true;
    },
    releaseEncrypt: () => releaseEncrypt?.(),
    hasEncryptBlocked: () => releaseEncrypt !== null,
  };
}

// Ambiguous ACK: the relay accepts A but the client's ACK is lost. B was queued
// mid-flight. When B's pre-publish fetch returns A's accepted head, it must
// recognise A as OUR OWN accepted predecessor — fold it forward and publish
// above it — not adopt it and erase B.
// Mutation: dropping the ambiguousAttemptIds fold makes B classify A as a
// foreign advance and adopt.
test("ambiguous ACK: an accepted-but-unacked A does not make B adopt and disappear", async () => {
  let releaseFirst = null;
  let publishCalls = 0;
  let storedHead = [];
  mock.method(relayClient, "fetchEvents", () => Promise.resolve(storedHead));
  mock.method(relayClient, "publishEvent", (event) => {
    publishCalls++;
    if (publishCalls === 1) {
      return new Promise((_res, reject) => {
        releaseFirst = () => {
          storedHead = [
            {
              id: "event-a",
              pubkey: "pk-ambiguous",
              content: "good-cipher",
              created_at: event.created_at,
              kind: 30078,
              tags: [["d", "channel-sections"]],
              sig: "s",
            },
          ];
          reject(new Error("Timed out publishing channel sections."));
        };
      });
    }
    storedHead = [
      {
        id: "event-b",
        pubkey: "pk-ambiguous",
        content: "good-cipher",
        created_at: event.created_at,
        kind: 30078,
        tags: [["d", "channel-sections"]],
        sig: "s",
      },
    ];
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
  const restore = installFakeWindow(fakeWindow);
  const tauri = installSeamTauriMock(
    JSON.stringify({
      version: 1,
      sections: [{ id: "a", name: "A", order: 0 }],
      assignments: {},
    }),
    ["event-a", "event-b"],
  );
  try {
    const manager = new ChannelSectionSyncManager("pk-ambiguous", RELAY);
    const adopted = [];
    manager.setOnRemoteAdopted((r) => adopted.push(r.eventId));
    manager.publishSections(
      makeSectionsStore([{ id: "a", name: "A", order: 0 }]),
    );
    await fireDelay(2000);
    while (releaseFirst === null) await Promise.resolve();
    manager.publishSections(
      makeSectionsStore([{ id: "b", name: "B", order: 0 }]),
    );
    releaseFirst();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    if ([...timers.values()].some((t) => t.ms === 2000)) await fireDelay(2000);
    for (let i = 0; i < 100; i++) await Promise.resolve();
    assert.deepEqual(
      adopted,
      [],
      "B must not adopt A when A was accepted but its ACK was lost",
    );
    assert.equal(
      publishCalls,
      2,
      "B publishes above A's ambiguously-accepted head",
    );
    assert.equal(
      manager.getPendingStore(),
      null,
      "B's own successful publish clears its pending edit",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// A foreign head (id NOT in our attempt set) must be adopted, not folded.
// Mutation: dropping the ambiguousAttemptIds id-guard (folding any advance)
// makes B erase the foreign winner.
test("ambiguous ACK: a foreign head is adopted, not folded as our own", async () => {
  let publishCalls = 0;
  let fetchCalls = 0;
  mock.method(relayClient, "fetchEvents", () => {
    fetchCalls++;
    if (fetchCalls === 1) return Promise.resolve([]);
    return Promise.resolve([
      {
        id: "foreign-winner",
        pubkey: "pk-reject",
        content: "good-cipher",
        created_at: 500,
        kind: 30078,
        tags: [["d", "channel-sections"]],
        sig: "s",
      },
    ]);
  });
  mock.method(relayClient, "publishEvent", () => {
    publishCalls++;
    if (publishCalls === 1)
      return Promise.reject(
        new Error("Timed out publishing channel sections."),
      );
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
  const restore = installFakeWindow(fakeWindow);
  const tauri = installSeamTauriMock(
    JSON.stringify({
      version: 1,
      sections: [{ id: "a", name: "A", order: 0 }],
      assignments: {},
    }),
    ["event-a", "event-b"],
  );
  try {
    const manager = new ChannelSectionSyncManager("pk-reject", RELAY);
    const adopted = [];
    manager.setOnRemoteAdopted((r) => adopted.push(r.eventId));
    manager.publishSections(
      makeSectionsStore([{ id: "a", name: "A", order: 0 }]),
    );
    await fireDelay(2000);
    for (let i = 0; i < 100; i++) await Promise.resolve();
    manager.publishSections(
      makeSectionsStore([{ id: "b", name: "B", order: 0 }]),
    );
    if ([...timers.values()].some((t) => t.ms === 2000)) await fireDelay(2000);
    for (let i = 0; i < 100; i++) await Promise.resolve();
    assert.deepEqual(
      adopted,
      ["foreign-winner"],
      "B adopts the foreign head; its id is not one of our attempts",
    );
    assert.equal(
      manager.getPendingStore(),
      null,
      "adopt clears the pending edit",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// Pre-sign generation guard seam: the guard immediately before signing/publishing
// (post-encrypt) must be individually load-bearing. B arrives DURING A's
// encrypt/sign await — past the post-fetch guard — so only the pre-sign guard
// can stop A publishing a stale store.
// Mutation: dropping the gen re-check at the pre-sign guard lets stale A reach
// publishEvent after B was queued.
test("serialized generations: a newer edit during encrypt/sign aborts the pre-sign publish", async () => {
  const publishCalls = [];
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "publishEvent", (event) => {
    publishCalls.push(event);
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
  const restore = installFakeWindow(fakeWindow);
  const tauri = installSeamTauriMock("{}", ["event-a", "event-b"]);
  try {
    const manager = new ChannelSectionSyncManager("pk-seam", RELAY);
    tauri.armEncryptBlock();
    manager.publishSections(
      makeSectionsStore([{ id: "a", name: "A", order: 0 }]),
    );
    await fireDelay(2000);
    while (!tauri.hasEncryptBlocked()) await Promise.resolve();
    manager.publishSections(
      makeSectionsStore([{ id: "b", name: "B", order: 0 }]),
    );
    tauri.releaseEncrypt();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    if ([...timers.values()].some((t) => t.ms === 2000)) await fireDelay(2000);
    for (let i = 0; i < 100; i++) await Promise.resolve();
    assert.equal(
      publishCalls.length,
      1,
      "only B publishes; stale A aborts at the pre-sign guard",
    );
    assert.equal(
      publishCalls[0].id,
      "event-b",
      "the surviving publish is B, not the stale A",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});
