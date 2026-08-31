import assert from "node:assert/strict";
import test from "node:test";

import {
  grantedProjectCanvasCapabilities,
  parseProjectCanvasChildMessage,
  parseProjectCanvasPackageDescriptor,
  parseProjectCanvasPackageDescriptorForE2e,
  parseProjectCanvasReady,
  PROJECT_CANVAS_MAX_INIT_MESSAGE_BYTES,
  PROJECT_CANVAS_MESSAGE_RATE_LIMIT,
  PROJECT_CANVAS_MESSAGE_RATE_WINDOW_MS,
  ProjectCanvasMessageRateLimiter,
  selectGrantedProjectCanvasSnapshots,
} from "./projectCanvasProtocol.ts";

const LOAD_ID = "0123456789abcdef0123456789abcdef";
const NONCE = "0123456789abcdef0123456789abcdef";

function descriptor(overrides = {}) {
  return {
    capabilities: ["project.metadata.read"],
    data: { widgets: [] },
    loadId: LOAD_ID,
    nonce: NONCE,
    revision: "revision-1",
    url: `buzz-canvas://localhost/${LOAD_ID}/`,
    ...overrides,
  };
}

test("package descriptors accept only the exact canvas protocol origin and handle path", () => {
  assert.equal(
    parseProjectCanvasPackageDescriptor(descriptor()).loadId,
    LOAD_ID,
  );
  assert.equal(
    parseProjectCanvasPackageDescriptor(
      descriptor({ url: `http://buzz-canvas.localhost/${LOAD_ID}/` }),
    ).loadId,
    LOAD_ID,
  );

  for (const url of [
    `buzz-canvas://other/${LOAD_ID}/`,
    `buzz-canvas://localhost/${LOAD_ID}`,
    `buzz-canvas://localhost/${LOAD_ID}/asset.js`,
    `buzz-canvas://localhost/${LOAD_ID}/?token=1`,
    `buzz-canvas://localhost/${LOAD_ID}/#fragment`,
    `buzz-canvas://user@localhost/${LOAD_ID}/`,
    `http://buzz-canvas.localhost:80/${LOAD_ID}/`,
    "https://example.com/canvas",
    "data:text/html,canvas",
  ]) {
    assert.throws(() =>
      parseProjectCanvasPackageDescriptor(descriptor({ url })),
    );
  }
  assert.throws(() =>
    parseProjectCanvasPackageDescriptor(
      descriptor({ loadId: "fedcba9876543210fedcba9876543210" }),
    ),
  );
  assert.throws(() =>
    parseProjectCanvasPackageDescriptor(
      descriptor({ loadId: LOAD_ID.toUpperCase() }),
    ),
  );
});

test("data URLs are available only through the explicit E2E parser", () => {
  const value = descriptor({ url: "data:text/html,canvas" });
  assert.throws(() => parseProjectCanvasPackageDescriptor(value));
  assert.equal(
    parseProjectCanvasPackageDescriptorForE2e(value).loadId,
    LOAD_ID,
  );
});

test("package data must be bounded JSON", () => {
  assert.throws(() =>
    parseProjectCanvasPackageDescriptor(
      descriptor({ data: { value: Number.POSITIVE_INFINITY } }),
    ),
  );
  assert.throws(() =>
    parseProjectCanvasPackageDescriptor(
      descriptor({ data: { value: new Date() } }),
    ),
  );
  let nested = {};
  for (let index = 0; index < 32; index += 1) nested = { nested };
  assert.equal(
    parseProjectCanvasPackageDescriptor(descriptor({ data: nested })).loadId,
    LOAD_ID,
  );
  assert.throws(() =>
    parseProjectCanvasPackageDescriptor(descriptor({ data: { nested } })),
  );
  assert.equal(
    parseProjectCanvasPackageDescriptor(
      descriptor({ data: Array.from({ length: 9_999 }, () => 0) }),
    ).loadId,
    LOAD_ID,
  );
  assert.throws(() =>
    parseProjectCanvasPackageDescriptor(
      descriptor({ data: Array.from({ length: 10_000 }, () => 0) }),
    ),
  );
});

