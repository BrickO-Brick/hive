import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { captureEnvironment } from "./capture-environment.mjs";
import { launchHarness } from "./launch.mjs";
import {
  materializeFixture,
  serializeMaterializedEvents,
} from "./materialize-fixture.mjs";
import { buildReport } from "./report.mjs";
import {
  loadVerifiedFixture,
  nearestRank,
  summarizeSamples,
  validateEnvironment,
  validateFixture,
  validateRun,
  validateResult,
} from "./validation.mjs";

const WKWEBVIEW_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const MANIFEST_PATH = path.join(WKWEBVIEW_ROOT, "fixture-manifest.json");
const FIXTURE_SHA =
  "efdb8dc8ef0624be8ba86dc3fc0bb3374bd266b63f5a0f661df02797bc107000";
const DIGEST = "a".repeat(64);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function environment(
  appPath = "/Applications/Buzz.app",
  nativeDriverSha256 = DIGEST,
) {
  return {
    schemaVersion: 1,
    capture: {
      tool: "buzz-wkwebview-environment-capture",
      version: "1.0.0",
      capturedAt: "2026-08-20T16:00:00.000Z",
      infoPlistSha256: sha256("fixture app plist"),
    },
    build: { gitSha: "b".repeat(40) },
    package: {
      appPath,
      bundleIdentifier: "com.block.buzz",
      version: "1.2.3",
      identity: "package-equivalent-test",
      entitlementsSha256: DIGEST,
    },
    hardware: {
      model: "Mac15,6",
      cpu: "Apple M3 Pro",
      memoryBytes: 18_000_000_000,
    },
    platform: { macosVersion: "15.6", webkitVersion: "620.3.4" },
    display: {
      refreshRateHz: 120,
      widthPx: 3024,
      heightPx: 1964,
      scaleFactor: 2,
    },
    runtimeState: {
      powerSource: "ac",
      lowPowerMode: false,
      thermalState: "nominal",
    },
    fixture: {
      fixtureId: "buzz-wkwebview-acceptance",
      version: 1,
      sha256: FIXTURE_SHA,
    },
    relay: { version: "buzz-relay-test", fixtureVersion: "wkwebview-relay-v1" },
    nativeDriver: {
      name: "native-test-driver",
      version: "1",
      sha256: nativeDriverSha256,
    },
  };
}

function result(
  appPath,
  runId = "run-1",
  environmentSha256 = DIGEST,
  nativeDriverSha256 = DIGEST,
) {
  return {
    schemaVersion: 1,
    runId,
    environmentSha256,
    environment: environment(appPath, nativeDriverSha256),
    fixture: {
      fixtureId: "buzz-wkwebview-acceptance",
      version: 1,
      sha256: FIXTURE_SHA,
    },
    samples: [
      {
        sampleId: "sample-1",
        category: "switch",
        scenario: "cold-switch",
        metric: "stable-painted-frame",
        unit: "ms",
        value: 11,
        observedAt: "2026-08-20T16:00:00.000Z",
      },
      {
        sampleId: "sample-2",
        category: "switch",
        scenario: "cold-switch",
        metric: "stable-painted-frame",
        unit: "ms",
        value: 19,
        observedAt: "2026-08-20T16:00:01.000Z",
      },
    ],
  };
}

test("checked-in fixture matches its immutable manifest", async () => {
  const { fixture, entry } = await loadVerifiedFixture(
    MANIFEST_PATH,
    "buzz-wkwebview-acceptance",
  );
  assert.equal(entry.sha256, FIXTURE_SHA);
  assert.deepEqual(validateFixture(fixture), []);
  assert.equal(fixture.inputSemantics, "native-wheel-trackpad-keyboard");
  assert.deepEqual(Object.keys(fixture.scenarioTaxonomy), [
    "switch",
    "input",
    "timeline",
    "plateau",
    "ipc",
    "recovery",
    "crash",
  ]);
});

