import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Card } from "@/shared/ui/card";
import { useSmoothCorners } from "@/shared/ui/smoothCorners";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";
import { OnboardingChrome } from "./OnboardingChrome";
import { OnboardingFooterProvider } from "./OnboardingFooter";

const OnboardingPreviewCardContext = React.createContext(false);

export function OnboardingPreviewLayoutProvider({
  card,
  children,
}: {
  card: boolean;
  children: React.ReactNode;
}) {
  return (
    <OnboardingPreviewCardContext.Provider value={card}>
      {children}
    </OnboardingPreviewCardContext.Provider>
  );
}

/** Whether the current workshop screen uses the experimental V3 card layout. */
export function useOnboardingPreviewCardLayout() {
  return React.useContext(OnboardingPreviewCardContext);
}

export function OnboardingPreviewStep({
  cardHeight = "standard",
  children,
  current = 2,
  onBack,
  security = false,
  testId,
  total,
}: {
  cardHeight?: "content" | "standard";
  children: React.ReactNode;
  current?: number;
  onBack?: () => void;
  security?: boolean;
  testId: string;
  total?: number;
}) {
  const cardLayout = useOnboardingPreviewCardLayout();
  const contentHeightCard = cardLayout && cardHeight === "content";
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  useSmoothCorners(cardRef, { enabled: cardLayout });
  const frame = (
    <div
      className={cn(
        "buzz-onboarding-step-frame relative flex w-full flex-col",
        cardLayout
          ? cn(
              "-mx-2 min-h-0 w-[calc(100%+1rem)] max-w-none items-stretch px-2 text-left",
              contentHeightCard
                ? "flex-none overflow-visible"
                : "flex-1 overflow-hidden",
            )
          : "max-w-[1040px] flex-1 items-center text-center",
      )}
    >
      {children}
    </div>
  );

  return (
    <div
      className={cn(
        "buzz-onboarding-neutral-theme buzz-startup-shell flex max-h-dvh justify-center overflow-x-hidden overflow-y-auto px-4 text-foreground",
        cardLayout ? "items-center py-6" : "items-start pb-28 pt-[106px]",
        security && !cardLayout && "buzz-onboarding-security-theme",
      )}
      data-testid={testId}
    >
      <StartupWindowDragRegion />
      {!security || cardLayout ? (
        <OnboardingChrome current={current} total={total} />
      ) : null}
      {cardLayout ? (
        <Card
          className={cn(
            "flex w-full max-w-140 flex-col overflow-hidden rounded-[2rem] bg-white p-6 shadow-lg [&_.buzz-onboarding-transition-line]:justify-start [&_h1+p]:!mt-2 [&_h1+p]:!text-base [&_h1+p]:!leading-6 [&_h1]:!text-2xl [&_h1]:!leading-8 [&_h1]:!text-foreground",
            contentHeightCard
              ? "h-auto max-h-[calc(100dvh-3rem)]"
              : "h-[min(35rem,calc(100dvh-3rem))] max-h-140",
          )}
          data-testid="onboarding-preview-content-card"
          ref={cardRef}
        >
          <OnboardingFooterProvider
            backAction={onBack ? { onClick: onBack } : undefined}
            placement="card"
          >
            {frame}
          </OnboardingFooterProvider>
        </Card>
      ) : (
        <OnboardingFooterProvider
          backAction={onBack ? { onClick: onBack } : undefined}
        >
          {frame}
        </OnboardingFooterProvider>
      )}
    </div>
  );
}
