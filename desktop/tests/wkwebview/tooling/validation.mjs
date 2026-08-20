import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const SCENARIO_CATEGORIES = [
  "switch",
  "input",
  "timeline",
  "plateau",
  "ipc",
  "recovery",
  "crash",
];

const SAMPLE_UNITS = new Set(["ms", "px", "bytes", "count", "ratio"]);
const SHA_256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label, errors) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return {};
  }
  return value;
}

function requireNonEmptyString(value, label, errors) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label} must be a non-empty string`);
  }
}

function requirePositiveNumber(value, label, errors) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    errors.push(`${label} must be a positive finite number`);
  }
}

function requireInteger(value, label, errors, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    errors.push(`${label} must be an integer >= ${minimum}`);
  }
}

function requireTimestamp(value, label, errors) {
  requireNonEmptyString(value, label, errors);
  if (typeof value === "string" && Number.isNaN(Date.parse(value))) {
    errors.push(`${label} must be an ISO-8601 timestamp`);
  }
}

function requireSha(value, label, errors, pattern = SHA_256) {
  if (typeof value !== "string" || !pattern.test(value)) {
    errors.push(`${label} has an invalid digest`);
  }
}

function rejectUnknownKeys(value, allowed, label, errors) {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
  }
}

export function validateFixture(fixture) {
  const errors = [];
  const root = requireRecord(fixture, "fixture", errors);
  rejectUnknownKeys(
    root,
    new Set([
      "fixtureId",
      "version",
      "relayFixtureVersion",
      "materialization",
      "inputSemantics",
      "channels",
      "scenarioTaxonomy",
      "correctnessCeilings",
    ]),
    "fixture",
    errors,
  );
  requireNonEmptyString(root.fixtureId, "fixture.fixtureId", errors);
  if (root.version !== 1) errors.push("fixture.version must equal 1");
  requireNonEmptyString(
    root.relayFixtureVersion,
    "fixture.relayFixtureVersion",
    errors,
  );
  const materialization = requireRecord(
    root.materialization,
    "fixture.materialization",
    errors,
  );
  const materializationKeys = [
    "generator",
    "generatorVersion",
    "algorithm",
    "seedHex",
    "referenceTime",
    "signerPrivateKeyHex",
    "signatureContract",
    "eventKind",
    "tagContract",
    "contentContract",
    "eventIdContract",
    "orderingContract",
    "createdAtStepSeconds",
    "outputEventCount",
    "outputBytes",
    "outputSha256",
  ];
  rejectUnknownKeys(
    materialization,
    new Set(materializationKeys),
    "fixture.materialization",
    errors,
  );
  const expectedMaterialization = {
    generator: "buzz-wkwebview-fixture",
    generatorVersion: "1.0.0",
    algorithm: "nostr-canonical-sha256-v1",
    signatureContract: "BIP340 with 32 zero aux-rand bytes",
    eventKind: 9,
    tagContract:
      '[["h",channelId],["fixture",fixtureId],["ordinal",zeroBasedOrdinal decimal]]',
    contentContract:
      "UTF-8 fixture:{contentProfile}:{seedHex}:{zeroBasedOrdinal decimal}",
    eventIdContract:
      "NIP-01 sha256 canonical [0,pubkey,created_at,kind,tags,content]",
    orderingContract: "created_at-ascending-then-event-id-ascending",
  };
  for (const [key, value] of Object.entries(expectedMaterialization)) {
    if (materialization[key] !== value) {
      errors.push(`fixture.materialization.${key} has an unsupported contract`);
    }
  }
  if (
    typeof materialization.seedHex !== "string" ||
    !/^[0-9a-f]+$/.test(materialization.seedHex) ||
    materialization.seedHex.length % 2 !== 0
  ) {
    errors.push(
      "fixture.materialization.seedHex must be even-length lowercase hex",
    );
  }
  if (
    typeof materialization.signerPrivateKeyHex !== "string" ||
    !/^[0-9a-f]{64}$/.test(materialization.signerPrivateKeyHex)
  ) {
    errors.push(
      "fixture.materialization.signerPrivateKeyHex must be 64 lowercase hex characters",
    );
  }
  requireTimestamp(
    materialization.referenceTime,
    "fixture.materialization.referenceTime",
    errors,
  );
  requireInteger(
    materialization.createdAtStepSeconds,
    "fixture.materialization.createdAtStepSeconds",
    errors,
    1,
  );
  requireInteger(
    materialization.outputEventCount,
    "fixture.materialization.outputEventCount",
    errors,
    1,
  );
  requireInteger(
    materialization.outputBytes,
    "fixture.materialization.outputBytes",
    errors,
    1,
  );
  requireSha(
    materialization.outputSha256,
    "fixture.materialization.outputSha256",
    errors,
  );
  if (root.inputSemantics !== "native-wheel-trackpad-keyboard") {
    errors.push("fixture.inputSemantics must require native input");
  }
  if (!Array.isArray(root.channels) || root.channels.length < 3) {
    errors.push("fixture.channels must contain at least three channels");
  } else {
    for (const [index, channelValue] of root.channels.entries()) {
      const label = `fixture.channels[${index}]`;
      const channel = requireRecord(channelValue, label, errors);
      rejectUnknownKeys(
        channel,
        new Set(["id", "messageCount", "contentProfile"]),
        label,
        errors,
      );
      requireNonEmptyString(channel.id, `${label}.id`, errors);
      requireInteger(channel.messageCount, `${label}.messageCount`, errors, 1);
      requireNonEmptyString(
        channel.contentProfile,
        `${label}.contentProfile`,
        errors,
      );
    }
  }
  const taxonomy = requireRecord(
    root.scenarioTaxonomy,
    "fixture.scenarioTaxonomy",
    errors,
  );
  rejectUnknownKeys(
    taxonomy,
    new Set(SCENARIO_CATEGORIES),
    "fixture.scenarioTaxonomy",
    errors,
  );
  for (const category of SCENARIO_CATEGORIES) {
    const scenarios = taxonomy[category];
    if (
      !Array.isArray(scenarios) ||
      scenarios.length === 0 ||
      scenarios.some(
        (scenario) => typeof scenario !== "string" || scenario.length === 0,
      ) ||
      new Set(scenarios).size !== scenarios.length
    ) {
      errors.push(
        `fixture.scenarioTaxonomy.${category} must contain unique scenarios`,
      );
    }
  }
  const ceilings = requireRecord(
    root.correctnessCeilings,
    "fixture.correctnessCeilings",
    errors,
  );
  if (Object.keys(ceilings).length === 0) {
    errors.push("fixture.correctnessCeilings must not be empty");
  }
  for (const [key, value] of Object.entries(ceilings)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      errors.push(
        `fixture.correctnessCeilings.${key} must be a non-negative number`,
      );
    }
  }
  return errors;
}

export function validateEnvironment(environment) {
  const errors = [];
  const root = requireRecord(environment, "environment", errors);
  rejectUnknownKeys(
    root,
    new Set([
      "schemaVersion",
      "capture",
      "build",
      "package",
      "hardware",
      "platform",
      "display",
      "runtimeState",
      "fixture",
      "relay",
      "nativeDriver",
    ]),
    "environment",
    errors,
  );
  if (root.schemaVersion !== 1)
    errors.push("environment.schemaVersion must equal 1");

  const capture = requireRecord(root.capture, "environment.capture", errors);
  rejectUnknownKeys(
    capture,
    new Set(["tool", "version", "capturedAt", "infoPlistSha256"]),
    "environment.capture",
    errors,
  );
  if (capture.tool !== "buzz-wkwebview-environment-capture") {
    errors.push("environment.capture.tool is invalid");
  }
  if (capture.version !== "1.0.0") {
    errors.push("environment.capture.version is invalid");
  }
  requireTimestamp(
    capture.capturedAt,
    "environment.capture.capturedAt",
    errors,
  );
  requireSha(
    capture.infoPlistSha256,
    "environment.capture.infoPlistSha256",
    errors,
  );

  const build = requireRecord(root.build, "environment.build", errors);
  rejectUnknownKeys(build, new Set(["gitSha"]), "environment.build", errors);
  requireSha(build.gitSha, "environment.build.gitSha", errors, GIT_SHA);

  const pkg = requireRecord(root.package, "environment.package", errors);
  rejectUnknownKeys(
    pkg,
    new Set([
      "appPath",
      "bundleIdentifier",
      "version",
      "identity",
      "entitlementsSha256",
    ]),
    "environment.package",
    errors,
  );
  for (const key of ["appPath", "bundleIdentifier", "version", "identity"]) {
    requireNonEmptyString(pkg[key], `environment.package.${key}`, errors);
  }
  if (typeof pkg.appPath === "string" && !pkg.appPath.endsWith(".app")) {
    errors.push("environment.package.appPath must identify a .app bundle");
  }
  requireSha(
    pkg.entitlementsSha256,
    "environment.package.entitlementsSha256",
    errors,
  );

  const hardware = requireRecord(root.hardware, "environment.hardware", errors);
  rejectUnknownKeys(
    hardware,
    new Set(["model", "cpu", "memoryBytes"]),
    "environment.hardware",
    errors,
  );
  requireNonEmptyString(hardware.model, "environment.hardware.model", errors);
  requireNonEmptyString(hardware.cpu, "environment.hardware.cpu", errors);
  requireInteger(
    hardware.memoryBytes,
    "environment.hardware.memoryBytes",
    errors,
    1,
  );

  const platform = requireRecord(root.platform, "environment.platform", errors);
  rejectUnknownKeys(
    platform,
    new Set(["macosVersion", "webkitVersion"]),
    "environment.platform",
    errors,
  );
  requireNonEmptyString(
    platform.macosVersion,
    "environment.platform.macosVersion",
    errors,
  );
  requireNonEmptyString(
    platform.webkitVersion,
    "environment.platform.webkitVersion",
    errors,
  );

  const display = requireRecord(root.display, "environment.display", errors);
  rejectUnknownKeys(
    display,
    new Set(["refreshRateHz", "widthPx", "heightPx", "scaleFactor"]),
    "environment.display",
    errors,
  );
  requirePositiveNumber(
    display.refreshRateHz,
    "environment.display.refreshRateHz",
    errors,
  );
  requireInteger(display.widthPx, "environment.display.widthPx", errors, 1);
  requireInteger(display.heightPx, "environment.display.heightPx", errors, 1);
  requirePositiveNumber(
    display.scaleFactor,
    "environment.display.scaleFactor",
    errors,
  );

  const runtime = requireRecord(
    root.runtimeState,
    "environment.runtimeState",
    errors,
  );
  rejectUnknownKeys(
    runtime,
    new Set(["powerSource", "lowPowerMode", "thermalState"]),
    "environment.runtimeState",
    errors,
  );
  if (!new Set(["ac", "battery"]).has(runtime.powerSource)) {
    errors.push("environment.runtimeState.powerSource must be ac or battery");
  }
  if (typeof runtime.lowPowerMode !== "boolean") {
    errors.push("environment.runtimeState.lowPowerMode must be boolean");
  }
  if (
    !new Set(["nominal", "fair", "serious", "critical"]).has(
      runtime.thermalState,
    )
  ) {
    errors.push("environment.runtimeState.thermalState is invalid");
  }

  const fixture = requireRecord(root.fixture, "environment.fixture", errors);
  rejectUnknownKeys(
    fixture,
    new Set(["fixtureId", "version", "sha256"]),
    "environment.fixture",
    errors,
  );
  requireNonEmptyString(
    fixture.fixtureId,
    "environment.fixture.fixtureId",
    errors,
  );
  requireInteger(fixture.version, "environment.fixture.version", errors, 1);
  requireSha(fixture.sha256, "environment.fixture.sha256", errors);

  const relay = requireRecord(root.relay, "environment.relay", errors);
  rejectUnknownKeys(
    relay,
    new Set(["version", "fixtureVersion"]),
    "environment.relay",
    errors,
  );
  requireNonEmptyString(relay.version, "environment.relay.version", errors);
  requireNonEmptyString(
    relay.fixtureVersion,
    "environment.relay.fixtureVersion",
    errors,
  );

  if (!Object.hasOwn(root, "nativeDriver")) {
    errors.push(
      "environment.nativeDriver is required (use null when no native driver is supplied)",
    );
  }
  const driver = root.nativeDriver;
  if (driver !== null) {
    const driverRecord = requireRecord(
      driver,
      "environment.nativeDriver",
      errors,
    );
    rejectUnknownKeys(
      driverRecord,
      new Set(["name", "version", "sha256"]),
      "environment.nativeDriver",
      errors,
    );
    requireNonEmptyString(
      driverRecord.name,
      "environment.nativeDriver.name",
      errors,
    );
    requireNonEmptyString(
      driverRecord.version,
      "environment.nativeDriver.version",
      errors,
    );
    requireSha(driverRecord.sha256, "environment.nativeDriver.sha256", errors);
  }

  return errors;
}

export function validateRun(run) {
  const errors = [];
  const root = requireRecord(run, "run", errors);
  rejectUnknownKeys(
    root,
    new Set([
      "schemaVersion",
      "runId",
      "createdAt",
      "status",
      "blockedReason",
      "failureReason",
      "appPath",
      "fixtureManifestPath",
      "environmentPath",
      "environmentSha256",
      "resultPath",
      "nativeDriverPath",
    ]),
    "run",
    errors,
  );
  if (root.schemaVersion !== 1) errors.push("run.schemaVersion must equal 1");
  requireNonEmptyString(root.runId, "run.runId", errors);
  requireTimestamp(root.createdAt, "run.createdAt", errors);
  if (
    !new Set(["blocked", "running", "completed", "failed"]).has(root.status)
  ) {
    errors.push("run.status is invalid");
  }
  requireNonEmptyString(root.appPath, "run.appPath", errors);
  if (typeof root.appPath === "string" && !root.appPath.endsWith(".app")) {
    errors.push("run.appPath must identify a .app bundle");
  }
  for (const key of ["fixtureManifestPath", "environmentPath", "resultPath"]) {
    requireNonEmptyString(root[key], `run.${key}`, errors);
  }
  requireSha(root.environmentSha256, "run.environmentSha256", errors);

  if (root.status === "blocked") {
    if (root.blockedReason !== "native-driver-not-supplied") {
      errors.push(
        "run.blockedReason must equal native-driver-not-supplied for a blocked run",
      );
    }
  } else if (Object.hasOwn(root, "blockedReason")) {
    errors.push("run.blockedReason is only allowed for a blocked run");
  }
  if (
    root.status === "running" ||
    root.status === "completed" ||
    root.status === "failed"
  ) {
    requireNonEmptyString(
      root.nativeDriverPath,
      "run.nativeDriverPath",
      errors,
    );
  } else if (Object.hasOwn(root, "nativeDriverPath")) {
    errors.push("run.nativeDriverPath is not allowed for a blocked run");
  }
  if (root.status === "failed") {
    requireNonEmptyString(root.failureReason, "run.failureReason", errors);
  } else if (Object.hasOwn(root, "failureReason")) {
    errors.push("run.failureReason is only allowed for a failed run");
  }
  return errors;
}

export function validateResult(result, fixture, fixtureEntry) {
  const errors = [];
  const root = requireRecord(result, "result", errors);
  rejectUnknownKeys(
    root,
    new Set([
      "schemaVersion",
      "runId",
      "environmentSha256",
      "environment",
      "fixture",
      "samples",
    ]),
    "result",
    errors,
  );
  if (root.schemaVersion !== 1)
    errors.push("result.schemaVersion must equal 1");
  requireNonEmptyString(root.runId, "result.runId", errors);
  requireSha(root.environmentSha256, "result.environmentSha256", errors);
  errors.push(...validateEnvironment(root.environment));
  if (root.environment?.nativeDriver === null) {
    errors.push("result.environment.nativeDriver provenance is required");
  }

  const fixtureRef = requireRecord(root.fixture, "result.fixture", errors);
  rejectUnknownKeys(
    fixtureRef,
    new Set(["fixtureId", "version", "sha256"]),
    "result.fixture",
    errors,
  );
  requireNonEmptyString(
    fixtureRef.fixtureId,
    "result.fixture.fixtureId",
    errors,
  );
  requireInteger(fixtureRef.version, "result.fixture.version", errors, 1);
  requireSha(fixtureRef.sha256, "result.fixture.sha256", errors);

  if (isRecord(root.environment?.fixture)) {
    for (const key of ["fixtureId", "version", "sha256"]) {
      if (fixtureRef[key] !== root.environment.fixture[key]) {
        errors.push(
          `result.fixture.${key} must match environment.fixture.${key}`,
        );
      }
    }
  }
  if (isRecord(fixture)) {
    if (
      fixtureRef.fixtureId !== fixture.fixtureId ||
      fixtureRef.version !== fixture.version
    ) {
      errors.push(
        "result fixture identity does not match the checked-in fixture",
      );
    }
  }

  if (isRecord(fixtureEntry)) {
    for (const key of ["fixtureId", "version", "sha256"]) {
      if (fixtureRef[key] !== fixtureEntry[key]) {
        errors.push(`result.fixture.${key} must match the checked-in manifest`);
      }
    }
  }
  if (
    typeof fixtureEntry?.fixtureId === "string" &&
    root.environment?.fixture?.fixtureId === fixtureEntry.fixtureId
  ) {
    for (const key of ["version", "sha256"]) {
      if (root.environment.fixture[key] !== fixtureEntry[key]) {
        errors.push(
          `result.environment.fixture.${key} must match the checked-in manifest`,
        );
      }
    }
  }

  if (!Array.isArray(root.samples) || root.samples.length === 0) {
    errors.push("result.samples must contain raw samples");
    return errors;
  }

  const sampleIds = new Set();
  for (const [index, sampleValue] of root.samples.entries()) {
    const label = `result.samples[${index}]`;
    const sample = requireRecord(sampleValue, label, errors);
    rejectUnknownKeys(
      sample,
      new Set([
        "sampleId",
        "category",
        "scenario",
        "metric",
        "unit",
        "value",
        "observedAt",
      ]),
      label,
      errors,
    );
    requireNonEmptyString(sample.sampleId, `${label}.sampleId`, errors);
    if (sampleIds.has(sample.sampleId))
      errors.push(`${label}.sampleId must be unique`);
    sampleIds.add(sample.sampleId);
    if (!SCENARIO_CATEGORIES.includes(sample.category)) {
      errors.push(`${label}.category is invalid`);
    }
    requireNonEmptyString(sample.scenario, `${label}.scenario`, errors);
    requireNonEmptyString(sample.metric, `${label}.metric`, errors);
    if (!SAMPLE_UNITS.has(sample.unit)) errors.push(`${label}.unit is invalid`);
    if (typeof sample.value !== "number" || !Number.isFinite(sample.value)) {
      errors.push(`${label}.value must be finite`);
    }
    requireTimestamp(sample.observedAt, `${label}.observedAt`, errors);
    const allowedScenarios = fixture?.scenarioTaxonomy?.[sample.category];
    if (
      Array.isArray(allowedScenarios) &&
      !allowedScenarios.includes(sample.scenario)
    ) {
      errors.push(`${label}.scenario is not declared by the immutable fixture`);
    }
  }
  return errors;
}

export function nearestRank(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("nearestRank requires at least one sample");
  }
  if (!(percentile > 0 && percentile <= 1)) {
    throw new Error("percentile must be in the interval (0, 1]");
  }
  if (
    values.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error("nearestRank requires finite numeric samples");
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1];
}

export function summarizeSamples(samples) {
  const groups = new Map();
  for (const sample of samples) {
    const key = JSON.stringify([
      sample.category,
      sample.scenario,
      sample.metric,
      sample.unit,
    ]);
    const group = groups.get(key) ?? { ...sample, values: [] };
    group.values.push(sample.value);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ category, scenario, metric, unit, values }) => ({
      category,
      scenario,
      metric,
      unit,
      count: values.length,
      p50: nearestRank(values, 0.5),
      p95: nearestRank(values, 0.95),
      p99: nearestRank(values, 0.99),
    }))
    .sort((left, right) =>
      [left.category, left.scenario, left.metric, left.unit]
        .join("\0")
        .localeCompare(
          [right.category, right.scenario, right.metric, right.unit].join("\0"),
        ),
    );
}

export async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read JSON from ${filePath}: ${error.message}`);
  }
}

export async function loadVerifiedFixture(manifestPath, fixtureId) {
  const manifest = await readJson(manifestPath);
  const entry = manifest.fixtures?.find(
    (candidate) => candidate.fixtureId === fixtureId,
  );
  if (!entry) throw new Error(`Fixture ${fixtureId} is not in ${manifestPath}`);
  const fixturePath = path.resolve(path.dirname(manifestPath), entry.path);
  const bytes = await readFile(fixturePath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== entry.bytes || digest !== entry.sha256) {
    throw new Error(`Fixture integrity check failed for ${fixturePath}`);
  }
  const fixture = JSON.parse(bytes.toString("utf8"));
  const errors = validateFixture(fixture);
  if (errors.length > 0) {
    throw new Error(`Invalid immutable fixture:\n- ${errors.join("\n- ")}`);
  }
  return { fixture, entry, fixturePath };
}