test("fixture materializer matches the golden count, boundaries, and full JSONL digest", async () => {
  const { fixture } = await loadVerifiedFixture(
    MANIFEST_PATH,
    "buzz-wkwebview-acceptance",
  );
  const events = materializeFixture(fixture);
  const bytes = serializeMaterializedEvents(events);
  assert.equal(events.length, 8740);
  assert.equal(Buffer.byteLength(bytes), 4255320);
  assert.equal(
    sha256(bytes),
    "ac948604f0100b93ce9d6f143b7160b6cd7f1389e1be407ed15fc45dca72edca",
  );
  assert.deepEqual(
    { id: events[0].id, sig: events[0].sig },
    {
      id: "e4800994921ad9f45a226d672a7af9cd588bf343eecaed5cedadaf297f8886e5",
      sig: "4eaff818e1b8efa64c18d194ffb15f1b1fbd001bfd521889de65babbefb38047943a0ef03c0ad0d2fc425d5355368f56e39d6f24ee4b05847074ff1488e9d9f7",
    },
  );
  assert.deepEqual(
    { id: events.at(-1).id, sig: events.at(-1).sig },
    {
      id: "de52203f953aca0df0a76d42fb1ef3c9f58140b15fe646d0077114be996a8135",
      sig: "35c8a50c1392bc5fd3358dfd6ccca8cbed3169443031ce37b8f9a15789b4fa014e1d012256b615d1d54f04ee16d4be26e2509e8e4ccb1814931b9465d6c7ac6e",
    },
  );
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];
    assert(
      previous.created_at < current.created_at ||
        (previous.created_at === current.created_at &&
          previous.id.localeCompare(current.id) <= 0),
    );
  }
});

test("environment capture derives package and host provenance at the command boundary", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "buzz-wkwebview-capture-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const appPath = path.join(directory, "Buzz.app");
  const infoPlistPath = path.join(appPath, "Contents", "Info.plist");
  const driverPath = path.join(directory, "native-driver");
  await mkdir(path.dirname(infoPlistPath), { recursive: true });
  await writeFile(infoPlistPath, "captured plist bytes");
  await writeFile(driverPath, "captured driver bytes");
  const responses = new Map([
    [
      `plutil -extract CFBundleIdentifier raw -o - ${infoPlistPath}`,
      { stdout: "com.block.buzz\n", stderr: "" },
    ],
    [
      `plutil -extract CFBundleShortVersionString raw -o - ${infoPlistPath}`,
      { stdout: "1.2.3\n", stderr: "" },
    ],
    [
      `codesign -dv --verbose=4 ${appPath}`,
      {
        stdout: "",
        stderr: "Authority=Developer ID Application: Block, Inc.\n",
      },
    ],
    [
      `codesign -d --entitlements :- ${appPath}`,
      { stdout: "<plist>entitlements</plist>\n", stderr: "" },
    ],
    ["sysctl -n hw.model", { stdout: "Mac15,6\n", stderr: "" }],
    [
      "sysctl -n machdep.cpu.brand_string",
      { stdout: "Apple M3 Pro\n", stderr: "" },
    ],
    ["sysctl -n hw.memsize", { stdout: "18000000000\n", stderr: "" }],
    ["sw_vers -productVersion", { stdout: "15.6\n", stderr: "" }],
    [
      "defaults read /System/Library/Frameworks/WebKit.framework/Resources/Info CFBundleShortVersionString",
      { stdout: "620.3.4\n", stderr: "" },
    ],
    [
      "system_profiler SPDisplaysDataType -json",
      {
        stdout: JSON.stringify({
          SPDisplaysDataType: [
            {
              spdisplays_ndrvs: [
                {
                  spdisplays_main: "spdisplays_yes",
                  _spdisplays_pixels: "3024 x 1964",
                  _spdisplays_resolution: "1512 x 982 @ 120.00Hz",
                },
              ],
            },
          ],
        }),
        stderr: "",
      },
    ],
    ["pmset -g batt", { stdout: "Now drawing from 'AC Power'\n", stderr: "" }],
    [
      "pmset -g custom",
      {
        stdout: "Battery Power:\n powermode 1\nAC Power:\n powermode 0\n",
        stderr: "",
      },
    ],
    [
      "pmset -g therm",
      {
        stdout: "Note: No thermal warning level has been recorded\n",
        stderr: "",
      },
    ],
  ]);
  const commandRunner = async (command, args) => {
    const response = responses.get([command, ...args].join(" "));
    if (!response)
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    return response;
  };

  const captured = await captureEnvironment({
    appPath,
    gitSha: "b".repeat(40),
    relayVersion: "relay-1",
    nativeDriverPath: driverPath,
    nativeDriverName: "driver",
    nativeDriverVersion: "1",
    manifestPath: MANIFEST_PATH,
    commandRunner,
    capturedAt: "2026-08-20T16:00:00.000Z",
  });
  assert.deepEqual(validateEnvironment(captured), []);
  assert.equal(captured.package.bundleIdentifier, "com.block.buzz");
  assert.equal(
    captured.package.identity,
    "Developer ID Application: Block, Inc.",
  );
  assert.equal(captured.display.refreshRateHz, 120);
  assert.equal(captured.display.scaleFactor, 2);
  assert.deepEqual(captured.runtimeState, {
    powerSource: "ac",
    lowPowerMode: false,
    thermalState: "nominal",
  });
  assert.equal(captured.nativeDriver.sha256, sha256("captured driver bytes"));
});

