const ONBOARDING_PREVIEW_PARAM = "onboardingPreview";
const ONBOARDING_PREVIEW_VALUE = "1";

type OnboardingPreviewEnvironment = {
  dev: boolean;
  mode: string;
  search: string;
};

/** Resolve the explicit, non-production onboarding workshop route. */
export function resolveOnboardingPreviewMode({
  dev,
  mode,
  search,
}: OnboardingPreviewEnvironment) {
  if (!dev && mode !== "e2e") return false;
  return (
    new URLSearchParams(search).get(ONBOARDING_PREVIEW_PARAM) ===
    ONBOARDING_PREVIEW_VALUE
  );
}

/** True only for a development or explicit E2E preview boot. */
export function onboardingPreviewRequested() {
  if (typeof window === "undefined") return false;
  return resolveOnboardingPreviewMode({
    dev: import.meta.env.DEV,
    mode: import.meta.env.MODE,
    search: window.location.search,
  });
}