test("native-sized package data leaves bounded headroom for host snapshots", () => {
  const nativeSizedData = { value: "x".repeat(256 * 1_024) };
  assert.equal(
    parseProjectCanvasPackageDescriptor(descriptor({ data: nativeSizedData }))
      .loadId,
    LOAD_ID,
  );
  assert.throws(() =>
    parseProjectCanvasPackageDescriptor(
      descriptor({ data: { value: "x".repeat(320 * 1_024) } }),
    ),
  );
  assert.equal(
    new TextEncoder().encode(
      JSON.stringify({
        data: nativeSizedData,
        snapshots: { avatars: "x".repeat(1_600 * 1_024) },
      }),
    ).byteLength < PROJECT_CANVAS_MAX_INIT_MESSAGE_BYTES,
    true,
  );
});

test("ready messages require the expected version, nonce, and exact shape", () => {
  const ready = {
    nonce: NONCE,
    protocolVersion: 1,
    type: "canvas.ready",
  };
  assert.deepEqual(parseProjectCanvasReady(ready, NONCE), ready);
  assert.equal(parseProjectCanvasReady(ready, "different-nonce-value"), null);
  assert.equal(
    parseProjectCanvasReady({ ...ready, protocolVersion: 2 }, NONCE),
    null,
  );
  assert.equal(
    parseProjectCanvasReady({ ...ready, projectId: "spoof" }, NONCE),
    null,
  );
});

test("child messages are bound to the native load before action fields are accepted", () => {
  const rendered = {
    dashboard: "home",
    loadId: LOAD_ID,
    nonce: NONCE,
    protocolVersion: 1,
    type: "canvas.rendered",
  };
  assert.deepEqual(
    parseProjectCanvasChildMessage(rendered, {
      loadId: LOAD_ID,
      nonce: NONCE,
    }),
    rendered,
  );
  assert.equal(
    parseProjectCanvasChildMessage(
      { ...rendered, loadId: "fedcba9876543210fedcba9876543210" },
      { loadId: LOAD_ID, nonce: NONCE },
    ),
    null,
  );
  assert.equal(
    parseProjectCanvasChildMessage(
      { ...rendered, nonce: "fedcba9876543210fedcba9876543210" },
      { loadId: LOAD_ID, nonce: NONCE },
    ),
    null,
  );
  assert.equal(
    parseProjectCanvasChildMessage(
      { ...rendered, protocolVersion: 2 },
      { loadId: LOAD_ID, nonce: NONCE },
    ),
    null,
  );
});

test("capabilities are intersected with the fixed host read set", () => {
  assert.deepEqual(
    grantedProjectCanvasCapabilities([
      "project.metadata.read",
      "network",
      "project.channels.read",
      "project.metadata.read",
      "project.reviews.read",
      "filesystem",
    ]),
    ["project.metadata.read", "project.channels.read", "project.reviews.read"],
  );
});

test("snapshot selection omits every capability the package was not granted", () => {
  const snapshots = {
    channels: { data: [], status: "ready" },
    project: {
      data: {
        description: "Project",
        id: "30621:owner:project",
        name: "Project",
        owner: "owner",
        repositories: [],
      },
      status: "ready",
    },
    reviews: { data: null, status: "loading" },
  };
  assert.deepEqual(
    selectGrantedProjectCanvasSnapshots(snapshots, [
      "project.metadata.read",
      "project.reviews.read",
    ]),
    {
      project: snapshots.project,
      reviews: snapshots.reviews,
    },
  );
});

test("message rate limiting uses a bounded rolling window", () => {
  const limiter = new ProjectCanvasMessageRateLimiter();
  for (let index = 0; index < PROJECT_CANVAS_MESSAGE_RATE_LIMIT; index += 1) {
    assert.equal(limiter.accept(index), true);
  }
  assert.equal(limiter.accept(PROJECT_CANVAS_MESSAGE_RATE_LIMIT), false);
  assert.equal(limiter.accept(PROJECT_CANVAS_MESSAGE_RATE_WINDOW_MS + 1), true);
});
