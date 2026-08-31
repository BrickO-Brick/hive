/**
 * Mounted hook regression: Goose `off` survives `useEffortAutoClear` clearing effects.
 *
 * P2 blocker (PR #4625 pass 2): the global/onboarding surface mounts
 * AgentConfigFields with a Goose runtime. Previously, optionSource was
 * "legacyProviderModelCatalog" and AgentConfigFields passed buzz-agent vocab to
 * useEffortAutoClear — "off" is absent from that vocab, so the hook deleted the
 * valid Goose value on mount (and on re-renders from unrelated Saves).
 *
 * After the fix: optionSource is "harnessNative" and AgentConfigFields passes
 * `runtime.effortCanonicalValues` (now serialized from the catalog) to
 * useEffortAutoClear — that list includes "off", so the hook must NOT fire.
 *
 * These tests mount the hook directly to pin the clearing-effect invariant:
 *   - Deleting "off" from the canonical list passed as `effortValid` makes the
 *     first test red — the hook fires and clears "off".
 *   - Passing buzz-agent vocab (no "off") instead of Goose canonical values
 *     makes the first test red.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

let act;
let renderHook;
let cleanup;
let useEffortAutoClear;

before(async () => {
  // Set up JSDOM globals before importing React components.
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (key === "window" || key === "document" || key === "globalThis")
      continue;
    const value = dom.window[key];
    if (
      typeof value === "function" &&
      /^(HTML|SVG)|Element$|Event$|EventTarget$|^Node|^Document|Observer$/.test(
        key,
      )
    ) {
      globalThis[key] = value;
    }
  }
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
    writable: true,
  });

  ({ act, renderHook, cleanup } = await import("@testing-library/react"));
  ({ useEffortAutoClear } = await import("./buzzAgentModelTuningFields.tsx"));
});

afterEach(() => {
  cleanup?.();
});

// Goose canonical values as serialized from the Rust catalog
// (`GOOSE_EFFORT_NORMALIZATION.canonical`, PR #4625 fix 3).
// The renderer now reads these from `runtime.effortCanonicalValues` — "off"
// is always present so `useEffortAutoClear` can never incorrectly delete it.
const GOOSE_CANONICAL = ["off", "low", "medium", "high", "max"];

test("useEffortAutoClear preserves Goose off when effortValid contains off (mount)", async () => {
  // Regression: before the fix, AgentConfigFields passed buzz-agent vocab
  // (no "off") to useEffortAutoClear. The hook fired on mount and deleted the
  // valid Goose "off" value. After the fix, Goose's own catalog vocab is passed
  // and "off" is always valid — hook must be a no-op.
  let clearCallCount = 0;
  const { rerender } = renderHook(() =>
    useEffortAutoClear({
      currentEffort: "off",
      effortValid: GOOSE_CANONICAL,
      onClear: () => {
        clearCallCount++;
      },
    }),
  );
  await act(async () => {});
  assert.equal(
    clearCallCount,
    0,
    'useEffortAutoClear must not clear "off" when it is in Goose effortCanonicalValues (mount)',
  );
  // Simulate an unrelated Save (re-render with same props) — "off" must still survive.
  rerender();
  await act(async () => {});
  assert.equal(
    clearCallCount,
    0,
    'useEffortAutoClear must not clear "off" on re-render (unrelated Save simulation)',
  );
});

test("useEffortAutoClear clears a value genuinely absent from the canonical list", async () => {
  // Confirm the hook DOES fire when the value is not in the runtime's vocab:
  // "minimal" is valid buzz-agent but invalid Goose — this must be cleared.
  let clearCallCount = 0;
  const { rerender } = renderHook(() =>
    useEffortAutoClear({
      currentEffort: "minimal",
      effortValid: GOOSE_CANONICAL,
      onClear: () => {
        clearCallCount++;
      },
    }),
  );
  await act(async () => {});
  assert.equal(
    clearCallCount,
    1,
    "useEffortAutoClear must fire for a value absent from the canonical list",
  );
  // No second clear on re-render — one fire is sufficient.
  rerender();
  await act(async () => {});
  assert.equal(
    clearCallCount,
    1,
    "useEffortAutoClear must not double-fire on re-render",
  );
});
