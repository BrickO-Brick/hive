/**
 * Mounted-render tests for the two archive-retention sections added in P3':
 * ObserverRetentionSection and ArchiveSizeSection.
 *
 * These mount the REAL subcomponents (exported from LocalArchiveSettingsCard)
 * against a mocked Tauri IPC bridge, so the render → validate → invoke path is
 * exercised end-to-end. The full card is not mounted: it depends on the
 * communities/channels query context, which is orthogonal to what these
 * sections do. The bound-parsing and byte-formatting logic they build on is
 * unit-tested directly in `retentionSettings.test.mjs`.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

const ipcHandlers = new Map();

let act;
let cleanup;
let fireEvent;
let render;
let screen;
let createElement;
let ObserverRetentionSection;
let ArchiveSizeSection;

before(async () => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
    writable: true,
  });
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  dom.window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      const handler = ipcHandlers.get(cmd);
      if (handler) return handler(args);
      return Promise.reject(new Error(`unmocked Tauri command: ${cmd}`));
    },
    transformCallback: () => Math.random(),
  };

  ({ act, cleanup, fireEvent, render, screen } = await import(
    "@testing-library/react"
  ));
  ({ createElement } = await import("react"));
  ({ ObserverRetentionSection, ArchiveSizeSection } = await import(
    "./LocalArchiveSettingsCard.tsx"
  ));
});

afterEach(() => {
  cleanup?.();
  ipcHandlers.clear();
});

after(() => dom.window.close());

// ── ObserverRetentionSection ──────────────────────────────────────────────────

test("retention field seeds from the saved value and disables Save while unchanged", async () => {
  await act(async () => {
    render(
      createElement(ObserverRetentionSection, {
        savedDays: 30,
        onSaved: () => {},
      }),
    );
  });

  const input = screen.getByTestId("local-archive-retention-days");
  assert.equal(input.value, "30");
  const save = screen.getByTestId("local-archive-retention-save");
  assert.equal(save.disabled, true, "unchanged value cannot be saved");
});

test("input disabled until the saved value loads", async () => {
  await act(async () => {
    render(
      createElement(ObserverRetentionSection, {
        savedDays: null,
        onSaved: () => {},
      }),
    );
  });

  assert.equal(
    screen.getByTestId("local-archive-retention-days").disabled,
    true,
  );
});

test("out-of-bounds input surfaces an inline error and blocks Save", async () => {
  await act(async () => {
    render(
      createElement(ObserverRetentionSection, {
        savedDays: 30,
        onSaved: () => {},
      }),
    );
  });

  const input = screen.getByTestId("local-archive-retention-days");
  await act(async () => {
    fireEvent.change(input, { target: { value: "0" } });
  });

  assert.match(
    screen.getByTestId("local-archive-retention-error").textContent,
    /at least 1/,
  );
  assert.equal(
    screen.getByTestId("local-archive-retention-save").disabled,
    true,
  );
});

test("a valid change saves through the invoke and reports the new value", async () => {
  const setCalls = [];
  ipcHandlers.set("set_observer_retention_days", (args) => {
    setCalls.push(args);
    return Promise.resolve(null);
  });

  let saved = null;
  await act(async () => {
    render(
      createElement(ObserverRetentionSection, {
        savedDays: 30,
        onSaved: (d) => {
          saved = d;
        },
      }),
    );
  });

  const input = screen.getByTestId("local-archive-retention-days");
  await act(async () => {
    fireEvent.change(input, { target: { value: "14" } });
  });

  const save = screen.getByTestId("local-archive-retention-save");
  assert.equal(save.disabled, false, "a changed valid value enables Save");

  await act(async () => {
    fireEvent.click(save);
  });

  assert.deepEqual(setCalls, [{ days: 14 }], "invoke receives the parsed days");
  assert.equal(saved, 14, "onSaved reports the persisted value");
});

// ── ArchiveSizeSection ────────────────────────────────────────────────────────

test("size readout shows physical size and reclaimable bytes", async () => {
  await act(async () => {
    render(
      createElement(ArchiveSizeSection, {
        stats: {
          mainFileBytes: 1024 ** 3,
          walFileBytes: 512 * 1024 ** 2,
          pageSize: 4096,
          pageCount: 300_000,
          freelistCount: 262_144, // 1 GB reclaimable
        },
      }),
    );
  });

  assert.equal(
    screen.getByTestId("local-archive-size-physical").textContent,
    "1.5 GB",
  );
  const copy = screen.getByTestId("local-archive-size-section").textContent;
  assert.match(copy, /1\.5 GB/);
  assert.match(copy, /1\.0 GB is reclaimable/);
  assert.match(copy, /only shrinks after an offline compaction/);
});

test("size readout shows a loading fallback before stats arrive", async () => {
  await act(async () => {
    render(createElement(ArchiveSizeSection, { stats: null }));
  });

  assert.equal(
    screen.getByTestId("local-archive-size-physical").textContent,
    "—",
  );
  assert.match(
    screen.getByTestId("local-archive-size-section").textContent,
    /Loading…/,
  );
});