test("environment capture fails closed when required host evidence is unavailable", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "buzz-wkwebview-capture-fail-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const appPath = path.join(directory, "Buzz.app");
  await mkdir(path.join(appPath, "Contents"), { recursive: true });
  await writeFile(path.join(appPath, "Contents", "Info.plist"), "plist");
  const driverPath = path.join(directory, "driver");
  await writeFile(driverPath, "driver");
  await assert.rejects(
    () =>
      captureEnvironment({
        appPath,
        gitSha: "b".repeat(40),
        relayVersion: "relay-1",
        nativeDriverPath: driverPath,
        nativeDriverName: "driver",
        nativeDriverVersion: "1",
        manifestPath: MANIFEST_PATH,
        commandRunner: async () => ({ stdout: "", stderr: "" }),
      }),
    /Capture unavailable: bundle identifier/,
  );
});

test("valid environment and raw result pass provenance validation", async () => {
  const { fixture, entry } = await loadVerifiedFixture(
    MANIFEST_PATH,
    "buzz-wkwebview-acceptance",
  );
  const rawResult = result("/Applications/Buzz.app");
  assert.deepEqual(validateEnvironment(rawResult.environment), []);
  assert.deepEqual(validateResult(rawResult, fixture, entry), []);
});

test("missing provenance, unknown keys, malformed samples, and fixture drift fail", async () => {
  const { fixture, entry } = await loadVerifiedFixture(
    MANIFEST_PATH,
    "buzz-wkwebview-acceptance",
  );
  const rawResult = result("/Applications/Buzz.app");
  delete rawResult.environment.platform.webkitVersion;
  rawResult.environment.package.unexpected = true;
  rawResult.samples[0].value = Number.NaN;
  rawResult.samples[0].unexpected = true;
  rawResult.samples[1].sampleId = "sample-1";
  rawResult.samples.push({
    ...rawResult.samples[1],
    sampleId: "sample-3",
    category: "switch",
    scenario: "not-in-fixture",
  });
  rawResult.fixture.sha256 = "c".repeat(64);
  rawResult.environment.fixture.sha256 = rawResult.fixture.sha256;
  const errors = validateResult(rawResult, fixture, entry);
  assert(errors.some((error) => error.includes("webkitVersion")));
  assert(
    errors.some((error) => error.includes("package.unexpected is not allowed")),
  );
  assert(
    errors.some((error) =>
      error.includes("samples[0].unexpected is not allowed"),
    ),
  );
  assert(errors.some((error) => error.includes("value must be finite")));
  assert(errors.some((error) => error.includes("sampleId must be unique")));
  assert(errors.some((error) => error.includes("immutable fixture")));
  assert(
    errors.some((error) =>
      error.includes("sha256 must match the checked-in manifest"),
    ),
  );
});

test("nearest-rank summaries use the ceiling rank without interpolation", () => {
  assert.equal(nearestRank([4, 1, 3, 2], 0.5), 2);
  assert.equal(nearestRank([4, 1, 3, 2], 0.95), 4);
  const summaries = summarizeSamples(result("/Applications/Buzz.app").samples);
  assert.deepEqual(summaries, [
    {
      category: "switch",
      scenario: "cold-switch",
      metric: "stable-painted-frame",
      unit: "ms",
      count: 2,
      p50: 11,
      p95: 19,
      p99: 19,
    },
  ]);
});

