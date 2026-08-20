# Packaged WKWebView acceptance foundation

This directory is the additive, non-production contract for measuring Buzz in its
shipped macOS WKWebView. It intentionally does **not** use Playwright or Chrome as
a fallback. A run without an explicit native input driver is written as
`status: "blocked"` and exits with status 2.

## Artifacts

- `fixtures/acceptance-v1.json` is the deterministic fixture and scenario
  taxonomy. Its pinned generator version, seed, reference clock, event-ID
  derivation, ordering contract, output count/bytes, and full JSONL SHA make
  relay materialization reproducible. `tooling/materialize-fixture.mjs` is the
  executable materializer. `fixture-manifest.json` separately pins the recipe’s
  byte count and SHA-256 digest.
- `schemas/` defines the immutable fixture, captured environment, run envelope,
  and raw result contracts.
- `tooling/capture-environment.mjs` captures required package/host evidence
  directly from the caller-supplied packaged `.app` and current macOS host:
  Info.plist identity/version, code-signing identity and entitlements, hardware,
  macOS/WebKit, main display, power/low-power/thermal state, and exact native
  driver bytes. Missing evidence is fatal; callers do not author release
  environment metadata by hand.
- `tooling/launch.mjs` verifies that captured environment, fixture and driver
  provenance, then hands a run ID plus the exact environment-file digest to the
  external native driver. It verifies only the supplied packaged `.app`; it does
  not claim that the bundle came from a particular release pipeline. Completion
  rejects result substitution.
- `tooling/report.mjs` rejects malformed or incomplete raw samples and emits
  nearest-rank p50/p95/p99 summaries while retaining package, hardware, OS,
  WebKit, display, runtime-state, relay, fixture, driver, and raw-file provenance.

The native driver interface is intentionally narrow: the executable receives
`--wkwebview-run <absolute-run.json>` and the same path in
`BUZZ_WKWEBVIEW_RUN`. It must drive native wheel/trackpad/keyboard input against
the `.app` in the run envelope and write the declared raw result path. A browser
driver is not contract-compatible.

## Commands

```bash
# Materialize the immutable relay fixture (exclusive output).
node tests/wkwebview/tooling/materialize-fixture.mjs \
  /path/to/events.jsonl

# Capture package and host evidence. Failure to capture a required field blocks
# acceptance; do not hand-author environment.json.
node tests/wkwebview/tooling/capture-environment.mjs \
  --app /path/to/Buzz.app \
  --git-sha <40-hex-commit> \
  --relay-version <relay-version> \
  --driver /path/to/native-driver \
  --driver-name <driver-name> \
  --driver-version <driver-version> \
  --output /path/to/environment.json

# Explicitly blocked when --driver is omitted; still writes run.json.
node tests/wkwebview/tooling/launch.mjs \
  --app /path/to/Buzz.app \
  --environment /path/to/environment.json \
  --run /path/to/run.json \
  --result /path/to/raw-result.json

# Native run.
node tests/wkwebview/tooling/launch.mjs \
  --app /path/to/Buzz.app \
  --environment /path/to/environment.json \
  --run /path/to/run.json \
  --result /path/to/raw-result.json \
  --driver /path/to/native-driver

# Validate raw data and produce provenance-preserving percentiles.
node tests/wkwebview/tooling/report.mjs \
  /path/to/raw-result.json /path/to/run.json /path/to/report.json

node --test tests/wkwebview/tooling/validation.test.mjs
```

Raw result and report outputs use exclusive creation so evidence cannot be silently
overwritten. The run envelope alone is updated in place from `running` to a
terminal `completed` or `failed` outcome. Preserve raw samples; reports are
derived and must never replace them.
