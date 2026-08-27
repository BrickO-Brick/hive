import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { relayClient } from "@/shared/api/relayClient";
import { readChannelStarsOutbox } from "./channelStarsStorage.ts";
import { ChannelStarSyncManager } from "./channelStarsSync.ts";
import {
  installFakeWindow,
  installEchoTauri,
  makeFakeWindow,
} from "./sidebarSyncTestHelpers.mjs";

const RELAY = "wss://r.test";
const RELAY_KEY = encodeURIComponent(RELAY);

function makeStore(channels = {}) {
  return { version: 1, channels };
}
const E = (starred, updatedAt, rev) => ({ starred, updatedAt, rev });

// Multi-slot timer fake keyed by delay, for overlapping-publish tests. Mirrors
// the sections suite convention (channelSectionsSync.test.mjs:407-432).
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

// ─── observe() / high-water ingestion ─────────────────────────────────────────

test("observe: high-water is per-channel max of rev and updatedAt, monotonic", () => {
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const m = new ChannelStarSyncManager("pk", RELAY);
    m.observe(makeStore({ a: E(true, 100, 3), b: E(false, 50, 1) }));
    assert.equal(m.maxRevSeen("a"), 3);
    assert.equal(m.maxUpdatedAtSeen("a"), 100);
    // A later observation raises each dimension independently; a lower one
    // never regresses either.
    m.observe(makeStore({ a: E(true, 90, 5) }));
    assert.equal(m.maxRevSeen("a"), 5, "rev raised");
    assert.equal(m.maxUpdatedAtSeen("a"), 100, "updatedAt not regressed");
    m.observe(makeStore({ a: E(true, 200, 2) }));
    assert.equal(m.maxUpdatedAtSeen("a"), 200, "updatedAt raised");
    assert.equal(m.maxRevSeen("a"), 5, "rev not regressed");
    // Unseen channel reports zero on both dimensions.
    assert.equal(m.maxRevSeen("never"), 0);
    assert.equal(m.maxUpdatedAtSeen("never"), 0);
  } finally {
    restore();
  }
});

// ─── destroy() must cancel pending publish, not flush ─────────────────────────

test("destroy: cancels pending publish without flushing to the relay", () => {
  const publishCalls = [];
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "publishEvent", (...args) => {
    publishCalls.push(args);
    return Promise.resolve();
  });
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelStarSyncManager("pk-test", RELAY);
    manager.publishStars(makeStore({ ch1: E(true, 100, 1) }));
    manager.destroy();
    assert.equal(publishCalls.length, 0, "no publish after destroy");
    assert.equal(manager.getPendingStarStore(), null);
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
    const manager = new ChannelStarSyncManager("pk-race", RELAY);
    manager.publishStars(makeStore({ ch1: E(true, 100, 1) }));
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

test("destroy: is safe to call with no pending publish", () => {
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelStarSyncManager("pk-no-pending", RELAY);
    assert.doesNotThrow(() => manager.destroy());
  } finally {
    restore();
  }
});

// ─── Generation CAS: A-in-flight → B-click → A-completes (both variants) ──────

