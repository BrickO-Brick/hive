import assert from "node:assert/strict";
import test from "node:test";

import { resolveOnboardingPreviewMode } from "./onboardingPreview.ts";

test("preview requires an exact development opt-in", () => {
  assert.equal(
    resolveOnboardingPreviewMode({
      dev: true,
      mode: "development",
      search: "?onboardingPreview=1",
    }),
    true,
  );
  assert.equal(
    resolveOnboardingPreviewMode({
      dev: true,
      mode: "development",
      search: "?onboardingPreview=true",
    }),
    false,
  );
});

test("preview is unavailable in production", () => {
  assert.equal(
    resolveOnboardingPreviewMode({
      dev: false,
      mode: "production",
      search: "?onboardingPreview=1",
    }),
    false,
  );
});

test("preview is available to the explicit E2E build", () => {
  assert.equal(
    resolveOnboardingPreviewMode({
      dev: false,
      mode: "e2e",
      search: "?onboardingPreview=1",
    }),
    true,
  );
});
