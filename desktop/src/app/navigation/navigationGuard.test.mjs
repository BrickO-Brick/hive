import assert from "node:assert/strict";
import test from "node:test";

const { allowNavigation, registerNavigationGuard } = await import(
  "./navigationGuard.ts"
);

const target = {
  kind: "channel-message",
  channelId: "general",
  messageId: "message-a",
  threadRootId: "thread-a",
};

test("all navigation consults the registered boundary guard", () => {
  let received;
  const unregister = registerNavigationGuard((nextTarget) => {
    received = nextTarget;
    return false;
  });

  assert.equal(allowNavigation(target), false);
  assert.deepEqual(received, target);
  unregister();
  assert.equal(allowNavigation(target), true);
});

test("unregistering the newer guard restores the prior live guard", () => {
  const unregisterFirst = registerNavigationGuard(() => false);
  const unregisterSecond = registerNavigationGuard(() => true);

  assert.equal(allowNavigation(target), true);
  unregisterSecond();
  assert.equal(allowNavigation(target), false);
  unregisterFirst();
  assert.equal(allowNavigation(target), true);
});

test("stale cleanup cannot unregister a newer guard", () => {
  const unregisterFirst = registerNavigationGuard(() => false);
  const unregisterSecond = registerNavigationGuard(() => true);

  unregisterFirst();
  assert.equal(allowNavigation(target), true);
  unregisterSecond();
  assert.equal(allowNavigation(target), true);
});

test("duplicate callback registrations clean up by registration identity", () => {
  const sharedGuard = () => false;
  const unregisterFirst = registerNavigationGuard(sharedGuard);
  const unregisterSecond = registerNavigationGuard(sharedGuard);

  unregisterFirst();
  assert.equal(allowNavigation(target), false);
  unregisterSecond();
  assert.equal(allowNavigation(target), true);
});
