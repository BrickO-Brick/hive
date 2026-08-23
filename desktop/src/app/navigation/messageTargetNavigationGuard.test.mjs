import assert from "node:assert/strict";
import test from "node:test";

const { allowMessageTargetNavigation, registerMessageTargetNavigationGuard } =
  await import("./messageTargetNavigationGuard.ts");

test("all message-target navigation consults the registered boundary guard", () => {
  let calls = 0;
  const unregister = registerMessageTargetNavigationGuard(() => {
    calls += 1;
    return false;
  });

  assert.equal(allowMessageTargetNavigation(), false);
  assert.equal(calls, 1);
  unregister();
  assert.equal(allowMessageTargetNavigation(), true);
});

test("stale cleanup cannot unregister a newer guard", () => {
  const unregisterFirst = registerMessageTargetNavigationGuard(() => false);
  const unregisterSecond = registerMessageTargetNavigationGuard(() => true);

  unregisterFirst();
  assert.equal(allowMessageTargetNavigation(), true);
  unregisterSecond();
  assert.equal(allowMessageTargetNavigation(), true);
});
