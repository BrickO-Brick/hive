#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadVerifiedFixture, validateEnvironment } from "./validation.mjs";

const execFileAsync = promisify(execFile);
const TOOL_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function runCommand(command, args) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
}

function requiredLine(value, label) {
  const result = value.trim();
  if (!result) throw new Error(`Capture unavailable: ${label}`);
  return result;
}

function parseDisplay(profileJson) {
  const profile = JSON.parse(profileJson);
  const displays = profile.SPDisplaysDataType?.flatMap(
    (gpu) => gpu.spdisplays_ndrvs ?? [],
  );
  const display = displays?.find(
    (candidate) => candidate.spdisplays_main === "spdisplays_yes",
  );
  if (!display) throw new Error("Capture unavailable: main display");
  const pixels = display._spdisplays_pixels?.match(/^(\d+) x (\d+)$/);
  const resolution = display._spdisplays_resolution?.match(
    /^(\d+) x (\d+) @ ([0-9.]+)Hz$/,
  );
  if (!pixels || !resolution) {
    throw new Error("Capture unavailable: main display geometry/refresh rate");
  }
  const scaleFactor = Number(pixels[1]) / Number(resolution[1]);
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new Error("Capture unavailable: main display scale factor");
  }
  return {
    refreshRateHz: Number(resolution[3]),
    widthPx: Number(pixels[1]),
    heightPx: Number(pixels[2]),
    scaleFactor,
  };
}

function parseSigningIdentity(stderr) {
  const lines = stderr.split("\n");
  const authorities = lines
    .filter((line) => line.startsWith("Authority="))
    .map((line) => line.slice("Authority=".length));
  if (authorities.length > 0) return authorities.join(" > ");
  const signature = lines.find((line) => line.startsWith("Signature="));
  if (signature) return signature.slice("Signature=".length);
  throw new Error("Capture unavailable: package signing identity");
}

function parsePowerState(batteryOutput, customOutput) {
  const powerSource = batteryOutput.includes("AC Power") ? "ac" : "battery";
  const section = powerSource === "ac" ? "AC Power:" : "Battery Power:";
  const sectionMatch = customOutput.match(
    new RegExp(
      `(?:^|\\n)${section.replace(":", "\\:")}\\n([\\s\\S]*?)(?=\\n\\S[^\\n]*:\\n|$)`,
    ),
  );
  const selected = sectionMatch?.[1] ?? "";
  const powerMode = selected.match(/^\s*powermode\s+(\d+)\s*$/m)?.[1];
  if (powerMode === undefined) {
    throw new Error("Capture unavailable: low-power mode");
  }
  return { powerSource, lowPowerMode: powerMode !== "0" };
}

function parseThermalState(output) {
  if (output.includes("No thermal warning level has been recorded")) {
    return "nominal";
  }
  for (const state of ["critical", "serious", "fair", "nominal"]) {
    if (output.toLowerCase().includes(state)) return state;
  }
  throw new Error("Capture unavailable: thermal state");
}

