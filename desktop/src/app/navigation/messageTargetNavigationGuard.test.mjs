import assert from "node:assert/strict";
import test from "node:test";

const { allowMessageTargetNavigation, registerMessageTargetNavigationGuard } =
  await import("./messageTargetNavigationGuard.ts");

const target = {
  kind: "channel-message",
  channelId: "general",
  messageId: "message-a",
  threadRootId: "thread-a",
};

test("all message-target navigation consults the registered boundary guard", () => {
  let received;
  const unregister = registerMessageTargetNavigationGuard((nextTarget) => {
    received = nextTarget;
    return false;
  });

  assert.equal(allowMessageTargetNavigation(target), false);
  assert.deepEqual(received, target);
  unregister();
  assert.equal(allowMessageTargetNavigation(target), true);
});

test("unregistering the newer guard restores the prior live guard", () => {
  const unregisterFirst = registerMessageTargetNavigationGuard(() => false);
  const unregisterSecond = registerMessageTargetNavigationGuard(() => true);

  assert.equal(allowMessageTargetNavigation(target), true);
  unregisterSecond();
  assert.equal(allowMessageTargetNavigation(target), false);
  unregisterFirst();
  assert.equal(allowMessageTargetNavigation(target), true);
});

test("stale cleanup cannot unregister a newer guard", () => {
  const unregisterFirst = registerMessageTargetNavigationGuard(() => false);
  const unregisterSecond = registerMessageTargetNavigationGuard(() => true);

  unregisterFirst();
  assert.equal(allowMessageTargetNavigation(target), true);
  unregisterSecond();
  assert.equal(allowMessageTargetNavigation(target), true);
});

test("duplicate callback registrations clean up by registration identity", () => {
  const sharedGuard = () => false;
  const unregisterFirst = registerMessageTargetNavigationGuard(sharedGuard);
  const unregisterSecond = registerMessageTargetNavigationGuard(sharedGuard);

  unregisterFirst();
  assert.equal(allowMessageTargetNavigation(target), false);
  unregisterSecond();
  assert.equal(allowMessageTargetNavigation(target), true);
});
