import assert from "node:assert/strict";
import test from "node:test";

import { retransmitPermissionDecision } from "./retransmitPermissionDecision.ts";

const NONCE = "nonce-1";

function frame(overrides = {}) {
  return {
    type: "permission_decision",
    status: "sent",
    requestNonce: NONCE,
    ...overrides,
  };
}

/**
 * Controllable harness mirroring the real wiring: a single-listener pub/sub
 * whose unsubscribe genuinely detaches, a manual retransmit tick, a manual
 * deadline flag, and a send counter.
 */
function harness({ nonce = NONCE } = {}) {
  let listener = null;
  let tickCb = null;
  let unsubscribeCalls = 0;
  let cancelRetransmitCalls = 0;
  let sendCalls = 0;
  let expired = false;

  const outcome = retransmitPermissionDecision({
    requestNonce: nonce,
    send: () => {
      sendCalls += 1;
      return Promise.resolve();
    },
    subscribe: (fn) => {
      listener = fn;
      return () => {
        unsubscribeCalls += 1;
        listener = null;
      };
    },
    scheduleRetransmit: (cb) => {
      tickCb = cb;
      return () => {
        cancelRetransmitCalls += 1;
        // Mirror clearInterval: a cancelled scheduler fires no more ticks.
        tickCb = null;
      };
    },
    deadlineReached: () => expired,
  });

  return {
    outcome,
    push: (f) => listener?.(f),
    tick: () => tickCb?.(),
    expire: () => {
      expired = true;
    },
    get sendCalls() {
      return sendCalls;
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
    get cancelRetransmitCalls() {
      return cancelRetransmitCalls;
    },
  };
}

const drainMicrotasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

test("retransmitPermissionDecision sends immediately and resolves acked on a matching control_result", async () => {
  const h = harness();
  await drainMicrotasks();
  assert.equal(h.sendCalls, 1, "first send fires immediately");

  h.push(frame());
  assert.equal(await h.outcome, "acked");
  assert.equal(h.unsubscribeCalls, 1, "settles unsubscribe the listener");
  assert.equal(
    h.cancelRetransmitCalls,
    1,
    "settles cancel the retransmit loop",
  );
});

test("retransmitPermissionDecision resends on each tick until acked", async () => {
  const h = harness();
  await drainMicrotasks();
  assert.equal(h.sendCalls, 1);

  h.tick();
  h.tick();
  await drainMicrotasks();
  assert.equal(h.sendCalls, 3, "two ticks resend twice more");

  h.push(frame());
  assert.equal(await h.outcome, "acked");
  // A tick after settle must not resend.
  h.tick();
  await drainMicrotasks();
  assert.equal(h.sendCalls, 3, "no resend after the loop has settled");
});

test("retransmitPermissionDecision stops at the deadline and resolves expired without resending", async () => {
  const h = harness();
  await drainMicrotasks();
  assert.equal(h.sendCalls, 1);

  h.expire();
  h.tick();
  assert.equal(await h.outcome, "expired");
  assert.equal(h.sendCalls, 1, "a tick past the deadline must not resend");
  assert.equal(h.unsubscribeCalls, 1);
  assert.equal(h.cancelRetransmitCalls, 1);
});

test("retransmitPermissionDecision resolves acked on an already_decided status", async () => {
  // A late retransmit the harness recognizes as an already-applied duplicate
  // acks `already_decided`; it settles the loop exactly like `sent`.
  const h = harness();
  h.push(frame({ status: "already_decided" }));
  assert.equal(await h.outcome, "acked");
});

test("retransmitPermissionDecision ignores a control_result for a different nonce", async () => {
  const h = harness();
  let settled = false;
  void h.outcome.then(() => {
    settled = true;
  });

  // Foreign nonce and a non-permission frame must both be inert.
  h.push(frame({ requestNonce: "other-nonce" }));
  h.push({ type: "switch_model", status: "switched", requestNonce: NONCE });
  await drainMicrotasks();
  assert.equal(settled, false, "no foreign or off-type frame settles the loop");

  h.push(frame());
  assert.equal(await h.outcome, "acked");
});
