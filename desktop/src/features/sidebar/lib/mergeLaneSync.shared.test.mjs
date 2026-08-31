// Shared parameterized test suite for MergeLaneSyncManager subclasses
// (ChannelStarSyncManager, ChannelMuteSyncManager, and any future merge-lane).
//
// Usage:
//   import { runMergeLaneSyncSuite } from "./mergeLaneSync.shared.test.mjs";
//   runMergeLaneSyncSuite({
//     label:         "stars",
//     Manager:       ChannelStarSyncManager,
//     readOutbox:    readChannelStarsOutbox,
//     watermarkKind: "channel-stars",
//     makeEntry:     (v, updatedAt, rev) => ({ starred: v, updatedAt, rev }),
//     publish:       (m, s) => m.publishStars(s),
//     getPending:    (m)    => m.getPendingStarStore(),
//     fetchRemote:   (m)    => m.fetchRemoteStars(),
//   });

import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { relayClient } from "@/shared/api/relayClient";
import {
  installFakeWindow,
  installEchoTauri,
  makeFakeWindow,
} from "./sidebarSyncTestHelpers.mjs";

function makeStore(channels = {}) {
  return { version: 1, channels };
}

// Multi-slot timer fake keyed by delay, for overlapping-publish tests. Mirrors
// the sections suite convention (channelSectionsSync.test.mjs).
function makeMultiTimerWindow() {
  const storage = new Map();
  const timers = new Map();
  let nextId = 1;
  const win = {
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
  return {
    win,
    storage,
    timers,
    fireDelay: async (ms) => {
      const entry = [...timers.entries()].find(([, v]) => v.ms === ms);
      assert.ok(entry, `expected a timer scheduled at ${ms}ms`);
      timers.delete(entry[0]);
      entry[1].fn();
      for (let i = 0; i < 50; i++) await Promise.resolve();
    },
    hasDelay: (ms) => [...timers.values()].some((t) => t.ms === ms),
  };
}

/**
 * Run the full merge-lane invariant suite for a single lane.
 *
 * @param {object} cfg
 * @param {string}   cfg.label         - Human-readable lane name for test titles.
 * @param {Function} cfg.Manager       - The MergeLaneSyncManager subclass constructor.
 * @param {Function} cfg.readOutbox    - readChannel{Stars|Mutes}Outbox(pubkey, relay).
 * @param {string}   cfg.watermarkKind - The d-tag string (e.g. "channel-stars").
 * @param {Function} cfg.makeEntry     - (value, updatedAt, rev) => lane entry object.
 * @param {Function} cfg.publish       - (manager, store) => void — calls the typed publish method.
 * @param {Function} cfg.getPending    - (manager) => store | null — calls the typed getter.
 * @param {Function} cfg.fetchRemote   - (manager) => Promise — calls the typed fetch.
 */
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

  // ─── observe() / high-water ingestion ───────────────────────────────────────

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
      // A later observation raises each dimension independently; a lower one
      // never regresses either.
      m.observe(makeStore({ a: makeEntry(true, 90, 5) }));
      assert.equal(m.maxRevSeen("a"), 5, "rev raised");
      assert.equal(m.maxUpdatedAtSeen("a"), 100, "updatedAt not regressed");
      m.observe(makeStore({ a: makeEntry(true, 200, 2) }));
      assert.equal(m.maxUpdatedAtSeen("a"), 200, "updatedAt raised");
      assert.equal(m.maxRevSeen("a"), 5, "rev not regressed");
      // Unseen channel reports zero on both dimensions.
      assert.equal(m.maxRevSeen("never"), 0);
      assert.equal(m.maxUpdatedAtSeen("never"), 0);
    } finally {
      restore();
    }
  });

  // ─── destroy() must cancel pending publish, not flush ───────────────────────

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

  // ─── Generation CAS: A-in-flight → B-click → A-completes (both variants) ────

  // Finding 2: an older in-flight publish that completes (succeeds or fails) after
  // a newer edit is queued must NOT clear B, and B must reach the relay via the
  // serialized re-drive / completion re-drive. Mutation: dropping the generation
  // CAS in discardPending lets A's outcome null out B's pending+outbox.
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
        if (publishCount === 1) {
          return new Promise((res, rej) => {
            releaseFirst = () => resolveFirst(event, storedHead, res, rej);
          });
        }
        storedHead.splice(0, storedHead.length, event);
        return Promise.resolve();
      });
      const t = makeMultiTimerWindow();
      const restore = installFakeWindow(t.win);
      const tauri = installEchoTauri(`pk-ab-${name}`);
      try {
        const manager = new Manager(`pk-ab-${name}`, RELAY);
        const storeA = makeStore({ a: makeEntry(true, 100, 1) });
        const storeB = makeStore({ b: makeEntry(true, 101, 1) });

        publish(manager, storeA);
        await t.fireDelay(2000); // doPublish(A) awaits publishEvent
        while (releaseFirst === null) await Promise.resolve();

        // B arrives while A is in flight.
        publish(manager, storeB);
        assert.deepEqual(
          Object.keys(getPending(manager).channels),
          ["b"],
          "B is now pending",
        );
        assert.ok(readOutbox(`pk-ab-${name}`, RELAY), "outbox holds B");

        // A completes (success or failure) — must NOT clear B.
        releaseFirst();
        for (let i = 0; i < 50; i++) await Promise.resolve();
        assert.deepEqual(
          Object.keys(getPending(manager)?.channels ?? {}),
          ["b"],
          `older A completion (${name}) leaves B pending`,
        );
        assert.ok(
          readOutbox(`pk-ab-${name}`, RELAY),
          `older A completion (${name}) leaves B outbox`,
        );

        // B's own debounce fires and B reaches the relay; the retained-head fetch
        // confirms subsumption, so B's outbox clears.
        const capturedBefore = tauri.capturedPlaintext();
        await t.fireDelay(2000);
        for (let i = 0; i < 50; i++) await Promise.resolve();
        const captured = tauri.capturedPlaintext();
        assert.ok(
          captured && captured !== capturedBefore && captured.includes('"b"'),
          "B is published to the relay",
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
        restore();
        mock.reset();
      }
    });
  }

  // ─── Bounded-backoff retry: failed publish on a healthy socket, no later edit

  // Finding 2: a transient publish failure with the socket open and NO further
  // click must self-heal via the bounded-backoff retry — the pending edit is kept
  // and a retry timer is scheduled. Mutation: dropping scheduleRetry leaves the
  // edit stranded (Will's "make another change to kick it" symptom).
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
    const t = makeMultiTimerWindow();
    const restore = installFakeWindow(t.win);
    const tauri = installEchoTauri("pk-retry");
    try {
      const manager = new Manager("pk-retry", RELAY);
      publish(manager, makeStore({ a: makeEntry(true, 100, 1) }));
      await t.fireDelay(2000); // debounce → doPublish → publishEvent rejects
      assert.ok(
        getPending(manager) !== null,
        "pending edit retained after failure",
      );
      assert.ok(
        t.hasDelay(2000),
        "a retry timer at RETRY_BASE_MS is scheduled",
      );

      // The retry fires and the second publish succeeds; the retained-head fetch
      // confirms the write → pending cleared.
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
      restore();
      mock.reset();
    }
  });

  // ─── Retention confirmation (Carl P1): OK is not proof of retention ──────────

  // The relay OKs a superseded NIP-33 write as a no-op, so two windows racing
  // distinct blobs from the same head can both get OK while only one is retained.
  // The loser must NOT clear its durable outbox on OK alone: it fetches the
  // authoritative retained head and clears only when that head subsumes its
  // write. A retained head carrying a peer's distinct blob does not subsume the
  // loser's click, so the outbox is kept and a retry is scheduled.
  // Mutation: clearing on OK alone (dropping confirmRetainedHeadSubsumes) would
  // null the pending edit here and lose the click.
  test(`${label}: publish OK but a peer blob is retained: loser keeps its outbox and retries`, async () => {
    let publishCount = 0;
    // The retained head is a peer window's distinct blob from the same base —
    // it does NOT contain our channel `a`, so it cannot subsume our write.
    let storedHead = [];
    mock.method(relayClient, "fetchEvents", () => Promise.resolve(storedHead));
    const tauri = installEchoTauri("pk-loser");
    mock.method(relayClient, "publishEvent", (event) => {
      publishCount++;
      if (publishCount === 1) {
        // Our write is OK'd by the relay but immediately superseded: the retained
        // head is the peer's blob for a different channel, minted through the
        // same echo seam so it decrypts.
        storedHead = [
          tauri.mintHead(makeStore({ z: makeEntry(true, 200, 5) }), 100),
        ];
        return Promise.resolve();
      }
      // The retry (which max-merges the peer head in) is retained.
      storedHead = [event];
      return Promise.resolve();
    });
    const t = makeMultiTimerWindow();
    const restore = installFakeWindow(t.win);
    try {
      const manager = new Manager("pk-loser", RELAY);
      publish(manager, makeStore({ a: makeEntry(true, 100, 1) }));
      await t.fireDelay(2000); // publish OK, but peer blob is what's retained
      for (let i = 0; i < 50; i++) await Promise.resolve();

      assert.ok(
        getPending(manager) !== null,
        "unconfirmed publish keeps the pending edit",
      );
      assert.ok(
        readOutbox("pk-loser", RELAY),
        "loser keeps its durable outbox — OK is not proof of retention",
      );
      assert.ok(t.hasDelay(2000), "a retry is scheduled");

      // The retry re-publishes the max-merge of our click and the peer head; this
      // time it is retained (subsumes our `a`) and the outbox clears.
      await t.fireDelay(2000);
      for (let i = 0; i < 50; i++) await Promise.resolve();
      assert.equal(publishCount, 2, "loser retried");
      assert.equal(
        getPending(manager),
        null,
        "pending cleared once the retained head subsumes our click",
      );
      manager.destroy();
    } finally {
      tauri.restore();
      restore();
      mock.reset();
    }
  });

  // ─── Boot seed-publish guard (the revert-fix regression suite) ───────────────

  for (const {
    title,
    setupFetch,
    setupWatermark,
    relayOverride,
    pubkey,
    assertPending,
  } of [
    {
      title: "fetch failed (error) does not trigger seed-publish via bootstrap",
      setupFetch: () =>
        mock.method(relayClient, "fetchEvents", () =>
          Promise.reject(new Error("relay timeout")),
        ),
      assertPending: (m) => assert.equal(getPending(m), null),
    },
    {
      title:
        "absent fetch with prior watermark blocks seed-publish via bootstrap",
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
      title:
        "absent fetch with zero watermark seeds via bootstrap (first-sync preserved)",
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

  // ─── Failed pre-publish fetch: retain, never publish (Carl P1) ───────────────

  // The pre-publish fetch THROWS (timeout / auth / socket) — NOT proof that no
  // head exists. Publishing the local store here could erase an unseen newer head
  // during a transient outage. Fix: `retain` — keep the durable outbox and retry.
  // Mutation: reverting the merge-lane catch to `publish` fires publishEvent over
  // the unseen head.
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
        "must not publish when the pre-publish fetch failed",
      );
      assert.ok(
        getPending(manager) !== null,
        "a failed fetch must retain the pending edit",
      );
      assert.ok(
        readOutbox("pk-fetchfail", RELAY),
        "durable outbox must survive a failed fetch",
      );
      assert.ok(fw._hasTimer(), "a retry must be scheduled");
    } finally {
      tauri.restore();
      restore();
      mock.reset();
    }
  });

  // ─── Unreadable head: retain, never max-merge over it (Carl P1) ──────────────

  // A pre-publish head event exists but cannot be decrypted (transient keychain
  // fault, future NIP-44 scheme, malformed/unsupported payload). A max-merge is
  // only safe once both operands were actually read, so publishing the local
  // store over an uninspectable head would drop its unread entries. Fix: `retain`
  // — keep the durable outbox and retry, never publish. Mutation: reverting the
  // `!remote` branch to `publish` fires publishEvent and clobbers the unread head.
  test(`${label}: unreadable head (decrypt failure) retains the pending edit and retries, never publishing`, async () => {
    // A head event exists but its ciphertext is not registered in the echo map,
    // so decrypt rejects → decryptAndParse returns null → retain.
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
    const publishCalls = [];
    mock.method(relayClient, "publishEvent", (...args) => {
      publishCalls.push(args);
      return Promise.resolve();
    });
    const fw = makeFakeWindow();
    const restore = installFakeWindow(fw);
    const tauri = installEchoTauri("pk-undec");
    try {
      const manager = new Manager("pk-undec", RELAY);
      publish(manager, makeStore({ a: makeEntry(true, 100, 1) }));
      fw._fireTimer();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(
        publishCalls.length,
        0,
        "must not publish over a head we could not read",
      );
      assert.ok(
        getPending(manager) !== null,
        "unreadable head must retain the pending edit",
      );
      assert.ok(
        readOutbox("pk-undec", RELAY),
        "durable outbox must survive an unreadable head",
      );
      assert.ok(fw._hasTimer(), "a retry must be scheduled");
    } finally {
      tauri.restore();
      restore();
      mock.reset();
    }
  });

  // A readable head whose decrypted payload carries an unsupported schema version
  // (the lane parser rejects it → decryptAndParse returns null). Distinct from a
  // decrypt fault: the ciphertext decrypts fine, but we still cannot trust the
  // contents, so retain rather than max-merge over it.
  test(`${label}: unsupported head payload schema retains the pending edit, never publishing`, async () => {
    const fw = makeFakeWindow();
    const restore = installFakeWindow(fw);
    const tauri = installEchoTauri("pk-badver");
    // mintHead stringifies the given object as the head plaintext; a future schema
    // version decrypts cleanly but the lane parser returns null.
    const head = tauri.mintHead({ version: 2, channels: {} }, 500);
    mock.method(relayClient, "fetchEvents", () => Promise.resolve([head]));
    const publishCalls = [];
    mock.method(relayClient, "publishEvent", (...args) => {
      publishCalls.push(args);
      return Promise.resolve();
    });
    try {
      const manager = new Manager("pk-badver", RELAY);
      publish(manager, makeStore({ a: makeEntry(true, 100, 1) }));
      fw._fireTimer();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(
        publishCalls.length,
        0,
        "must not publish over a head whose schema we do not support",
      );
      assert.ok(
        getPending(manager) !== null,
        "unsupported schema must retain the pending edit",
      );
      assert.ok(fw._hasTimer(), "a retry must be scheduled");
    } finally {
      tauri.restore();
      restore();
      mock.reset();
    }
  });

  // ─── Timestamp clamp (Carl P2): a far-future remote head must not push our
  //     published createdAt past the relay's ±15min future-drift window.
  // Mutation test: removing the clamp lets createdAt = lastRemote+1 (~now+3600),
  // which exceeds now + MAX_PUBLISH_FUTURE_SECS.
  test(`${label}: timestamp clamp: published createdAt stays inside the relay future window`, async () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const farFutureHead = nowSecs + 3_600; // 1h ahead — beyond the ±15min window
    const fw = makeFakeWindow();
    const restore = installFakeWindow(fw);
    const tauri = installEchoTauri("pk-clamp");
    // A readable far-future head: primes lastRemoteCreatedAt to farFutureHead on
    // the priming fetch and is max-merged on the pre-publish fetch. It must be
    // decryptable — an unreadable head now retains rather than publishes, so the
    // clamp is only exercised via a head we actually read.
    const head = tauri.mintHead(makeStore({}), farFutureHead);
    mock.method(relayClient, "fetchEvents", () => Promise.resolve([head]));
    let signedCreatedAt = null;
    mock.method(relayClient, "publishEvent", (evt) => {
      signedCreatedAt = evt.created_at;
      return Promise.resolve();
    });
    try {
      const manager = new Manager("pk-clamp", RELAY);
      await fetchRemote(manager); // prime lastRemoteCreatedAt
      publish(manager, makeStore({ ch1: makeEntry(true, 100, 1) }));
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
}
