/**
 * Mounted regression: AgentConfigFields passes Goose canonical values to
 * EffortSelectField so `off` renders as a visible, human-labelled "Off" option
 * and remains selected across a parent config re-render (Save/reread path).
 *
 * Pass-2 regression (PR #4625): optionSource was "legacyProviderModelCatalog"
 * so AgentConfigFields used buzz-agent vocab (no "off"), clearing the value.
 * Pass-3 fix: isHarnessNativeEffort branch uses `runtime.effortCanonicalValues`.
 *
 * Mutation proof:
 *   - Removing the isHarnessNativeEffort branch (lines 634-636) reverts
 *     effortValidForRenderer to getProviderEffortConfig → buzz-agent vocab with
 *     no "off", so the option is absent and this test turns RED.
 *   - Removing "off" from effortCanonicalValues in fromRawAcpRuntimeCatalogEntry
 *     removes it from effortValidForRenderer → same failure.
 *   - Pass-4 label fix: revert humanizeEffortLabel and the option label is
 *     lowercase "off" not "Off" → the visible-label assertion turns RED.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

// ── Global env setup ─────────────────────────────────────────────────────────
Object.assign(globalThis, {
  document: dom.window.document,
  window: dom.window,
  IS_REACT_ACT_ENVIRONMENT: true,
  localStorage: dom.window.localStorage,
  self: dom.window,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
  writable: true,
});
dom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame;
dom.window.matchMedia ??= (query) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});
globalThis.matchMedia = dom.window.matchMedia;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key === "window" || key === "document" || key === "globalThis") continue;
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
// Suppress Radix non-Event dispatchEvent throws
const _origDispatch = dom.window.EventTarget.prototype.dispatchEvent;
dom.window.EventTarget.prototype.dispatchEvent = function (event) {
  if (!(event instanceof dom.window.Event)) return false;
  return _origDispatch.call(this, event);
};
globalThis.EventTarget = dom.window.EventTarget;

// ── Tauri IPC stub ────────────────────────────────────────────────────────────
globalThis.__TAURI_INTERNALS__ = {
  invoke: (cmd) => {
    if (cmd === "discover_agent_models")
      return Promise.resolve({ options: [], is_optional: true });
    return Promise.reject(new Error(`unmocked: ${cmd}`));
  },
  transformCallback: () => 1,
};
dom.window.__TAURI_INTERNALS__ = globalThis.__TAURI_INTERNALS__;

// ── Deferred imports ──────────────────────────────────────────────────────────

let act, render, screen, cleanup;
let AgentConfigFields;
let fromRawAcpRuntimeCatalogEntry;
let createElement;

before(async () => {
  ({ act, render, screen, cleanup } = await import("@testing-library/react"));
  ({ AgentConfigFields } = await import("./AgentConfigFields.tsx"));
  ({ fromRawAcpRuntimeCatalogEntry } = await import(
    "../../../shared/api/tauri.ts"
  ));
  ({ createElement } = await import("react"));
});

afterEach(() => cleanup?.());

// ── Fixture ───────────────────────────────────────────────────────────────────

/** Minimal raw Goose catalog entry with effort_canonical_values. */
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
    model_env_var: "GOOSE_MODEL",
    provider_env_var: "GOOSE_PROVIDER",
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
    effort_canonical_values: ["off", "low", "medium", "high", "max"],
  };
}

/** Render AgentConfigFields with a Goose runtime and effortLevel=off. */
function mountGooseConfig(runtime, configOverride) {
  const config = {
    env_vars: { GOOSE_THINKING_EFFORT: "off" },
    provider: "anthropic", // non-empty: prevents dependentFieldsDisabled
    model: null,
    preferred_runtime: "goose",
    ...(configOverride ?? {}),
  };
  let captured = null;
  const props = {
    bakedEnv: [],
    selectedRuntime: runtime,
    config,
    isCustomModelEditing: false,
    isCustomProvider: false,
    onConfigChange: (next) => {
      captured = next;
    },
    onCustomModelEditingChange: () => {},
    onIsCustomProviderChange: () => {},
    disclosure: "full",
  };
  const { rerender, unmount } = render(createElement(AgentConfigFields, props));
  return {
    rerender: (nextConfig) =>
      rerender(
        createElement(AgentConfigFields, {
          ...props,
          config: nextConfig ?? config,
        }),
      ),
    unmount,
    getCaptured: () => captured,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("AgentConfigFields: Goose off renders with human label 'Off' (mount)", async () => {
  // Regression: without the isHarnessNativeEffort branch, effortValidForRenderer
  // uses buzz-agent vocab (no "off"); "off" is absent from options and the
  // closed control falls back to the inherit placeholder. With the fix, Goose's
  // own catalog vocab is used and "off" is present with label "Off".
  const runtime = fromRawAcpRuntimeCatalogEntry(rawGooseCatalogEntry());
  const { unmount } = mountGooseConfig(runtime);
  await act(async () => {});

  const select = screen.getByTestId("global-agent-thinking-effort-select");
  const option = Array.from(select.options).find((o) => o.value === "off");
  assert.ok(
    option,
    "off option must be present when isHarnessNativeEffort uses runtime catalog vocab",
  );
  assert.equal(
    select.value,
    "off",
    'closed control must show "off" as selected value',
  );
  assert.equal(
    option.textContent,
    "Off",
    'human label must be "Off" not "off" — humanizeEffortLabel capitalizes first char',
  );
  unmount();
});

test("AgentConfigFields: Goose off survives parent config re-render (unrelated Save)", async () => {
  // Re-render with identical props simulates the parent re-rendering on an
  // unrelated config save without changing the effort value. The closed
  // control must still show "Off" selected — no hook clears it because
  // isHarnessNativeEffort suppresses useEffortAutoClear for harnessNative.
  const runtime = fromRawAcpRuntimeCatalogEntry(rawGooseCatalogEntry());
  const { rerender, unmount } = mountGooseConfig(runtime);
  await act(async () => {});

  const selectBefore = screen.getByTestId(
    "global-agent-thinking-effort-select",
  );
  assert.equal(selectBefore.value, "off", "mount: off must be selected");

  // Simulate an unrelated Save (re-render with same config, different provider
  // model field update that doesn't touch effort).
  const rerenderConfig = {
    env_vars: { GOOSE_THINKING_EFFORT: "off" },
    provider: "anthropic",
    model: "claude-3-5-sonnet", // model changed, effort unchanged
    preferred_runtime: "goose",
  };
  rerender(rerenderConfig);
  await act(async () => {});

  const selectAfter = screen.getByTestId("global-agent-thinking-effort-select");
  assert.equal(
    selectAfter.value,
    "off",
    "rerender: off must survive a parent config re-render that changes model",
  );
  const optionAfter = Array.from(selectAfter.options).find(
    (o) => o.value === "off",
  );
  assert.equal(
    optionAfter?.textContent,
    "Off",
    "human label must remain 'Off' after re-render",
  );
  unmount();
});
