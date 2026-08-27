import assert from "node:assert/strict";
import test from "node:test";

import {
  ONBOARDING_PREVIEW_JOURNEYS,
  resolveOnboardingPreviewMode,
} from "./onboardingPreview.ts";

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

test("today preserves the complete workshop journey", () => {
  assert.deepEqual(ONBOARDING_PREVIEW_JOURNEYS.today, {
    afterAccount: "setup",
    afterCommunityEntry: "community-connecting",
    afterProfile: "starter-team",
    communityChoiceBack: "config",
    communityStep: 5,
    finalStep: 7,
    includeExistingCommunity: true,
    profileStep: 6,
    totalSteps: 7,
  });
});

test("V3 skips technical setup and the transitional community screens", () => {
  assert.deepEqual(ONBOARDING_PREVIEW_JOURNEYS.v3, {
    afterAccount: "community-choice",
    afterCommunityEntry: "community-profile",
    afterProfile: "community-home",
    communityChoiceBack: null,
    communityStep: 3,
    finalStep: 4,
    includeExistingCommunity: false,
    profileStep: 4,
    totalSteps: 4,
  });
});
