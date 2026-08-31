// Shared parameterized test suite for MergeLaneSyncManager subclasses.
//
// Usage:
//   import { runMergeLaneSyncSuite } from "./mergeLaneSync.shared.test.mjs";
//   runMergeLaneSyncSuite({ label: "stars", Manager: ..., ... });

import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { relayClient } from "@/shared/api/relayClient";
import {
  installFakeWindow,
  installEchoTauri,
  makeFakeWindow,
  makeTimerBed,
} from "./sidebarSyncTestHelpers.mjs";
import { readChannelStarsOutbox } from "./channelStarsStorage.ts";
import { ChannelStarSyncManager } from "./channelStarsSync.ts";

function makeStore(channels = {}) {
  return { version: 1, channels };
}

export function runMergeLaneSyncSuite({
  label,
  Manager,
  readOutbox,
  watermarkKind,
  makeEntry,
  publish,
  getPending,
  fetchRemote,
}) {
  const RELAY = "wss://r.test";
  const RELAY_KEY = encodeURIComponent(RELAY);

  // ─── observe() / high-water ingestion ──────────────────────────────────────

  test(`${label}: observe: high-water is per-channel max of rev and updatedAt, monotonic`, () => {
    const fw = makeFakeWindow();
    const restore = installFakeWindow(fw);
    try {
      const m = new Manager("pk", RELAY);
      m.observe(
        makeStore({ a: makeEntry(true, 100, 3), b: makeEntry(false, 50, 1) }),
      );
      assert.equal(m.maxRevSeen("a"), 3);
      assert.equal(m.maxUpdatedAtSeen("a"), 100);
      m.observe(makeStore({ a: makeEntry(true, 90, 5) }));
      assert.equal(m.maxRevSeen("a"), 5, "rev raised");
      assert.equal(m.maxUpdatedAtSeen("a"), 100, "updatedAt not regressed");
      m.observe(makeStore({ a: makeEntry(true, 200, 2) }));
      assert.equal(m.maxUpdatedAtSeen("a"), 200, "updatedAt raised");
      assert.equal(m.maxRevSeen("a"), 5, "rev not regressed");
      assert.equal(m.maxRevSeen("never"), 0);
      assert.equal(m.maxUpdatedAtSeen("never"), 0);
    } finally {
      restore();
    }
  });

  // ─── destroy() ─────────────────────────────────────────────────────────────

  test(`${label}: destroy: cancels pending publish without flushing to the relay`, () => {
    const publishCalls = [];
    mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
    mock.method(relayClient, "publishEvent", (...args) => {
      publishCalls.push(args);
      return Promise.resolve();
    });
    const fw = makeFakeWindow();
    const restore = installFakeWindow(fw);
    try {
      const manager = new Manager("pk-test", RELAY);
      publish(manager, makeStore({ ch1: makeEntry(true, 100, 1) }));
      manager.destroy();
      assert.equal(publishCalls.length, 0, "no publish after destroy");
      assert.equal(getPending(manager), null);
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
      const manager = new Manager("pk-race", RELAY);
      publish(manager, makeStore({ ch1: makeEntry(true, 100, 1) }));
      fw._fireTimer();
      manager.destroy();
      releaseFetch();
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(
        publishCalls.length,
        0,
        "publishEvent must not be called after destroy",
      );
    } finally {
      restore();
      mock.reset();
    }
  });

  // ─── Generation CAS: A-in-flight → B-click → A-completes ───────────────────
  // Mutation: dropping the generation CAS in discardPending lets A's outcome null B's pending+outbox.

  for (const { name, resolveFirst } of [
    {
      name: "A-succeeds",
      resolveFirst: (event, storedHead, res) => {
        storedHead.push(event);
        res();
      },
    },
    {
      name: "A-fails",
      resolveFirst: (_event, _storedHead, _res, rej) =>
        rej(new Error("socket error")),
    },
  ]) {
    test(`${label}: A-in-flight → B-click → ${name}: B stays pending and B publishes`, async () => {
      let releaseFirst = null;
      let publishCount = 0;
      const storedHead = [];
      mock.method(relayClient, "fetchEvents", () =>
        Promise.resolve([...storedHead]),
      );
      mock.method(relayClient, "publishEvent", (event) => {
        publishCount++;
        if (publishCount === 1)
          return new Promise((res, rej) => {
            releaseFirst = () => resolveFirst(event, storedHead, res, rej);
          });
        storedHead.splice(0, storedHead.length, event);
        return Promise.resolve();
      });
      const t = makeTimerBed();
      const tauri = installEchoTauri(`pk-ab-${name}`);
      try {
        const manager = new Manager(`pk-ab-${name}`, RELAY);
        const storeA = makeStore({ a: makeEntry(true, 100, 1) });
        const storeB = makeStore({ b: makeEntry(true, 101, 1) });
        publish(manager, storeA);
        await t.fireDelay(2000);
        while (releaseFirst === null) await Promise.resolve();
        publish(manager, storeB);
        assert.deepEqual(
          Object.keys(getPending(manager).channels),
          ["b"],
          "B is now pending",
        );
        assert.ok(readOutbox(`pk-ab-${name}`, RELAY), "outbox holds B");
        releaseFirst();
        for (let i = 0; i < 50; i++) await Promise.resolve();
        assert.deepEqual(
          Object.keys(getPending(manager)?.channels ?? {}),
          ["b"],
          `older A completion (${name}) leaves B pending`,
        );
        assert.ok(
          readOutbox(`pk-ab-${name}`, RELAY),
          `older A (${name}) leaves B outbox`,
        );
        const capturedBefore = tauri.capturedPlaintext();
        await t.fireDelay(2000);
        for (let i = 0; i < 50; i++) await Promise.resolve();
        const captured = tauri.capturedPlaintext();
        assert.ok(
          captured && captured !== capturedBefore && captured.includes('"b"'),
          "B published to the relay",
        );
        assert.equal(
          getPending(manager),
          null,
          "B cleared after confirmed publish",
        );
        assert.equal(
          readOutbox(`pk-ab-${name}`, RELAY),
          null,
          "B outbox cleared",
        );
        manager.destroy();
      } finally {
        tauri.restore();
        t.restore();
        mock.reset();
      }
    });
  }

  // ─── Generation guard: pre-sign seam ───────────────────────────────────────
  // Mutation: dropping line 400 lets stale A sign and publish after B is queued.

  test(`${label}: pre-sign guard: a newer edit during encrypt aborts the stale publish`, async () => {
    let releaseEncrypt = null;
    const publishCalls = [];
    mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
    mock.method(relayClient, "publishEvent", (...args) => {
      publishCalls.push(args);
      return Promise.resolve();
    });
    const orig = globalThis.window?.__TAURI_INTERNALS__;
    if (typeof globalThis.window === "undefined") globalThis.window = {};
    let encryptCalls = 0;
    globalThis.window.__TAURI_INTERNALS__ = {
      invoke: (cmd, args) => {
        if (cmd === "nip44_encrypt_to_self") {
          encryptCalls++;
          if (encryptCalls === 1)
            return new Promise((res) => {
              releaseEncrypt = () => res("ct-a");
            });
          return Promise.resolve("ct-b");
        }
        if (cmd === "nip44_decrypt_from_self") return Promise.resolve("{}");
        if (cmd === "sign_event")
          return Promise.resolve(
            JSON.stringify({
              id: `evt-${encryptCalls}`,
              pubkey: "pk-presign",
              content: args?.content ?? "",
              created_at: args?.createdAt ?? 0,
              kind: args?.kind ?? 0,
              tags: args?.tags ?? [],
              sig: "s",
            }),
          );
        return Promise.reject(new Error(`unmocked: ${cmd}`));
      },
    };
    const fw = makeFakeWindow();
    const restore = installFakeWindow(fw);
    try {
      const manager = new Manager("pk-presign", RELAY);
      publish(manager, makeStore({ a: makeEntry(true, 100, 1) }));
      fw._fireTimer();
      while (releaseEncrypt === null) await Promise.resolve();
      publish(manager, makeStore({ b: makeEntry(true, 101, 1) }));
      releaseEncrypt();
      for (let i = 0; i < 50; i++) await Promise.resolve();
      assert.equal(
        publishCalls.length,
        0,
        "stale A must not publish after B queued",
      );
      assert.deepEqual(
        Object.keys(getPending(manager)?.channels ?? {}),
        ["b"],
        "B is still pending",
      );
      manager.destroy();
    } finally {
      if (orig !== undefined) globalThis.window.__TAURI_INTERNALS__ = orig;
      else delete globalThis.window.__TAURI_INTERNALS__;
      restore();
      mock.reset();
    }
  });

  // ─── Bounded-backoff retry ──────────────────────────────────────────────────
  // Mutation: dropping scheduleRetry leaves the edit stranded.

  test(`${label}: failed publish schedules a bounded-backoff retry and keeps the pending edit`, async () => {
    let publishCount = 0;
    let storedHead = [];
    mock.method(relayClient, "fetchEvents", () => Promise.resolve(storedHead));
    mock.method(relayClient, "publishEvent", (event) => {
      publishCount++;
      if (publishCount === 1) return Promise.reject(new Error("timeout"));
      storedHead = [event];
      return Promise.resolve();
    });
    const t = makeTimerBed();
    const tauri = installEchoTauri("pk-retry");
    try {
      const manager = new Manager("pk-retry", RELAY);
      publish(manager, makeStore({ a: makeEntry(true, 100, 1) }));
      await t.fireDelay(2000);
      assert.ok(
        getPending(manager) !== null,
        "pending edit retained after failure",
      );
      assert.ok(t.hasDelay(2000), "retry timer scheduled");
      await t.fireDelay(2000);
      for (let i = 0; i < 50; i++) await Promise.resolve();
      assert.equal(publishCount, 2, "retry re-published");
      assert.equal(
        getPending(manager),
        null,
        "pending cleared on retry success",
      );
      manager.destroy();
    } finally {
      tauri.restore();
      t.restore();
      mock.reset();
    }
  });

  // ─── Retention confirmation (Carl P1) ──────────────────────────────────────
  // Mutation: clearing on OK alone nulls the pending edit and loses the click.

  test(`${label}: publish OK but a peer blob is retained: loser keeps its outbox and retries`, async () => {
    let publishCount = 0;
    let storedHead = [];
    mock.method(relayClient, "fetchEvents", () => Promise.resolve(storedHead));
    const tauri = installEchoTauri("pk-loser");
    mock.method(relayClient, "publishEvent", (event) => {
      publishCount++;
      if (publishCount === 1) {
        storedHead = [
          tauri.mintHead(makeStore({ z: makeEntry(true, 200, 5) }), 100),
        ];
        return Promise.resolve();
      }
      storedHead = [event];
      return Promise.resolve();
    });
    const t = makeTimerBed();
    try {
      const manager = new Manager("pk-loser", RELAY);
      publish(manager, makeStore({ a: makeEntry(true, 100, 1) }));
      await t.fireDelay(2000);
      for (let i = 0; i < 50; i++) await Promise.resolve();
      assert.ok(
        getPending(manager) !== null,
        "unconfirmed publish keeps pending edit",
      );
      assert.ok(readOutbox("pk-loser", RELAY), "loser keeps durable outbox");
      assert.ok(t.hasDelay(2000), "retry scheduled");
      await t.fireDelay(2000);
      for (let i = 0; i < 50; i++) await Promise.resolve();
      assert.equal(publishCount, 2, "loser retried");
      assert.equal(
        getPending(manager),
        null,
        "pending cleared once retained head subsumes click",
      );
      manager.destroy();
    } finally {
      tauri.restore();
      t.restore();
      mock.reset();
    }
  });

  // ─── Boot seed-publish guard ────────────────────────────────────────────────

  for (const {
    title,
    setupFetch,
    setupWatermark,
    relayOverride,
    pubkey,
    assertPending,
  } of [
    {
      title: "fetch error does not trigger seed-publish",
      setupFetch: () =>
        mock.method(relayClient, "fetchEvents", () =>
          Promise.reject(new Error("relay timeout")),
        ),
      assertPending: (m) => assert.equal(getPending(m), null),
    },
    {
      title: "absent fetch with prior watermark blocks seed-publish",
      setupFetch: () =>
        mock.method(relayClient, "fetchEvents", () => Promise.resolve([])),
      setupWatermark: (fw) =>
        fw.localStorage.setItem(
          `buzz-sync-watermark.v1:${watermarkKind}:pk-stale:${RELAY_KEY}`,
          "1700000000",
        ),
      pubkey: "pk-stale",
      assertPending: (m) => assert.equal(getPending(m), null),
    },
    {
      title: "absent fetch with zero watermark seeds (first-sync preserved)",
      setupFetch: () =>
        mock.method(relayClient, "fetchEvents", () => Promise.resolve([])),
      pubkey: "pk-fresh",
      assertPending: (m) => assert.ok(getPending(m) !== null),
    },
    {
      title: "relay-A watermark does not suppress first-sync seed on relay-B",
      setupFetch: () =>
        mock.method(relayClient, "fetchEvents", () => Promise.resolve([])),
      setupWatermark: (fw) =>
        fw.localStorage.setItem(
          `buzz-sync-watermark.v1:${watermarkKind}:pk-iso:${encodeURIComponent("wss://a.relay.test")}`,
          "1700000100",
        ),
      relayOverride: "wss://b.relay.test",
      pubkey: "pk-iso",
      assertPending: (m) =>
        assert.ok(
          getPending(m) !== null,
          "first-sync seed on relay B must not be blocked by relay A watermark",
        ),
    },
  ]) {
    test(`${label}: revert-fix: ${title}`, async () => {
      setupFetch();
      mock.method(relayClient, "publishEvent", () => Promise.resolve());
      const fw = makeFakeWindow();
      setupWatermark?.(fw);
      const restore = installFakeWindow(fw);
      try {
        const manager = new Manager(
          pubkey ?? "pk-fail",
          relayOverride ?? RELAY,
        );
        const result = await manager.bootstrap(
          makeStore({ ch1: makeEntry(true, 1, 0) }),
        );
        assert.equal(result.action, "hold");
        assertPending(manager);
      } finally {
        restore();
        mock.reset();
      }
    });
  }

  // ─── Failed pre-publish fetch: retain, never publish ───────────────────────
  // Mutation: reverting the merge-lane catch to `publish` fires publishEvent.

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
    const tauri = installEchoTauri("pk-fetchfail");
    try {
      const manager = new Manager("pk-fetchfail", RELAY);
      publish(manager, makeStore({ a: makeEntry(true, 100, 1) }));
      fw._fireTimer();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(
        publishCalls.length,
        0,
        "must not publish when pre-publish fetch failed",
      );
      assert.ok(
        getPending(manager) !== null,
        "failed fetch retains pending edit",
      );
      assert.ok(
        readOutbox("pk-fetchfail", RELAY),
        "durable outbox survives failed fetch",
      );
      assert.ok(fw._hasTimer(), "retry scheduled");
    } finally {
      tauri.restore();
      restore();
      mock.reset();
    }
  });

  // ─── Unreadable / unsupported head: retain, never publish ──────────────────

  for (const { title, setupHead, pubkey } of [
    {
      title: "unreadable head (decrypt failure)",
      pubkey: "pk-undec",
      setupHead: (tauri) => {
        mock.method(relayClient, "fetchEvents", () =>
          Promise.resolve([
            {
              pubkey: "pk-undec",
              content: "unregistered-cipher",
              created_at: 500,
              id: "evt-undec",
            },
          ]),
        );
        return tauri;
      },
    },
    {
      title: "unsupported head payload schema",
      pubkey: "pk-badver",
      setupHead: (tauri) => {
        const head = tauri.mintHead({ version: 2, channels: {} }, 500);
        mock.method(relayClient, "fetchEvents", () => Promise.resolve([head]));
        return tauri;
      },
    },
  ]) {
    test(`${label}: ${title} retains the pending edit and retries, never publishing`, async () => {
      const fw = makeFakeWindow();
      const restore = installFakeWindow(fw);
      const tauri = installEchoTauri(pubkey);
      setupHead(tauri);
      const publishCalls = [];
      mock.method(relayClient, "publishEvent", (...args) => {
        publishCalls.push(args);
        return Promise.resolve();
      });
      try {
        const manager = new Manager(pubkey, RELAY);
        publish(manager, makeStore({ a: makeEntry(true, 100, 1) }));
        fw._fireTimer();
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(publishCalls.length, 0, `${title}: must not publish`);
        assert.ok(getPending(manager) !== null, `${title}: pending retained`);
        assert.ok(fw._hasTimer(), "retry scheduled");
      } finally {
        tauri.restore();
        restore();
        mock.reset();
      }
    });
  }

  // ─── Timestamp clamp ────────────────────────────────────────────────────────
  // Mutation: removing the clamp lets createdAt = lastRemote+1 (~now+3600).

  test(`${label}: timestamp clamp: published createdAt stays inside the relay future window`, async () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const farFutureHead = nowSecs + 3_600;
    const fw = makeFakeWindow();
    const restore = installFakeWindow(fw);
    const tauri = installEchoTauri("pk-clamp");
    const head = tauri.mintHead(makeStore({}), farFutureHead);
    mock.method(relayClient, "fetchEvents", () => Promise.resolve([head]));
    let signedCreatedAt = null;
    mock.method(relayClient, "publishEvent", (evt) => {
      signedCreatedAt = evt.created_at;
      return Promise.resolve();
    });
    try {
      const manager = new Manager("pk-clamp", RELAY);
      await fetchRemote(manager);
      publish(manager, makeStore({ ch1: makeEntry(true, 100, 1) }));
      fw._fireTimer();
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(signedCreatedAt !== null, "publish must have been attempted");
      assert.ok(
        signedCreatedAt <= Math.floor(Date.now() / 1000) + 840,
        `createdAt clamped — got ${signedCreatedAt}`,
      );
    } finally {
      tauri.restore();
      restore();
      mock.reset();
    }
  });
}

// ─── Authoritative engine invocation (once, against ChannelStarSyncManager) ──
// Each case exercises MergeLaneSyncManager directly; ChannelStarSyncManager is
// the canonical concrete subclass. channelStarsSync.test.mjs and
// channelMutesSync.test.mjs cover per-lane wire contracts separately.
runMergeLaneSyncSuite({
  label: "stars",
  Manager: ChannelStarSyncManager,
  readOutbox: readChannelStarsOutbox,
  watermarkKind: "channel-stars",
  makeEntry: (starred, updatedAt, rev) => ({ starred, updatedAt, rev }),
  publish: (m, s) => m.publishStars(s),
  getPending: (m) => m.getPendingStarStore(),
  fetchRemote: (m) => m.fetchRemoteStars(),
});
