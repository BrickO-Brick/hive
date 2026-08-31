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
let render;
let renderHook;
let screen;
let cleanup;
let useEffortAutoClear;
let EffortSelectField;
let fromRawAcpRuntimeCatalogEntry;
let createElement;

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

  ({ act, render, renderHook, screen, cleanup } = await import(
    "@testing-library/react"
  ));
  ({ useEffortAutoClear, EffortSelectField } = await import(
    "./buzzAgentModelTuningFields.tsx"
  ));
  ({ fromRawAcpRuntimeCatalogEntry } = await import(
    "../../../shared/api/tauri.ts"
  ));
  ({ createElement } = await import("react"));
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

// ── EffortSelectField renderer regression: Goose `off` as option + selected ──
//
// P3 blocker: EffortSelectField iterated only BUZZ_AGENT_THINKING_EFFORT_VALUES
// (no "off"), so a saved currentEffort="off" fell back to the placeholder.
// Fixed: option set is the union of effortValid (runtime canonical) and the
// master list. These tests pin the wiring from catalog → effortCanonicalValues
// → option presence + selection state.
//
// Mutation proofs:
//   - Reverting EffortSelectField to iterate only BUZZ_AGENT_THINKING_EFFORT_VALUES
//     removes "off" from the rendered options → optionValues won't contain "off".
//   - Removing "off" from effortCanonicalValues in fromRawAcpRuntimeCatalogEntry
//     removes it from effortValid → same failure.

// The renderer symbols (render, screen, createElement) and production modules
// (EffortSelectField, fromRawAcpRuntimeCatalogEntry) are imported in the same
// `before` block above; they are referenced here from the outer scope.

/** Minimal raw catalog entry for Goose with effort_canonical_values. */
function rawGooseCatalogEntry() {
  return {
    id: "goose",
    label: "Goose",
    avatar_url: "",
    availability: "available",
    command: "goose",
    binary_path: "/usr/local/bin/goose",
    default_args: [],
    mcp_command: null,
    model_env_var: null,
    provider_env_var: null,
    thinking_env_var: "GOOSE_THINKING_EFFORT",
    max_tokens_env_var: null,
    context_limit_env_var: null,
    max_rounds_env_var: null,
    install_hint: "",
    install_instructions_url: "",
    can_auto_install: false,
    requires_external_cli: false,
    underlying_cli_path: null,
    node_required: false,
    auth_status: { status: "not_applicable" },
    login_hint: null,
    source: "builtin",
    // Rust serializes these — the production fix that unlocked the values.
    effort_canonical_values: ["off", "low", "medium", "high", "max"],
  };
}

test("EffortSelectField: off is present as an option when fed Goose canonical values (mount)", async () => {
  // Wire: fromRawAcpRuntimeCatalogEntry → effortCanonicalValues → effortValid →
  // EffortSelectField option enumeration. Reverting EffortSelectField to
  // iterate only the buzz-agent master list removes "off" and fails this test.
  const runtime = fromRawAcpRuntimeCatalogEntry(rawGooseCatalogEntry());
  const effortValid = runtime.effortCanonicalValues ?? [];
  assert.ok(
    effortValid.includes("off"),
    "effortCanonicalValues must include off (catalog wiring check)",
  );

  const { unmount } = render(
    createElement(EffortSelectField, {
      currentEffort: "off",
      effortDefault: null,
      effortValid,
      htmlFor: "test-effort",
      label: "Effort",
      onChange: () => {},
      showUnavailableOptions: false,
      testId: "test-effort-select",
      useCustomSelect: false,
    }),
  );

  // The select element must contain an <option value="off"> — visible to the
  // renderer. Without the union fix, "off" is absent and currentEffort="off"
  // has no matching option, so the control falls back to the placeholder.
  const select = screen.getByTestId("test-effort-select");
  const optionValues = Array.from(select.options).map((o) => o.value);
  assert.ok(
    optionValues.includes("off"),
    `EffortSelectField must render off as an option for Goose; got: ${optionValues.join(",")}`,
  );
  // The select's value must be "off" (the option is selected, not placeholder).
  assert.equal(
    select.value,
    "off",
    'closed control must visibly select "off", not fall back to placeholder',
  );
  unmount();
});

test("EffortSelectField: off survives rerender (unrelated save simulation)", async () => {
  // Confirm "off" remains selected after a re-render that simulates an
  // unrelated settings/onboarding save (same props, second render cycle).
  const runtime = fromRawAcpRuntimeCatalogEntry(rawGooseCatalogEntry());
  const effortValid = runtime.effortCanonicalValues ?? [];

  const props = {
    currentEffort: "off",
    effortDefault: null,
    effortValid,
    htmlFor: "test-effort2",
    label: "Effort",
    onChange: () => {},
    showUnavailableOptions: false,
    testId: "test-effort-select2",
    useCustomSelect: false,
  };

  const { rerender, unmount } = render(createElement(EffortSelectField, props));
  let select = screen.getByTestId("test-effort-select2");
  assert.equal(select.value, "off", 'mount: "off" must be selected');

  // Re-render with identical props — simulates the parent re-rendering on
  // an unrelated config save without changing the effort value.
  rerender(createElement(EffortSelectField, props));
  select = screen.getByTestId("test-effort-select2");
  assert.equal(
    select.value,
    "off",
    'rerender: "off" must still be selected after unrelated save',
  );
  unmount();
});
