import type * as React from "react";

import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";
import { OnboardingChrome } from "./OnboardingChrome";
import { OnboardingFooterProvider } from "./OnboardingFooter";

export function OnboardingPreviewStep({
  children,
  current = 2,
  onBack,
  security = false,
  testId,
  total,
}: {
  children: React.ReactNode;
  current?: number;
  onBack?: () => void;
  security?: boolean;
  testId: string;
  total?: number;
}) {
  return (
    <div
      className={`buzz-onboarding-neutral-theme buzz-startup-shell flex max-h-dvh items-start justify-center overflow-x-hidden overflow-y-auto px-4 pb-28 pt-[106px] text-foreground ${
        security ? "buzz-onboarding-security-theme" : ""
      }`}
      data-testid={testId}
    >
      <StartupWindowDragRegion />
      {!security ? <OnboardingChrome current={current} total={total} /> : null}
      <OnboardingFooterProvider
        backAction={onBack ? { onClick: onBack } : undefined}
      >
        <div className="buzz-onboarding-step-frame relative flex w-full max-w-[1040px] flex-col items-center text-center">
          {children}
        </div>
      </OnboardingFooterProvider>
    </div>
  );
}
