#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  loadVerifiedFixture,
  validateEnvironment,
  validateResult,
} from "./validation.mjs";

const TOOL_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function makeRun({
  appPath,
  environmentPath,
  manifestPath,
  resultPath,
  nativeDriverPath,
  environmentSha256,
}) {
  const now = new Date();
  return {
    schemaVersion: 1,
    runId: `wkwebview-${now.toISOString().replaceAll(/[:.]/g, "-")}`,
    createdAt: now.toISOString(),
    status: nativeDriverPath ? "running" : "blocked",
    ...(!nativeDriverPath && { blockedReason: "native-driver-not-supplied" }),
    appPath: path.resolve(appPath),
    fixtureManifestPath: path.resolve(manifestPath),
    environmentPath: path.resolve(environmentPath),
    environmentSha256,
    resultPath: path.resolve(resultPath),
    ...(nativeDriverPath && {
      nativeDriverPath: path.resolve(nativeDriverPath),
    }),
  };
}

async function writeRun(runPath, run, exclusive = false) {
  await mkdir(path.dirname(runPath), { recursive: true });
  await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`, {
    ...(exclusive && { flag: "wx" }),
  });
}

async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

async function assertPathDoesNotExist(filePath, label) {
  try {
    await access(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists: ${path.resolve(filePath)}`);
}

function invokeNativeDriver(driverPath, runPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(driverPath, ["--wkwebview-run", runPath], {
      stdio: "inherit",
      env: { ...process.env, BUZZ_WKWEBVIEW_RUN: runPath },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Native driver terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

export async function launchHarness({
  appPath,
  environmentPath,
  runPath,
  resultPath,
  nativeDriverPath,
  manifestPath = path.join(TOOL_ROOT, "fixture-manifest.json"),
}) {
  if (!appPath.endsWith(".app"))
    throw new Error("--app must identify a packaged .app bundle");
  await access(path.join(appPath, "Contents", "MacOS"));
  const environmentBytes = await readFile(environmentPath);
  const environmentSha256 = createHash("sha256")
    .update(environmentBytes)
    .digest("hex");
  let environment;
  try {
    environment = JSON.parse(environmentBytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read JSON from ${environmentPath}: ${error.message}`,
    );
  }
  const environmentErrors = validateEnvironment(environment);
  const infoPlistSha256 = await sha256File(
    path.join(appPath, "Contents", "Info.plist"),
  );
  if (environment.capture?.infoPlistSha256 !== infoPlistSha256) {
    environmentErrors.push(
      "environment.capture.infoPlistSha256 does not match the supplied .app",
    );
  }
  if (nativeDriverPath && environment.nativeDriver === null) {
    environmentErrors.push(
      "environment.nativeDriver provenance is required when --driver is supplied",
    );
  }
  if (!nativeDriverPath && environment.nativeDriver !== null) {
    environmentErrors.push(
      "environment.nativeDriver must be null when no --driver is supplied",
    );
  }
  if (environmentErrors.length > 0) {
    throw new Error(
      `Invalid WKWebView environment:\n- ${environmentErrors.join("\n- ")}`,
    );
  }
  if (path.resolve(environment.package.appPath) !== path.resolve(appPath)) {
    throw new Error("Environment package.appPath does not match --app");
  }
  if (nativeDriverPath) {
    const nativeDriverSha256 = await sha256File(nativeDriverPath);
    if (nativeDriverSha256 !== environment.nativeDriver.sha256) {
      throw new Error(
        "Native driver SHA-256 does not match environment.nativeDriver.sha256",
      );
    }
    await assertPathDoesNotExist(resultPath, "Raw result path");
  }
  const { fixture, entry } = await loadVerifiedFixture(
    manifestPath,
    environment.fixture.fixtureId,
  );
  if (
    environment.fixture.version !== entry.version ||
    environment.fixture.sha256 !== entry.sha256
  ) {
    throw new Error(
      "Environment fixture provenance does not match the immutable manifest",
    );
  }

  const run = makeRun({
    appPath,
    environmentPath,
    manifestPath,
    resultPath,
    nativeDriverPath,
    environmentSha256,
  });
  await writeRun(runPath, run, true);
  if (!nativeDriverPath) return run;

  try {
    const exitCode = await invokeNativeDriver(
      nativeDriverPath,
      path.resolve(runPath),
    );
    if (exitCode !== 0) {
      throw new Error(`Native driver exited with status ${exitCode}`);
    }
    await access(resultPath);
    const resultBytes = await readFile(resultPath, "utf8");
    let rawResult;
    try {
      rawResult = JSON.parse(resultBytes);
    } catch (error) {
      throw new Error(`Cannot read JSON from ${resultPath}: ${error.message}`);
    }
    if (rawResult.runId !== run.runId) {
      throw new Error("Raw result runId does not match the launch run");
    }
    if (rawResult.environmentSha256 !== run.environmentSha256) {
      throw new Error(
        "Raw result environment digest does not match the launch environment",
      );
    }
    if (JSON.stringify(rawResult.environment) !== JSON.stringify(environment)) {
      throw new Error(
        "Raw result environment does not match the launch environment",
      );
    }
    const resultErrors = validateResult(rawResult, fixture, entry);
    if (resultErrors.length > 0) {
      throw new Error(
        `Invalid WKWebView result:\n- ${resultErrors.join("\n- ")}`,
      );
    }
    run.status = "completed";
    await writeRun(runPath, run);
    return run;
  } catch (error) {
    run.status = "failed";
    run.failureReason = error instanceof Error ? error.message : String(error);
    await writeRun(runPath, run);
    throw error;
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined)
      throw new Error(`Invalid argument ${name}`);
    options[name.slice(2)] = value;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.app || !options.environment || !options.run || !options.result) {
    console.error(
      "Usage: node tests/wkwebview/tooling/launch.mjs --app <Buzz.app> --environment <environment.json> --run <run.json> --result <raw-result.json> [--driver <native-driver>] [--manifest <fixture-manifest.json>]",
    );
    process.exitCode = 1;
    return;
  }
  const run = await launchHarness({
    appPath: options.app,
    environmentPath: options.environment,
    runPath: options.run,
    resultPath: options.result,
    nativeDriverPath: options.driver,
    manifestPath: options.manifest,
  });
  console.log(JSON.stringify(run));
  if (run.status === "blocked") process.exitCode = 2;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