// Finding 2 (A succeeds): an older in-flight publish that completes after a
// newer edit is queued must NOT clear the newer edit's pending store/outbox,
// and B must reach the relay via the completion re-drive. Mutation: dropping the
// generation CAS in discardPending lets A's success null out B's pending+outbox.
test("A-in-flight → B-click → A-succeeds: B stays pending and B publishes", async () => {
  let releaseFirst = null;
  let publishCount = 0;
  let storedHead = [];
  mock.method(relayClient, "fetchEvents", () => Promise.resolve(storedHead));
  mock.method(relayClient, "publishEvent", (event) => {
    publishCount++;
    if (publishCount === 1) {
      // A reaches the relay; hold its ACK open until the test releases it, then
      // record it as the retained head.
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
  const t = makeMultiTimerWindow();
  const restore = installFakeWindow(t.win);
  const tauri = installEchoTauri("pk-ab");
  try {
    const manager = new ChannelStarSyncManager("pk-ab", RELAY);
    const storeA = makeStore({ a: E(true, 100, 1) });
    const storeB = makeStore({ b: E(true, 101, 1) });

    manager.publishStars(storeA);
    await t.fireDelay(2000); // doPublish(A) awaits publishEvent
    while (releaseFirst === null) await Promise.resolve();

    // B arrives while A is in flight.
    manager.publishStars(storeB);
    assert.deepEqual(
      Object.keys(manager.getPendingStarStore().channels),
      ["b"],
      "B is now pending",
    );
    assert.ok(readChannelStarsOutbox("pk-ab", RELAY), "outbox holds B");

    // A completes — must NOT clear B.
    releaseFirst();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    assert.deepEqual(
      Object.keys(manager.getPendingStarStore()?.channels ?? {}),
      ["b"],
      "older A completion leaves B pending",
    );
    assert.ok(
      readChannelStarsOutbox("pk-ab", RELAY),
      "older A completion leaves B outbox",
    );

    // B's own debounce fires and B reaches the relay with no kick; the
    // post-publish retained-head fetch reads B's own write back and confirms
    // subsumption, so B's outbox clears.
    const capturedBefore = tauri.capturedPlaintext();
    await t.fireDelay(2000);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    const captured = tauri.capturedPlaintext();
    assert.ok(
      captured && captured !== capturedBefore && captured.includes('"b"'),
      "B is published to the relay",
    );
    assert.equal(
      manager.getPendingStarStore(),
      null,
      "B cleared after confirmed publish",
    );
    assert.equal(
      readChannelStarsOutbox("pk-ab", RELAY),
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

// Finding 2 (A fails): A's publish rejects after B is queued. B must remain
// pending and be published by the serialized re-drive / retry — no manual kick.
test("A-in-flight → B-click → A-fails: B remains pending and B publishes", async () => {
  let rejectFirst = null;
  let publishCount = 0;
  let storedHead = [];
  mock.method(relayClient, "fetchEvents", () => Promise.resolve(storedHead));
  mock.method(relayClient, "publishEvent", (event) => {
    publishCount++;
    if (publishCount === 1) {
      return new Promise((_res, rej) => {
        rejectFirst = () => rej(new Error("socket error"));
      });
    }
    storedHead = [event];
    return Promise.resolve();
  });
  const t = makeMultiTimerWindow();
  const restore = installFakeWindow(t.win);
  const tauri = installEchoTauri("pk-abfail");
  try {
    const manager = new ChannelStarSyncManager("pk-abfail", RELAY);
    manager.publishStars(makeStore({ a: E(true, 100, 1) }));
    await t.fireDelay(2000);
    while (rejectFirst === null) await Promise.resolve();

    manager.publishStars(makeStore({ b: E(true, 101, 1) }));
    rejectFirst(); // A fails
    for (let i = 0; i < 50; i++) await Promise.resolve();

    assert.deepEqual(
      Object.keys(manager.getPendingStarStore()?.channels ?? {}),
      ["b"],
      "B still pending after A's failure",
    );
    assert.ok(
      readChannelStarsOutbox("pk-abfail", RELAY),
      "B outbox intact after A's failure",
    );

    // B's debounce fires and B publishes successfully; the retained-head fetch
    // confirms B's own write and clears it.
    await t.fireDelay(2000);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    const captured = tauri.capturedPlaintext();
    assert.ok(captured?.includes('"b"'), "B published");
    assert.equal(manager.getPendingStarStore(), null, "B cleared");
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// ─── Bounded-backoff retry: failed publish on a healthy socket, no later edit ─

// Finding 2: a transient publish failure with the socket open and NO further
// click must self-heal via the bounded-backoff retry — the pending edit is kept
// and a retry timer is scheduled. Mutation: dropping scheduleRetry leaves the
// edit stranded (Will's "make another change to kick it" symptom).
test("failed publish schedules a bounded-backoff retry and keeps the pending edit", async () => {
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
    const manager = new ChannelStarSyncManager("pk-retry", RELAY);
    manager.publishStars(makeStore({ a: E(true, 100, 1) }));
    await t.fireDelay(2000); // debounce → doPublish → publishEvent rejects
    assert.ok(
      manager.getPendingStarStore() !== null,
      "pending edit retained after failure",
    );
    assert.ok(t.hasDelay(2000), "a retry timer at RETRY_BASE_MS is scheduled");

    // The retry fires and the second publish succeeds; the retained-head fetch
    // confirms the write → pending cleared.
    await t.fireDelay(2000);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    assert.equal(publishCount, 2, "retry re-published");
    assert.equal(
      manager.getPendingStarStore(),
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

// ─── Retention confirmation (Carl P1): OK is not proof of retention ───────────

// The relay OKs a superseded NIP-33 write as a no-op, so two windows racing
// distinct blobs from the same head can both get OK while only one is retained.
// The loser must NOT clear its durable outbox on OK alone: it fetches the
// authoritative retained head and clears only when that head subsumes its
// write. A retained head carrying a peer's distinct blob does not subsume the
// loser's click, so the outbox is kept and a retry is scheduled.
// Mutation: clearing on OK alone (dropping confirmRetainedHeadSubsumes) would
// null the pending edit here and lose the click.
test("publish OK but a peer blob is retained: loser keeps its outbox and retries", async () => {
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
      // head is the peer's blob for a different channel, minted through the same
      // echo seam so it decrypts.
      storedHead = [tauri.mintHead(makeStore({ z: E(true, 200, 5) }), 100)];
      return Promise.resolve();
    }
    // The retry (which max-merges the peer head in) is retained.
    storedHead = [event];
    return Promise.resolve();
  });
  const t = makeMultiTimerWindow();
  const restore = installFakeWindow(t.win);
  try {
    const manager = new ChannelStarSyncManager("pk-loser", RELAY);
    manager.publishStars(makeStore({ a: E(true, 100, 1) }));
    await t.fireDelay(2000); // publish OK, but peer blob is what's retained
    for (let i = 0; i < 50; i++) await Promise.resolve();

    assert.ok(
      manager.getPendingStarStore() !== null,
      "unconfirmed publish keeps the pending edit",
    );
    assert.ok(
      readChannelStarsOutbox("pk-loser", RELAY),
      "loser keeps its durable outbox — OK is not proof of retention",
    );
    assert.ok(t.hasDelay(2000), "a retry is scheduled");

    // The retry re-publishes the max-merge of our click and the peer head; this
    // time it is retained (subsumes our `a`) and the outbox clears.
    await t.fireDelay(2000);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    assert.equal(publishCount, 2, "loser retried");
    assert.equal(
      manager.getPendingStarStore(),
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

// ─── Boot seed-publish guard (the revert-fix regression suite) ─────────────────

test("revert-fix: fetch failed (error) does not trigger seed-publish via bootstrap", async () => {
  mock.method(relayClient, "fetchEvents", () =>
    Promise.reject(new Error("relay timeout")),
  );
  mock.method(relayClient, "publishEvent", () => Promise.resolve());
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelStarSyncManager("pk-fail", RELAY);
    const result = await manager.bootstrap(makeStore({ ch1: E(true, 1, 0) }));
    assert.equal(result.action, "hold");
    assert.equal(manager.getPendingStarStore(), null);
  } finally {
    restore();
    mock.reset();
  }
});

test("revert-fix: absent fetch with prior watermark blocks seed-publish via bootstrap", async () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "publishEvent", () => Promise.resolve());
  const fw = makeFakeWindow();
  fw.localStorage.setItem(
    `buzz-sync-watermark.v1:channel-stars:pk-stale:${RELAY_KEY}`,
    "1700000000",
  );
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelStarSyncManager("pk-stale", RELAY);
    const result = await manager.bootstrap(makeStore({ ch1: E(true, 1, 0) }));
    assert.equal(result.action, "hold");
    assert.equal(manager.getPendingStarStore(), null);
  } finally {
    restore();
    mock.reset();
  }
});

test("revert-fix: absent fetch with zero watermark seeds via bootstrap (first-sync preserved)", async () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "publishEvent", () => Promise.resolve());
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelStarSyncManager("pk-fresh", RELAY);
    const result = await manager.bootstrap(makeStore({ ch1: E(true, 1, 0) }));
    assert.equal(result.action, "hold");
    assert.ok(manager.getPendingStarStore() !== null);
  } finally {
    restore();
    mock.reset();
  }
});

test("revert-fix: relay-A watermark does not suppress first-sync seed on relay-B", async () => {
  const relayA = "wss://a.relay.test";
  const relayB = "wss://b.relay.test";
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "publishEvent", () => Promise.resolve());
  const fw = makeFakeWindow();
  fw.localStorage.setItem(
    `buzz-sync-watermark.v1:channel-stars:pk-iso:${encodeURIComponent(relayA)}`,
    "1700000100",
  );
  const restore = installFakeWindow(fw);
  try {
    const managerB = new ChannelStarSyncManager("pk-iso", relayB);
    const result = await managerB.bootstrap(makeStore({ ch1: E(true, 1, 0) }));
    assert.equal(result.action, "hold");
    assert.ok(
      managerB.getPendingStarStore() !== null,
      "first-sync seed on relay B must not be blocked by relay A watermark",
    );
  } finally {
    restore();
    mock.reset();
  }
});

// ─── Failed pre-publish fetch: retain, never publish (Carl P1) ────────────────

// The pre-publish fetch THROWS (timeout / auth / socket) — NOT proof that no
// head exists. Publishing the local store here could erase an unseen newer head
// during a transient outage. Fix: `retain` — keep the durable outbox and retry.
// Mutation: reverting the merge-lane catch to `publish` fires publishEvent over
// the unseen head.
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
  const tauri = installEchoTauri("pk-fetchfail");
  try {
    const manager = new ChannelStarSyncManager("pk-fetchfail", RELAY);
    manager.publishStars(makeStore({ a: E(true, 100, 1) }));
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      publishCalls.length,
      0,
      "must not publish when the pre-publish fetch failed",
    );
    assert.ok(
      manager.getPendingStarStore() !== null,
      "a failed fetch must retain the pending edit",
    );
    assert.ok(
      readChannelStarsOutbox("pk-fetchfail", RELAY),
      "durable outbox must survive a failed fetch",
    );
    assert.ok(fw._hasTimer(), "a retry must be scheduled");
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// ─── Unreadable head: retain, never max-merge over it (Carl P1) ───────────────

// A pre-publish head event exists but cannot be decrypted (transient keychain
// fault, future NIP-44 scheme, malformed/unsupported payload). A max-merge is
// only safe once both operands were actually read, so publishing the local
// store over an uninspectable head would drop its unread entries. Fix: `retain`
// — keep the durable outbox and retry, never publish. Mutation: reverting the
// `!remote` branch to `publish` fires publishEvent and clobbers the unread head.
test("unreadable head (decrypt failure) retains the pending edit and retries, never publishing", async () => {
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
    const manager = new ChannelStarSyncManager("pk-undec", RELAY);
    manager.publishStars(makeStore({ a: E(true, 100, 1) }));
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      publishCalls.length,
      0,
      "must not publish over a head we could not read",
    );
    assert.ok(
      manager.getPendingStarStore() !== null,
      "unreadable head must retain the pending edit",
    );
    assert.ok(
      readChannelStarsOutbox("pk-undec", RELAY),
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
// (parseStarPayload rejects it → decryptAndParse returns null). Distinct from a
// decrypt fault: the ciphertext decrypts fine, but we still cannot trust the
// contents, so retain rather than max-merge over it.
test("unsupported head payload schema retains the pending edit, never publishing", async () => {
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  const tauri = installEchoTauri("pk-badver");
  // mintHead stringifies the given object as the head plaintext; a future schema
  // version decrypts cleanly but parseStarPayload returns null.
  const head = tauri.mintHead({ version: 2, channels: {} }, 500);
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([head]));
  const publishCalls = [];
  mock.method(relayClient, "publishEvent", (...args) => {
    publishCalls.push(args);
    return Promise.resolve();
  });
  try {
    const manager = new ChannelStarSyncManager("pk-badver", RELAY);
    manager.publishStars(makeStore({ a: E(true, 100, 1) }));
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      publishCalls.length,
      0,
      "must not publish over a head whose schema we do not support",
    );
    assert.ok(
      manager.getPendingStarStore() !== null,
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
test("timestamp clamp: published createdAt stays inside the relay future window", async () => {
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
    const manager = new ChannelStarSyncManager("pk-clamp", RELAY);
    await manager.fetchRemoteStars(); // prime lastRemoteCreatedAt
    manager.publishStars(makeStore({ ch1: E(true, 100, 1) }));
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
