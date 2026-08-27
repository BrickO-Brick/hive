const ONBOARDING_PREVIEW_PARAM = "onboardingPreview";
const ONBOARDING_PREVIEW_VALUE = "1";

type OnboardingPreviewEnvironment = {
  dev: boolean;
  mode: string;
  search: string;
};

export type OnboardingPreviewPage =
  | "landing"
  | "email"
  | "identity-key"
  | "sign-in"
  | "sign-in-key"
  | "forgot-password"
  | "backup-options"
  | "backup-password"
  | "setup"
  | "config"
  | "community-choice"
  | "community-entry"
  | "community-connecting"
  | "community-profile"
  | "starter-team"
  | "welcome-channel"
  | "community-home";

export type OnboardingPreviewVariant = "today" | "v3";

type OnboardingPreviewJourney = {
  afterAccount: OnboardingPreviewPage;
  afterCommunityEntry: OnboardingPreviewPage;
  afterProfile: OnboardingPreviewPage;
  communityChoiceBack: OnboardingPreviewPage | null;
  communityStep: number;
  finalStep: number;
  includeExistingCommunity: boolean;
  profileStep: number;
  totalSteps: number;
};

/** Workshop-only route maps that preserve today's full flow beside V3. */
export const ONBOARDING_PREVIEW_JOURNEYS: Record<
  OnboardingPreviewVariant,
  OnboardingPreviewJourney
> = {
  today: {
    afterAccount: "setup",
    afterCommunityEntry: "community-connecting",
    afterProfile: "starter-team",
    communityChoiceBack: "config",
    communityStep: 5,
    finalStep: 7,
    includeExistingCommunity: true,
    profileStep: 6,
    totalSteps: 7,
  },
  v3: {
    afterAccount: "community-choice",
    afterCommunityEntry: "community-profile",
    afterProfile: "community-home",
    communityChoiceBack: null,
    communityStep: 3,
    finalStep: 4,
    includeExistingCommunity: false,
    profileStep: 4,
    totalSteps: 4,
  },
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
