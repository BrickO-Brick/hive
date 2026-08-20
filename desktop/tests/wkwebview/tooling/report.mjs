#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadVerifiedFixture,
  readJson,
  summarizeSamples,
  validateRun,
  validateResult,
} from "./validation.mjs";

const TOOL_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export async function buildReport({
  resultPath,
  runPath,
  manifestPath = path.join(TOOL_ROOT, "fixture-manifest.json"),
}) {
  const resultBytes = await readFile(resultPath);
  let result;
  try {
    result = JSON.parse(resultBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Cannot read JSON from ${resultPath}: ${error.message}`);
  }
  if (!runPath) throw new Error("A persisted run artifact is required");
  const run = await readJson(runPath);
  const runErrors = validateRun(run);
  if (runErrors.length > 0) {
    throw new Error(`Invalid WKWebView run:\n- ${runErrors.join("\n- ")}`);
  }
  const environmentBytes = await readFile(run.environmentPath);
  const environmentSha256 = createHash("sha256")
    .update(environmentBytes)
    .digest("hex");
  if (run.status !== "completed")
    throw new Error("Run artifact is not completed");
  if (run.resultPath !== path.resolve(resultPath)) {
    throw new Error("Run artifact does not reference this raw result");
  }
  if (run.runId !== result.runId)
    throw new Error("Result runId does not match run artifact");
  if (
    run.environmentSha256 !== environmentSha256 ||
    result.environmentSha256 !== environmentSha256
  ) {
    throw new Error("Environment digest does not match launch-time bytes");
  }
  const launchEnvironment = JSON.parse(environmentBytes.toString("utf8"));
  if (
    JSON.stringify(result.environment) !== JSON.stringify(launchEnvironment)
  ) {
    throw new Error(
      "Embedded result environment does not match launch environment",
    );
  }
  const fixtureId = result.fixture?.fixtureId;
  if (typeof fixtureId !== "string" || fixtureId.length === 0) {
    throw new Error("Result does not declare fixture.fixtureId");
  }
  const { fixture, entry } = await loadVerifiedFixture(manifestPath, fixtureId);
  const errors = validateResult(result, fixture, entry);
  if (errors.length > 0) {
    throw new Error(`Invalid WKWebView result:\n- ${errors.join("\n- ")}`);
  }
  return {
    schemaVersion: 1,
    runId: result.runId,
    generatedAt: new Date().toISOString(),
    provenance: {
      rawResultPath: path.resolve(resultPath),
      rawResultSha256: createHash("sha256").update(resultBytes).digest("hex"),
      buildGitSha: result.environment.build.gitSha,
      package: result.environment.package,
      hardware: result.environment.hardware,
      platform: result.environment.platform,
      display: result.environment.display,
      runtimeState: result.environment.runtimeState,
      relay: result.environment.relay,
      nativeDriver: result.environment.nativeDriver,
      fixture: entry,
    },
    percentileMethod: "nearest-rank",
    summaries: summarizeSamples(result.samples),
  };
}

async function main() {
  const [resultPath, runPath, outputPath, manifestPath] = process.argv.slice(2);
  if (!resultPath || !runPath || !outputPath) {
    console.error(
      "Usage: node tests/wkwebview/tooling/report.mjs <raw-result.json> <run.json> <report.json> [fixture-manifest.json]",
    );
    process.exitCode = 1;
    return;
  }
  const report = await buildReport({ resultPath, runPath, manifestPath });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(outputPath);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
