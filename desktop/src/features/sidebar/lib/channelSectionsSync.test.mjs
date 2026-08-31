import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { relayClient } from "@/shared/api/relayClient";
import { ChannelSectionSyncManager } from "./channelSectionsSync.ts";
import {
  makeFakeWindow,
  installFakeWindow,
  makeTimerBed,
  installTauriMock,
  installEchoTauri,
} from "./sidebarSyncTestHelpers.mjs";

// Shared whole-blob engine invariants are covered by wholeBlobSync.shared.test.mjs.
// This file covers only sections-specific adapter and lane behavior.

function makeSectionsStore(sections = []) {
  return { version: 1, sections, assignments: {} };
}
const RELAY = "wss://r.test";

// ─── Sections-specific: malformed head payload ────────────────────────────────

// Mutation: removing `if (obj.version !== 1) return null` from
// parseChannelSectionPayload lets the manager fall through to a publish that
// overwrites state it cannot understand.
for (const { title, pubkey, payload } of [
  {
    title: "malformed (non-JSON) head",
    pubkey: "pk-badver",
    payload: "not-json{",
  },
  {
    title: "unsupported head payload version (v2)",
    pubkey: "pk-secver",
    payload: JSON.stringify({ version: 2, sections: [], assignments: {} }),
  },
]) {
  test(`${title} retains the pending edit, never publishing`, async () => {
    mock.method(relayClient, "fetchEvents", () =>
      Promise.resolve([
        { pubkey, content: "good-cipher", created_at: 500, id: "evt" },
      ]),
    );
    const publishCalls = [];
    mock.method(relayClient, "publishEvent", (...args) => {
      publishCalls.push(args);
      return Promise.resolve();
    });
    const fw = makeFakeWindow();
    const restore = installFakeWindow(fw);
    const tauri = installTauriMock(payload);
    try {
      const manager = new ChannelSectionSyncManager(pubkey, RELAY);
      manager.publishSections(
        makeSectionsStore([{ id: "s1", name: "Work", order: 0 }]),
      );
      fw._fireTimer();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(
        publishCalls.length,
        0,
        "must not publish over unparseable head",
      );
      assert.ok(
        manager.getPendingStore() !== null,
        "malformed head retains the pending edit",
      );
      assert.ok(fw._hasTimer(), "retry scheduled");
    } finally {
      tauri.restore();
      restore();
      mock.reset();
    }
  });
}

// ─── Sections-specific: serialized generations ────────────────────────────────

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
  const { timers, fireDelay, restore } = makeTimerBed();
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
      "B is pending",
    );
    releaseFirst();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    if ([...timers.values()].some((t) => t.ms === 2000)) await fireDelay(2000);
    assert.deepEqual(adopted, [], "B must not adopt older generation A");
    assert.equal(publishCalls, 2, "B publishes above A");
    assert.equal(
      manager.getPendingStore(),
      null,
      "B clears via confirmed publish",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// Mutation: dropping the post-fetch generation re-check in doPublish lets stale A
// continue to publishEvent.
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
  const { fireDelay, restore } = makeTimerBed();
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
      "stale A must not publish after B was queued",
    );
    assert.deepEqual(
      manager.getPendingStore()?.sections.map((s) => s.id),
      ["b"],
      "B remains pending",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// ─── Sections-specific: ambiguous ACK ────────────────────────────────────────

// Blockable Tauri seam: decrypt echoes `payload`; sign returns `signIds[i]`;
// first encrypt call can be blocked.
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

const SEAM_PAYLOAD = JSON.stringify({
  version: 1,
  sections: [{ id: "a", name: "A", order: 0 }],
  assignments: {},
});
const SEAM_EVENT = (id) => ({
  id,
  pubkey: "pk-ambiguous",
  content: "good-cipher",
  created_at: 500,
  kind: 30078,
  tags: [["d", "channel-sections"]],
  sig: "s",
});

// Ambiguous ACK: relay accepts A but ACK is lost. B was queued mid-flight. B must
// recognise A as OUR OWN accepted predecessor and fold it forward, not adopt it.
// Mutation: dropping ambiguousAttemptIds fold makes B classify A as foreign and adopt.
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
          storedHead = [SEAM_EVENT("event-a")];
          reject(new Error("Timed out publishing channel sections."));
        };
      });
    }
    storedHead = [SEAM_EVENT("event-b")];
    return Promise.resolve();
  });
  const { timers, fireDelay, restore } = makeTimerBed();
  const tauri = installSeamTauriMock(SEAM_PAYLOAD, ["event-a", "event-b"]);
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
    assert.deepEqual(adopted, [], "B must not adopt A when A's ACK was lost");
    assert.equal(
      publishCalls,
      2,
      "B publishes above A's ambiguously-accepted head",
    );
    assert.equal(
      manager.getPendingStore(),
      null,
      "B clears after successful publish",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// A foreign head (id NOT in our attempt set) must be adopted, not folded.
// Mutation: dropping the id-guard (folding any advance) makes B erase the foreign winner.
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
  const { timers, fireDelay, restore } = makeTimerBed();
  const tauri = installSeamTauriMock(SEAM_PAYLOAD, ["event-a", "event-b"]);
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
    assert.deepEqual(adopted, ["foreign-winner"], "B adopts the foreign head");
    assert.equal(manager.getPendingStore(), null, "adopt clears pending");
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// Pre-sign generation guard: B arrives DURING A's encrypt/sign await — past the
// post-fetch guard — so only the pre-sign guard can stop A.
// Mutation: dropping the gen re-check at the pre-sign guard lets stale A reach publishEvent.
test("serialized generations: a newer edit during encrypt/sign aborts the pre-sign publish", async () => {
  const publishCalls = [];
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "publishEvent", (event) => {
    publishCalls.push(event);
    return Promise.resolve();
  });
  const { timers, fireDelay, restore } = makeTimerBed();
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
      "only B publishes; stale A aborts at pre-sign guard",
    );
    assert.equal(publishCalls[0].id, "event-b", "the surviving publish is B");
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});