test("report retains provenance and rejects launch-environment substitution", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "buzz-wkwebview-report-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const appPath = "/Applications/Buzz.app";
  const environmentPath = path.join(directory, "environment.json");
  const environmentBytes = Buffer.from(
    `${JSON.stringify(environment(appPath))}\n`,
  );
  const environmentSha256 = createHash("sha256")
    .update(environmentBytes)
    .digest("hex");
  await writeFile(environmentPath, environmentBytes);
  const resultPath = path.join(directory, "raw-result.json");
  const runPath = path.join(directory, "run.json");
  const rawResult = result(appPath, "run-1", environmentSha256);
  const completeRun = {
    schemaVersion: 1,
    runId: "run-1",
    createdAt: "2026-08-20T16:00:00.000Z",
    status: "completed",
    appPath,
    fixtureManifestPath: MANIFEST_PATH,
    environmentPath,
    environmentSha256,
    resultPath,
    nativeDriverPath: "/tmp/native-test-driver",
  };
  await writeFile(resultPath, `${JSON.stringify(rawResult)}\n`);
  await writeFile(runPath, `${JSON.stringify(completeRun)}\n`);
  const report = await buildReport({
    resultPath,
    runPath,
    manifestPath: MANIFEST_PATH,
  });
  assert.equal(report.percentileMethod, "nearest-rank");
  assert.match(report.provenance.rawResultSha256, /^[0-9a-f]{64}$/);
  assert.equal(report.provenance.fixture.sha256, FIXTURE_SHA);
  assert.equal(report.provenance.nativeDriver.name, "native-test-driver");
  assert.equal(report.provenance.platform.webkitVersion, "620.3.4");
  assert.deepEqual(report.summaries[0], {
    category: "switch",
    scenario: "cold-switch",
    metric: "stable-painted-frame",
    unit: "ms",
    count: 2,
    p50: 11,
    p95: 19,
    p99: 19,
  });

  rawResult.environment.package.version = "substituted";
  await writeFile(resultPath, `${JSON.stringify(rawResult)}\n`);
  await assert.rejects(
    () => buildReport({ resultPath, runPath, manifestPath: MANIFEST_PATH }),
    /Embedded result environment does not match launch environment/,
  );

  rawResult.environment.package.version = "1.2.3";
  await writeFile(resultPath, `${JSON.stringify(rawResult)}\n`);
  delete completeRun.createdAt;
  completeRun.unexpected = true;
  await writeFile(runPath, `${JSON.stringify(completeRun)}\n`);
  await assert.rejects(
    () => buildReport({ resultPath, runPath, manifestPath: MANIFEST_PATH }),
    /run\.unexpected is not allowed[\s\S]*run\.createdAt/,
  );
});

test("launch records blocked instead of substituting a browser without a native driver", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "buzz-wkwebview-launch-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const appPath = path.join(directory, "Buzz.app");
  await mkdir(path.join(appPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(
    path.join(appPath, "Contents", "Info.plist"),
    "fixture app plist",
  );
  const environmentPath = path.join(directory, "environment.json");
  const runPath = path.join(directory, "run.json");
  const resultPath = path.join(directory, "raw-result.json");
  const blockedEnvironment = environment(appPath);
  blockedEnvironment.nativeDriver = null;
  await writeFile(environmentPath, `${JSON.stringify(blockedEnvironment)}\n`);

  const run = await launchHarness({
    appPath,
    environmentPath,
    runPath,
    resultPath,
    manifestPath: MANIFEST_PATH,
  });
  assert.equal(run.status, "blocked");
  assert.equal(run.blockedReason, "native-driver-not-supplied");
  assert.equal(run.nativeDriverPath, undefined);
  assert.deepEqual(JSON.parse(await readFile(runPath, "utf8")), run);
  await assert.rejects(() => readFile(resultPath), { code: "ENOENT" });
});

test("tampered fixture bytes fail manifest verification", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "buzz-wkwebview-fixture-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "fixtures"));
  await writeFile(
    path.join(directory, "fixtures", "fixture.json"),
    '{"tampered":true}\n',
  );
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      fixtures: [
        {
          fixtureId: "fixture",
          version: 1,
          path: "fixtures/fixture.json",
          bytes: 1,
          sha256: DIGEST,
        },
      ],
    }),
  );
  await assert.rejects(
    () => loadVerifiedFixture(path.join(directory, "manifest.json"), "fixture"),
    /integrity check failed/,
  );
});

