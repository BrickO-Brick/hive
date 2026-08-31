import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const templateCandidates = [
  path.join(testDirectory, "project-canvas-template"),
  path.resolve(
    testDirectory,
    "../../../../../src-tauri/resources/project-canvas-template",
  ),
];
const templateDirectory = templateCandidates.find((candidate) =>
  existsSync(path.join(candidate, "manifest.json")),
);

if (!templateDirectory) {
  throw new Error("Could not find the project Canvas template fixture.");
}

const desktopRoot = existsSync(
  path.resolve(process.cwd(), "desktop/package.json"),
)
  ? path.resolve(process.cwd(), "desktop")
  : path.resolve(templateDirectory, "../../..");
const require = createRequire(
  pathToFileURL(path.join(desktopRoot, "package.json")),
);
const { JSDOM } = require("jsdom");

async function readJson(relativePath) {
  return JSON.parse(
    await readFile(path.join(templateDirectory, relativePath), "utf8"),
  );
}

async function createCanvasHarness() {
  const manifest = await readJson("manifest.json");
  const fixtureData = await readJson(manifest.data);
  const sent = [];
  let listener = null;
  let started = false;
  const port = {
    addEventListener(type, nextListener) {
      if (type === "message") listener = nextListener;
    },
    emit(data) {
      assert.ok(listener, "canvas registered its port listener");
      listener({ data });
    },
    postMessage(message) {
      sent.push(message);
    },
    start() {
      started = true;
    },
  };
  const dom = new JSDOM('<main id="canvas-root"></main>', {
    runScripts: "outside-only",
    url: "buzz-canvas://localhost/template/",
  });
  Object.defineProperty(dom.window, "buzzCanvas", {
    configurable: false,
    value: Object.freeze({
      packageBaseUrl: "buzz-canvas://localhost/template/package/",
      port,
      protocolVersion: 1,
    }),
    writable: false,
  });
  for (const scriptPath of manifest.scripts) {
    dom.window.eval(
      await readFile(path.join(templateDirectory, scriptPath), "utf8"),
    );
  }
  return { dom, fixtureData, manifest, port, sent, started: () => started };
}

function initMessage(fixtureData, overrides = {}) {
  return {
    canvasId: "canvas-1",
    capabilities: [
      "project.metadata.read",
      "project.channels.read",
      "project.reviews.read",
    ],
    data: fixtureData,
    loadId: "load-1",
    mode: "preview",
    nonce: "nonce-1",
    project: { id: "project-1", name: "my-dev-team" },
    protocolVersion: 1,
    type: "host.init",
    ...overrides,
  };
}

test("template manifest declares only local ordered resources and read capabilities", async () => {
  const manifest = await readJson("manifest.json");
  assert.deepEqual(manifest, {
    capabilities: [
      "project.metadata.read",
      "project.channels.read",
      "project.reviews.read",
    ],
    data: "data/dashboards.json",
    format: "buzz-project-canvas",
    protocolVersion: 1,
    scripts: [
      "widgets/home.js",
      "widgets/dev-team.js",
      "widgets/support.js",
      "canvas.js",
    ],
    styles: [
      "styles/base.css",
      "styles/home.css",
      "styles/dev-team.css",
      "styles/support.css",
      "styles/overlays.css",
    ],
  });

  for (const relativePath of [
    manifest.data,
    ...manifest.scripts,
    ...manifest.styles,
  ]) {
    assert.equal(path.isAbsolute(relativePath), false);
    assert.equal(relativePath.split("/").includes(".."), false);
    assert.equal(
      (await stat(path.join(templateDirectory, relativePath))).isFile(),
      true,
    );
  }
  assert.ok(manifest.scripts.every((script) => !script.startsWith("http")));
  assert.ok(manifest.styles.every((style) => !style.startsWith("http")));
});