export async function captureEnvironment({
  appPath,
  gitSha,
  relayVersion,
  nativeDriverPath,
  nativeDriverName,
  nativeDriverVersion,
  manifestPath = path.join(TOOL_ROOT, "fixture-manifest.json"),
  commandRunner = runCommand,
  capturedAt = new Date().toISOString(),
}) {
  const resolvedAppPath = path.resolve(appPath);
  const infoPlistPath = path.join(resolvedAppPath, "Contents", "Info.plist");
  const infoPlistBytes = await readFile(infoPlistPath);
  const driverBytes = nativeDriverPath
    ? await readFile(nativeDriverPath)
    : null;
  if (
    [nativeDriverPath, nativeDriverName, nativeDriverVersion].filter(Boolean)
      .length !== 0 &&
    [nativeDriverPath, nativeDriverName, nativeDriverVersion].some(
      (value) => !value,
    )
  ) {
    throw new Error("Capture requires driver path, name, and version together");
  }
  const command = async (program, args, label, stream = "stdout") =>
    requiredLine((await commandRunner(program, args))[stream], label);
  const bundleIdentifier = await command(
    "plutil",
    ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlistPath],
    "bundle identifier",
  );
  const version = await command(
    "plutil",
    ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", infoPlistPath],
    "bundle version",
  );
  const signing = await commandRunner("codesign", [
    "-dv",
    "--verbose=4",
    resolvedAppPath,
  ]);
  const entitlements = await commandRunner("codesign", [
    "-d",
    "--entitlements",
    ":-",
    resolvedAppPath,
  ]);
  const entitlementsBytes = Buffer.from(
    requiredLine(entitlements.stdout, "package entitlements"),
  );
  const model = await command("sysctl", ["-n", "hw.model"], "hardware model");
  const cpu = await command(
    "sysctl",
    ["-n", "machdep.cpu.brand_string"],
    "CPU model",
  );
  const memoryBytes = Number(
    await command("sysctl", ["-n", "hw.memsize"], "physical memory"),
  );
  const macosVersion = await command(
    "sw_vers",
    ["-productVersion"],
    "macOS version",
  );
  const webkitVersion = await command(
    "defaults",
    [
      "read",
      "/System/Library/Frameworks/WebKit.framework/Resources/Info",
      "CFBundleShortVersionString",
    ],
    "WebKit version",
  );
  const display = parseDisplay(
    await command(
      "system_profiler",
      ["SPDisplaysDataType", "-json"],
      "display profile",
    ),
  );
  const battery = await commandRunner("pmset", ["-g", "batt"]);
  const custom = await commandRunner("pmset", ["-g", "custom"]);
  const thermal = await commandRunner("pmset", ["-g", "therm"]);
  const power = parsePowerState(battery.stdout, custom.stdout);
  const { fixture, entry } = await loadVerifiedFixture(
    manifestPath,
    "buzz-wkwebview-acceptance",
  );
  if (entry.version !== 1) {
    throw new Error("Captured fixture version is not supported");
  }

  const environment = {
    schemaVersion: 1,
    capture: {
      tool: "buzz-wkwebview-environment-capture",
      version: "1.0.0",
      capturedAt,
      infoPlistSha256: sha256(infoPlistBytes),
    },
    build: { gitSha },
    package: {
      appPath: resolvedAppPath,
      bundleIdentifier,
      version,
      identity: parseSigningIdentity(signing.stderr),
      entitlementsSha256: sha256(entitlementsBytes),
    },
    hardware: { model, cpu, memoryBytes },
    platform: { macosVersion, webkitVersion },
    display,
    runtimeState: {
      ...power,
      thermalState: parseThermalState(thermal.stdout),
    },
    fixture: {
      fixtureId: entry.fixtureId,
      version: entry.version,
      sha256: entry.sha256,
    },
    relay: {
      version: relayVersion,
      fixtureVersion: fixture.relayFixtureVersion,
    },
    nativeDriver:
      driverBytes === null
        ? null
        : {
            name: nativeDriverName,
            version: nativeDriverVersion,
            sha256: sha256(driverBytes),
          },
  };
  const errors = validateEnvironment(environment);
  if (errors.length > 0) {
    throw new Error(
      `Captured environment is invalid:\n- ${errors.join("\n- ")}`,
    );
  }
  return environment;
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument ${name}`);
    }
    options[name.slice(2)] = value;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const required = ["app", "git-sha", "relay-version", "output"];
  if (required.some((key) => !options[key])) {
    console.error(
      "Usage: node tests/wkwebview/tooling/capture-environment.mjs --app <Buzz.app> --git-sha <sha> --relay-version <version> --output <environment.json> [--driver <path> --driver-name <name> --driver-version <version>] [--manifest <manifest.json>]",
    );
    process.exitCode = 1;
    return;
  }
  const environment = await captureEnvironment({
    appPath: options.app,
    gitSha: options["git-sha"],
    relayVersion: options["relay-version"],
    nativeDriverPath: options.driver,
    nativeDriverName: options["driver-name"],
    nativeDriverVersion: options["driver-version"],
    manifestPath: options.manifest,
  });
  await writeFile(options.output, `${JSON.stringify(environment, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(path.resolve(options.output));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