test("native driver success persists a completed terminal run", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "buzz-wkwebview-driver-success-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const appPath = path.join(directory, "Buzz.app");
  await mkdir(path.join(appPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(
    path.join(appPath, "Contents", "Info.plist"),
    "fixture app plist",
  );
  const environmentPath = path.join(directory, "environment.json");
  const runPath = path.join(directory, "run.json");
  const resultPath = path.join(directory, "raw-result.json");
  const driverPath = path.join(directory, "driver.sh");
  const driverSource = `#!/bin/sh\nnode - <<'NODE'\nconst fs = require("node:fs");\nconst run = require(process.env.BUZZ_WKWEBVIEW_RUN);\nconst environment = JSON.parse(fs.readFileSync(run.environmentPath, "utf8"));\nconst result = ${JSON.stringify(
    {
      schemaVersion: 1,
      fixture: {
        fixtureId: "buzz-wkwebview-acceptance",
        version: 1,
        sha256: FIXTURE_SHA,
      },
      samples: result(appPath).samples,
    },
  )};\nresult.runId = run.runId;\nresult.environmentSha256 = run.environmentSha256;\nresult.environment = environment;\nfs.writeFileSync(run.resultPath, JSON.stringify(result) + "\\n", { flag: "wx" });\nNODE\n`;
  const driverSha256 = sha256(driverSource);
  const capturedEnvironment = environment(appPath, driverSha256);
  await writeFile(environmentPath, `${JSON.stringify(capturedEnvironment)}\n`);
  await writeFile(driverPath, driverSource, { mode: 0o755 });

  const run = await launchHarness({
    appPath,
    environmentPath,
    runPath,
    resultPath,
    nativeDriverPath: driverPath,
    manifestPath: MANIFEST_PATH,
  });
  assert.equal(run.status, "completed");
  assert.equal(run.failureReason, undefined);
  assert.deepEqual(JSON.parse(await readFile(runPath, "utf8")), run);
  const writtenResult = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(writtenResult.runId, run.runId);
  assert.equal(writtenResult.environmentSha256, run.environmentSha256);
});

test("launch rejects a substituted native driver before creating a run", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "buzz-wkwebview-driver-digest-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const appPath = path.join(directory, "Buzz.app");
  await mkdir(path.join(appPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(
    path.join(appPath, "Contents", "Info.plist"),
    "fixture app plist",
  );
  const environmentPath = path.join(directory, "environment.json");
  const runPath = path.join(directory, "run.json");
  const resultPath = path.join(directory, "raw-result.json");
  const driverPath = path.join(directory, "driver.sh");
  await writeFile(driverPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(environmentPath, `${JSON.stringify(environment(appPath))}\n`);

  await assert.rejects(
    () =>
      launchHarness({
        appPath,
        environmentPath,
        runPath,
        resultPath,
        nativeDriverPath: driverPath,
        manifestPath: MANIFEST_PATH,
      }),
    /Native driver SHA-256 does not match/,
  );
  await assert.rejects(() => readFile(runPath), { code: "ENOENT" });
});

test("launch rejects a stale raw-result path before invoking the driver", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "buzz-wkwebview-stale-result-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const appPath = path.join(directory, "Buzz.app");
  await mkdir(path.join(appPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(
    path.join(appPath, "Contents", "Info.plist"),
    "fixture app plist",
  );
  const environmentPath = path.join(directory, "environment.json");
  const runPath = path.join(directory, "run.json");
  const resultPath = path.join(directory, "raw-result.json");
  const driverPath = path.join(directory, "driver.sh");
  const markerPath = path.join(directory, "driver-invoked");
  const driverSource = `#!/bin/sh\ntouch ${JSON.stringify(markerPath)}\nexit 0\n`;
  await writeFile(driverPath, driverSource, { mode: 0o755 });
  await writeFile(
    environmentPath,
    `${JSON.stringify(environment(appPath, sha256(driverSource)))}\n`,
  );
  await writeFile(resultPath, `${JSON.stringify(result(appPath))}\n`);

  await assert.rejects(
    () =>
      launchHarness({
        appPath,
        environmentPath,
        runPath,
        resultPath,
        nativeDriverPath: driverPath,
        manifestPath: MANIFEST_PATH,
      }),
    /Raw result path already exists/,
  );
  await assert.rejects(() => readFile(markerPath), { code: "ENOENT" });
  await assert.rejects(() => readFile(runPath), { code: "ENOENT" });
});

test("native driver failure persists a failed terminal run with reason", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "buzz-wkwebview-driver-failure-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const appPath = path.join(directory, "Buzz.app");
  await mkdir(path.join(appPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(
    path.join(appPath, "Contents", "Info.plist"),
    "fixture app plist",
  );
  const environmentPath = path.join(directory, "environment.json");
  const runPath = path.join(directory, "run.json");
  const resultPath = path.join(directory, "raw-result.json");
  const driverPath = path.join(directory, "driver.sh");
  const driverSource = "#!/bin/sh\nexit 7\n";
  await writeFile(
    environmentPath,
    `${JSON.stringify(environment(appPath, sha256(driverSource)))}\n`,
  );
  await writeFile(driverPath, driverSource, { mode: 0o755 });

  await assert.rejects(
    () =>
      launchHarness({
        appPath,
        environmentPath,
        runPath,
        resultPath,
        nativeDriverPath: driverPath,
        manifestPath: MANIFEST_PATH,
      }),
    /status 7/,
  );
  const run = JSON.parse(await readFile(runPath, "utf8"));
  assert.equal(run.status, "failed");
  assert.equal(run.failureReason, "Native driver exited with status 7");
  assert.equal(run.nativeDriverPath, driverPath);
});

test("run validator enforces status-dependent fields and unknown-key rejection", () => {
  const completed = {
    schemaVersion: 1,
    runId: "run-1",
    createdAt: "2026-08-20T16:00:00.000Z",
    status: "completed",
    appPath: "/Applications/Buzz.app",
    fixtureManifestPath: "/tmp/manifest.json",
    environmentPath: "/tmp/environment.json",
    environmentSha256: DIGEST,
    resultPath: "/tmp/result.json",
    unexpected: true,
  };
  const errors = validateRun(completed);
  assert(
    errors.some((error) => error.includes("run.unexpected is not allowed")),
  );
  assert(
    errors.some((error) =>
      error.includes("run.nativeDriverPath must be a non-empty string"),
    ),
  );

  assert(
    validateRun({
      ...completed,
      status: "running",
      unexpected: undefined,
    }).some((error) =>
      error.includes("run.nativeDriverPath must be a non-empty string"),
    ),
  );
  assert(
    validateRun({
      ...completed,
      nativeDriverPath: "/tmp/driver",
      blockedReason: "native-driver-not-supplied",
      unexpected: undefined,
    }).some((error) =>
      error.includes("run.blockedReason is only allowed for a blocked run"),
    ),
  );
  assert(
    validateRun({
      ...completed,
      nativeDriverPath: "/tmp/driver",
      failureReason: "stale failure",
      unexpected: undefined,
    }).some((error) =>
      error.includes("run.failureReason is only allowed for a failed run"),
    ),
  );
});

test("fixture validator rejects nested unknown keys", async () => {
  const { fixture } = await loadVerifiedFixture(
    MANIFEST_PATH,
    "buzz-wkwebview-acceptance",
  );
  const malformed = structuredClone(fixture);
  malformed.channels[0].unexpected = true;
  malformed.scenarioTaxonomy.unexpected = ["scenario"];
  const errors = validateFixture(malformed);
  assert(
    errors.some((error) =>
      error.includes("channels[0].unexpected is not allowed"),
    ),
  );
  assert(
    errors.some((error) =>
      error.includes("scenarioTaxonomy.unexpected is not allowed"),
    ),
  );
});