test("fixture assets are self-contained and every presentation file stays bounded", async () => {
  const manifest = await readJson("manifest.json");
  const data = await readJson(manifest.data);
  const serializedData = JSON.stringify(data);
  const assetReferences = [
    ...serializedData.matchAll(/assets\/[a-z0-9.-]+/g),
  ].map(([match]) => match);
  assert.ok(assetReferences.length >= 11);
  for (const relativePath of new Set(assetReferences)) {
    assert.equal(
      (await stat(path.join(templateDirectory, relativePath))).isFile(),
      true,
    );
  }

  for (const relativePath of [...manifest.scripts, ...manifest.styles]) {
    const source = await readFile(
      path.join(templateDirectory, relativePath),
      "utf8",
    );
    assert.ok(
      source.split(/\r?\n/).length < 850,
      `${relativePath} is too large`,
    );
    assert.doesNotMatch(source, /<\/script|<\/style/i);
    assert.doesNotMatch(source, /\b(fetch|XMLHttpRequest|WebSocket)\s*\(/);
    assert.doesNotMatch(source, /window\.parent|__TAURI__|\binvoke\s*\(/);
    assert.doesNotMatch(
      source.replaceAll("http://www.w3.org/2000/svg", ""),
      /https?:\/\//,
    );
  }
});

test("package starts the paused host port and renders all named dashboards", async () => {
  const harness = await createCanvasHarness();
  const { document } = harness.dom.window;
  assert.equal(harness.started(), true);
  assert.deepEqual(harness.sent, []);

  harness.port.emit(initMessage(harness.fixtureData));
  assert.equal(
    document.querySelector("[data-testid='project-widget-canvas']")?.dataset
      .projectDashboard,
    "dev",
  );
  assert.ok(
    document.querySelector("[data-testid='project-canvas-active-channels']"),
  );
  assert.ok(document.querySelector("[data-testid='project-canvas-reviews']"));
  assert.ok(document.querySelector("[data-testid='project-canvas-meetings']"));
  assert.deepEqual(JSON.parse(JSON.stringify(harness.sent.at(-1))), {
    dashboard: "dev",
    loadId: "load-1",
    nonce: "nonce-1",
    protocolVersion: 1,
    type: "canvas.rendered",
  });

  harness.port.emit(
    initMessage(harness.fixtureData, {
      project: { id: "project-1", name: "#my-home" },
    }),
  );
  assert.equal(
    document
      .querySelector("[data-testid='project-canvas-home-clock'] img")
      ?.getAttribute("src"),
    "buzz-canvas://localhost/template/package/assets/home-schedule-house.webp",
  );
  assert.equal(
    document
      .querySelector("[data-testid='project-canvas-home-schedule-gloopie']")
      ?.getAttribute("src"),
    "buzz-canvas://localhost/template/package/assets/gloopies-1.webm",
  );
  assert.ok(
    document.querySelector("[data-testid='project-canvas-home-clock']"),
  );
  assert.ok(
    document.querySelector("[data-testid='project-canvas-family-locations']"),
  );
  assert.ok(
    document.querySelector("[data-testid='project-canvas-chore-board']"),
  );
  const chore = document.querySelector(
    "[data-testid^='project-canvas-chore-'][type='checkbox']",
  );
  assert.ok(chore);
  chore.checked = true;
  chore.dispatchEvent(new harness.dom.window.Event("change"));
  harness.port.emit({
    loadId: "load-1",
    nonce: "nonce-1",
    protocolVersion: 1,
    snapshots: {
      channels: { data: [], status: "ready" },
      reviews: { data: [], status: "ready" },
    },
    type: "host.dataChanged",
  });
  assert.equal(chore.isConnected, true);
  assert.equal(chore.checked, true);

  harness.port.emit(
    initMessage(harness.fixtureData, {
      project: { id: "project-1", name: "my-support-channel" },
    }),
  );
  assert.ok(
    document.querySelector("[data-testid='project-canvas-release-notes']"),
  );
  assert.ok(
    document.querySelector("[data-testid='project-canvas-known-issues']"),
  );
  assert.ok(
    document.querySelector(
      "[data-testid='project-canvas-support-bug-reporter']",
    ),
  );
});

test("authoritative snapshots override fixtures including ready empty arrays", async () => {
  const harness = await createCanvasHarness();
  const { document } = harness.dom.window;
  harness.port.emit(
    initMessage(harness.fixtureData, {
      snapshots: {
        channels: { data: [], status: "ready" },
        project: { data: { name: "my-dev-team" }, status: "ready" },
        reviews: { data: null, status: "loading" },
      },
    }),
  );
  assert.equal(
    document.querySelector("[data-snapshot-state='empty']")?.textContent,
    "No channels to show",
  );
  assert.equal(
    document.querySelector("[data-snapshot-state='loading']")?.textContent,
    "Loading reviews…",
  );
  assert.equal(document.body.textContent.includes("launch-room"), false);
  assert.equal(document.body.textContent.includes("canvas-navigation"), false);

  harness.port.emit({
    loadId: "load-1",
    nonce: "nonce-1",
    protocolVersion: 1,
    snapshots: {
      channels: {
        data: [
          {
            description: "Release candidate is ready",
            memberCount: 8,
            name: "real-release",
            people: [],
          },
        ],
        status: "ready",
      },
      project: { data: { name: "my-dev-team" }, status: "ready" },
      reviews: { data: [], status: "ready" },
    },
    type: "host.dataChanged",
  });
  assert.equal(document.body.textContent.includes("real-release"), true);
  assert.equal(
    document.body.textContent.includes("Release candidate is ready"),
    true,
  );
  assert.equal(document.body.textContent.includes("No reviews to show"), true);

  harness.port.emit({
    loadId: "load-1",
    nonce: "nonce-1",
    protocolVersion: 1,
    snapshots: {
      channels: {
        data: [
          {
            description: "Shipping the local Canvas runtime",
            lastMessageAt: "2026-08-28T02:00:00.000Z",
            memberCount: 1,
            name: "real-release",
            people: [
              {
                avatarDataUrl: "data:image/png;base64,AA==",
                displayName: "Reviewer One",
                pubkey: "a".repeat(64),
              },
            ],
          },
        ],
        status: "ready",
      },
      reviews: {
        data: [
          {
            agentName: "Reviewer One",
            agentPubkey: "a".repeat(64),
            branch: "feat/real-canvas",
            displayId: "1a2b3c4d",
            id: "1a2b3c4d".repeat(8),
            status: "Approved",
            title: "Render actual review state",
          },
        ],
        status: "ready",
      },
    },
    type: "host.dataChanged",
  });
  assert.equal(document.body.textContent.includes("PR #1a2b3c4d"), false);
  assert.equal(document.body.textContent.includes("1a2b3c4d"), true);
  assert.equal(
    document.body.textContent.includes("Render actual review state"),
    true,
  );
  assert.equal(
    document
      .querySelector(
        "[data-testid='project-canvas-review-agent-approved-video']",
      )
      ?.getAttribute("aria-hidden"),
    "true",
  );
  assert.equal(
    document
      .querySelector("[data-testid='project-canvas-review-1'] .review-status")
      ?.getAttribute("aria-label"),
    "Reviewer One, approved",
  );
  assert.equal(
    document
      .querySelector(
        `[data-testid='project-canvas-active-member-${"a".repeat(64)}']`,
      )
      ?.getAttribute("src"),
    "data:image/png;base64,AA==",
  );
});

test("missing capability snapshots never reveal bundled demo rows", async () => {
  const harness = await createCanvasHarness();
  const { document } = harness.dom.window;
  harness.port.emit(
    initMessage(harness.fixtureData, {
      capabilities: ["project.metadata.read"],
      snapshots: {
        project: { data: { name: "my-dev-team" }, status: "ready" },
      },
    }),
  );

  assert.equal(
    document.body.textContent.includes("Channels access unavailable"),
    true,
  );
  assert.equal(
    document.body.textContent.includes("Reviews access unavailable"),
    true,
  );
  assert.equal(document.body.textContent.includes("launch-room"), false);
  assert.equal(document.body.textContent.includes("canvas-navigation"), false);
});

test("mode updates change package layout state without drawing a second fold marker", async () => {
  const harness = await createCanvasHarness();
  const { document } = harness.dom.window;
  harness.port.emit(initMessage(harness.fixtureData));
  harness.port.emit({
    loadId: "load-1",
    mode: "full",
    nonce: "nonce-1",
    protocolVersion: 1,
    type: "host.mode",
  });
  assert.equal(
    document.querySelector("[data-testid='project-widget-canvas']")?.dataset
      .canvasMode,
    "full",
  );
  assert.equal(
    document.querySelectorAll("[data-testid='project-canvas-preview-boundary']")
      .length,
    0,
  );
});

test("targeted data updates preserve the widget root and receive previous and next state", async () => {
  const harness = await createCanvasHarness();
  const { document } = harness.dom.window;
  harness.port.emit(
    initMessage(harness.fixtureData, {
      project: { id: "project-1", name: "my-home" },
    }),
  );
  const board = document.querySelector(
    "[data-testid='project-canvas-chore-board']",
  );
  const unrelated = document.querySelector(
    "[data-testid='project-canvas-home-clock']",
  );
  assert.ok(board);
  assert.ok(unrelated);

  const nextData = structuredClone(harness.fixtureData);
  const choreWidget = nextData.dashboards.home.widgets.find(
    (widget) => widget.id === "chores",
  );
  choreWidget.data.groups[1].completed = ["Take bins to the curb"];
  harness.port.emit({
    data: nextData,
    loadId: "load-1",
    nonce: "nonce-1",
    notificationId: "11111111111141118111111111111111",
    protocolVersion: 1,
    type: "host.widgetDataChanged",
    widgetId: "chores",
  });

  assert.equal(
    document.querySelector("[data-testid='project-canvas-chore-board']"),
    board,
  );
  assert.equal(
    document.querySelector("[data-testid='project-canvas-home-clock']"),
    unrelated,
  );
  assert.equal(board.dataset.previousCompleted, "1");
  assert.equal(board.dataset.completed, "2");
  assert.equal(board.classList.contains("widget-data-updated"), true);
  assert.equal(
    document.querySelector(
      "[data-testid='project-canvas-chore-jon-take-bins-to-the-curb']",
    )?.checked,
    true,
  );
});
