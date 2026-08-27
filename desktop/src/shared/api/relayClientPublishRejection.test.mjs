// A relay rejection addressed to one event must settle that event's pending
// publish *and* arm the rate-limit gate.
//
// History: the relay rejected an over-quota EVENT with a bare
// `["NOTICE", "rate-limited: ..."]`. A NOTICE carries no event id, and
// `pendingEvents` is keyed by event id, so nothing settled — the publish sat
// until PUBLISH_TIMEOUT_MS (25s) and surfaced as a message stuck on
// "Sending…". Startup quota exhaustion made that routine in the first seconds
// after launch. The relay now rejects on the OK channel instead, so the gate
// arming that used to live in the NOTICE branch has to happen here too.
import assert from "node:assert/strict";
import test from "node:test";

const fakeNow = 0;
const pendingTimers = new Map();
let nextTimerId = 1;

globalThis.window = {
  setTimeout: (fn, ms) => {
    const id = nextTimerId++;
    pendingTimers.set(id, { fn, fireAt: fakeNow + ms });
    return id;
  },
  clearTimeout: (id) => pendingTimers.delete(id),
};
Date.now = () => fakeNow;

const { RelayClient } = await import("./relayClientSession.ts");
const { isRateLimited, resetRateLimitGate } = await import(
  "./relayRateLimitGate.ts"
);

/**
 * Registers a pending publish the way `publishEvent` does, without needing a
 * socket: the OK dispatch under test only reads `pendingEvents`.
 */
function armPendingPublish(client, eventId) {
  const event = { id: eventId };
  const settled = new Promise((resolve, reject) => {
    client.pendingEvents.set(eventId, {
      event,
      resolve,
      reject,
      timeout: window.setTimeout(() => {}, 25_000),
    });
  });
  // Keep the rejection from surfacing as an unhandled rejection.
  return settled.then(
    (value) => ({ status: "resolved", value }),
    (error) => ({ status: "rejected", error }),
  );
}

/** Feeds a raw relay frame through the real inbound dispatch path. */
function deliver(client, frame) {
  return client.handleWsMessage(
    { type: "Text", data: JSON.stringify(frame) },
    client.connectionGeneration,
  );
}

test("a rate-limited OK rejection settles the pending publish", async () => {
  resetRateLimitGate();
  pendingTimers.clear();
  const client = new RelayClient();
  const eventId = "a".repeat(64);
  const settled = armPendingPublish(client, eventId);

  await deliver(client, [
    "OK",
    eventId,
    false,
    "rate-limited: quota exceeded; retry in 4s",
  ]);

  const outcome = await settled;
  assert.equal(
    outcome.status,
    "rejected",
    "an over-quota publish must fail fast, not hang until the 25s publish timeout",
  );
  assert.match(outcome.error.message, /rate-limited/);
  assert.equal(
    client.pendingEvents.has(eventId),
    false,
    "the pending entry must be cleared",
  );
});

test("a rate-limited OK rejection arms the rate-limit gate", async () => {
  resetRateLimitGate();
  pendingTimers.clear();
  const client = new RelayClient();
  const eventId = "b".repeat(64);
  const settled = armPendingPublish(client, eventId);

  assert.equal(isRateLimited(), false, "gate starts closed");

  await deliver(client, [
    "OK",
    eventId,
    false,
    "rate-limited: quota exceeded; retry in 4s",
  ]);
  await settled;

  assert.equal(
    isRateLimited(),
    true,
    "back-pressure now arrives on the OK channel — without arming here the " +
      "client fails the send and immediately retries into the same quota",
  );
});

test("an ordinary OK rejection does not arm the gate", async () => {
  resetRateLimitGate();
  pendingTimers.clear();
  const client = new RelayClient();
  const eventId = "c".repeat(64);
  const settled = armPendingPublish(client, eventId);

  await deliver(client, ["OK", eventId, false, "invalid: bad signature"]);
  const outcome = await settled;

  assert.equal(outcome.status, "rejected");
  assert.equal(
    isRateLimited(),
    false,
    "only `rate-limited:` rejections signal back-pressure",
  );
});

test("an accepted OK still resolves the pending publish", async () => {
  resetRateLimitGate();
  pendingTimers.clear();
  const client = new RelayClient();
  const eventId = "d".repeat(64);
  const settled = armPendingPublish(client, eventId);

  await deliver(client, ["OK", eventId, true, ""]);
  const outcome = await settled;

  assert.equal(outcome.status, "resolved");
  assert.equal(outcome.value.id, eventId);
});
