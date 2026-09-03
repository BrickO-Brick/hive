import type { QueryClient } from "@tanstack/react-query";
import { motion, useReducedMotion } from "motion/react";
import * as React from "react";

import {
  getIdentity,
  persistCurrentIdentity,
  requestMantapOtp,
  startMantapLogin,
} from "@/shared/api/tauriIdentity";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";
import { HiveWordmark } from "@/shared/ui/buzz-logo/HiveWordmark";
import { DefaultConfigStep } from "./DefaultConfigStep";
import {
  ONBOARDING_LANDING_CTA_CLASS,
  ONBOARDING_SECONDARY_CTA_CLASS,
  OnboardingChrome,
} from "./OnboardingChrome";
import { OnboardingFooterProvider } from "./OnboardingFooter";
import {
  type OnboardingTransitionDirection,
  OnboardingSlideTransition,
} from "./OnboardingSlideTransition";
import { SetupStep } from "./SetupStep";
import type { DefaultConfigDraft } from "./types";

export type MachineOnboardingPage = "identity" | "setup" | "config";

export type PostOnboardingNavigation = {
  to: string;
  search?: Record<string, string>;
};

export function MachineOnboardingFlow({
  complete,
  continueWithIdentity,
  continueWithRecoveredIdentity,
  initialPage,
  queryClient,
  navigateAfterComplete,
}: {
  complete: (pubkey?: string) => void;
  continueWithIdentity: (pubkey: string) => void;
  continueWithRecoveredIdentity: (pubkey: string) => void;
  initialPage?: MachineOnboardingPage;
  queryClient: QueryClient;
  navigateAfterComplete?: (nav: PostOnboardingNavigation) => void;
}) {
  const [page, setPage] = React.useState<MachineOnboardingPage>(
    initialPage ?? "identity",
  );
  const [transitionDirection, setTransitionDirection] =
    React.useState<OnboardingTransitionDirection>("forward");
  const [error, setError] = React.useState<string | null>(null);
  const [isPending, setIsPending] = React.useState(false);
  const [mantapStage, setMantapStage] = React.useState<"credentials" | "otp">(
    "credentials",
  );
  const [mantapUsername, setMantapUsername] = React.useState("");
  const [mantapPassword, setMantapPassword] = React.useState("");
  const [mantapOtp, setMantapOtp] = React.useState("");
  const [selectedPubkey, setSelectedPubkey] = React.useState<string | null>(
    null,
  );
  const [readyRuntimeIds, setReadyRuntimeIds] = React.useState<string[]>([]);
  const [defaultConfigDraft, setDefaultConfigDraft] =
    React.useState<DefaultConfigDraft | null>(null);
  const [isDefaultConfigSaving, setIsDefaultConfigSaving] =
    React.useState(false);
  const reduceMotion = useReducedMotion() ?? false;

  const handleReadyRuntimeIdsChange = React.useCallback(
    (runtimeIds: readonly string[]) => {
      setReadyRuntimeIds(Array.from(new Set(runtimeIds)));
    },
    [],
  );

  const requestOtp = React.useCallback(async () => {
    setIsPending(true);
    setError(null);
    try {
      await requestMantapOtp(mantapUsername.trim(), mantapPassword);
      setMantapStage("otp");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send OTP.");
    } finally {
      setIsPending(false);
    }
  }, [mantapPassword, mantapUsername]);

  const signInWithMantap = React.useCallback(async () => {
    setIsPending(true);
    setError(null);
    try {
      const mantap = await startMantapLogin(
        mantapUsername.trim(),
        mantapPassword,
        mantapOtp,
      );
      let identity = await getIdentity();
      if (identity.pubkey !== mantap.pubkey) {
        throw new Error("Mantap returned a different Hive identity.");
      }

      if (identity.lost) {
        identity = await persistCurrentIdentity();
        continueWithRecoveredIdentity(identity.pubkey);
      } else {
        continueWithIdentity(identity.pubkey);
      }

      queryClient.setQueryData(["identity"], identity);
      setSelectedPubkey(identity.pubkey);
      setMantapPassword("");
      setMantapOtp("");
      setTransitionDirection("forward");
      setPage("setup");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Failed to sign in with Mantap.",
      );
    } finally {
      setIsPending(false);
    }
  }, [
    continueWithIdentity,
    continueWithRecoveredIdentity,
    mantapOtp,
    mantapPassword,
    mantapUsername,
    queryClient,
  ]);

  const resetMantapForm = React.useCallback(() => {
    setError(null);
    setMantapStage("credentials");
    setMantapPassword("");
    setMantapOtp("");
  }, []);

  const backFromSetup = React.useCallback(() => {
    resetMantapForm();
    setTransitionDirection("backward");
    setPage("identity");
  }, [resetMantapForm]);

  const chromeBackAction =
    page === "setup"
      ? { onClick: backFromSetup }
      : page === "config"
        ? {
            disabled: isDefaultConfigSaving,
            onClick: () => {
              setTransitionDirection("backward");
              setPage("setup");
            },
          }
        : undefined;

  return (
    <div
      className={`buzz-onboarding-neutral-theme buzz-startup-shell flex max-h-dvh items-start justify-center overflow-x-hidden overflow-y-auto px-4 text-foreground ${
        page === "identity"
          ? "buzz-onboarding-welcome py-8"
          : "pb-28 pt-[106px]"
      }`}
      data-testid="machine-onboarding-gate"
    >
      <StartupWindowDragRegion />
      {page !== "identity" ? (
        <OnboardingChrome current={page === "config" ? 3 : 2} />
      ) : null}
      <OnboardingFooterProvider backAction={chromeBackAction}>
        <div
          className={`relative flex w-full max-w-[1040px] flex-col items-center text-center ${
            page === "identity" ? "my-auto" : "buzz-onboarding-step-frame"
          }`}
        >
          {page === "identity" ? (
            <OnboardingSlideTransition
              className="grid w-full items-center gap-8 px-6 text-left md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] md:px-10"
              direction={transitionDirection}
              transitionKey={`machine-identity-${transitionDirection}`}
            >
              <div className="relative mx-auto w-full max-w-[420px] overflow-hidden rounded-[2rem] bg-white/95 p-3 shadow-[0_2rem_5rem_rgb(73_28_19_/_0.18)] ring-1 ring-black/10">
                <img
                  alt="The Brickster team coding with BrickO, BrickA, BrickI, and BrickR"
                  className="aspect-square w-full rounded-[1.4rem] object-cover"
                  data-testid="onboarding-team-hero"
                  src="/branding/bricko-operations.jpg"
                />
              </div>
              <div className="flex w-full flex-col items-center text-center md:items-start md:text-left">
                <HiveWordmark className="w-full max-w-[440px] text-brand" />
                <p className="mt-3 max-w-[500px] text-2xl font-normal leading-tight text-foreground">
                  Brickster, BrickO, and all the projects, in one place,
                  let&apos;s collaborate!
                </p>
                <p className="mt-3 max-w-[500px] text-sm leading-6 text-foreground/75">
                  Sign in with your OneBrick account and let&apos;s turn “maybe”
                  into “shipped” together.
                </p>

                <form
                  className="mt-6 w-full max-w-[500px] rounded-3xl bg-white/90 p-5 text-left shadow-[0_1rem_3rem_rgb(73_28_19_/_0.14)] ring-1 ring-black/10 backdrop-blur-sm"
                  data-testid="mantap-sign-in-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void (mantapStage === "credentials"
                      ? requestOtp()
                      : signInWithMantap());
                  }}
                >
                  <motion.div
                    animate={{ opacity: 1, y: 0 }}
                    initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                    key={mantapStage}
                    transition={{
                      duration: reduceMotion ? 0 : 0.22,
                      ease: "easeOut",
                    }}
                  >
                    <h1 className="text-xl font-semibold text-foreground">
                      {mantapStage === "credentials"
                        ? "Sign in to Hive"
                        : "Check your email"}
                    </h1>
                    <p className="mt-1 text-sm leading-5 text-foreground/65">
                      {mantapStage === "credentials"
                        ? "Use your Mantap credentials. We’ll send a one-time code to your OneBrick email."
                        : `Enter the 4-digit code sent to ${mantapUsername.trim()}.`}
                    </p>

                    <div className="mt-4 space-y-4">
                      {mantapStage === "credentials" ? (
                        <>
                          <label
                            className="block space-y-2 text-sm font-medium"
                            htmlFor="mantap-email"
                          >
                            <span>OneBrick email</span>
                            <Input
                              autoComplete="username"
                              autoFocus
                              id="mantap-email"
                              onChange={(event) =>
                                setMantapUsername(event.target.value)
                              }
                              placeholder="name@onebrick.io"
                              required
                              type="email"
                              value={mantapUsername}
                            />
                          </label>
                          <label
                            className="block space-y-2 text-sm font-medium"
                            htmlFor="mantap-password"
                          >
                            <span>Password</span>
                            <Input
                              autoComplete="current-password"
                              id="mantap-password"
                              onChange={(event) =>
                                setMantapPassword(event.target.value)
                              }
                              required
                              type="password"
                              value={mantapPassword}
                            />
                          </label>
                        </>
                      ) : (
                        <label
                          className="block space-y-2 text-sm font-medium"
                          htmlFor="mantap-otp"
                        >
                          <span>4-digit OTP</span>
                          <Input
                            autoComplete="one-time-code"
                            autoFocus
                            className="text-center text-lg tracking-[0.35em]"
                            id="mantap-otp"
                            inputMode="numeric"
                            maxLength={4}
                            onChange={(event) =>
                              setMantapOtp(
                                event.target.value
                                  .replace(/\D/g, "")
                                  .slice(0, 4),
                              )
                            }
                            pattern="[0-9]{4}"
                            required
                            value={mantapOtp}
                          />
                        </label>
                      )}
                    </div>

                    {error ? (
                      <p
                        aria-live="polite"
                        className="mt-4 text-sm text-destructive"
                        role="alert"
                      >
                        {error}
                      </p>
                    ) : null}

                    <Button
                      className={`${ONBOARDING_LANDING_CTA_CLASS} mt-5 w-full`}
                      disabled={isPending}
                      type="submit"
                    >
                      {isPending
                        ? mantapStage === "credentials"
                          ? "Sending code…"
                          : "Signing in…"
                        : mantapStage === "credentials"
                          ? "Continue with OTP"
                          : "Verify and sign in"}
                    </Button>
                    {mantapStage === "otp" ? (
                      <Button
                        className={`${ONBOARDING_SECONDARY_CTA_CLASS} mt-2 w-full`}
                        disabled={isPending}
                        onClick={resetMantapForm}
                        type="button"
                        variant="ghost"
                      >
                        Use another account
                      </Button>
                    ) : null}
                  </motion.div>
                </form>

                <p className="mt-4 max-w-[500px] rounded-full bg-foreground px-4 py-2 text-xs font-semibold leading-5 text-background shadow-sm">
                  Build boldly, code joyfully, and make an impact—great work
                  together becomes an experience worth remembering.
                </p>
              </div>
            </OnboardingSlideTransition>
          ) : page === "setup" ? (
            <SetupStep
              actions={{
                back: backFromSetup,
                next: (runtimeIds) => {
                  const ids = Array.from(runtimeIds);
                  setReadyRuntimeIds(ids);
                  if (ids.length === 0) {
                    complete(selectedPubkey ?? undefined);
                    return;
                  }
                  setTransitionDirection("forward");
                  setPage("config");
                },
                navigateToAgentSettings: () => {
                  complete(selectedPubkey ?? undefined);
                  navigateAfterComplete?.({
                    to: "/settings",
                    search: { section: "agents" },
                  });
                },
              }}
              direction={transitionDirection}
              onReadyRuntimeIdsChange={handleReadyRuntimeIdsChange}
            />
          ) : (
            <DefaultConfigStep
              actions={{
                back: () => {
                  setTransitionDirection("backward");
                  setPage("setup");
                },
                complete: () => complete(selectedPubkey ?? undefined),
                discardDraft: () => setDefaultConfigDraft(null),
                updateDraft: setDefaultConfigDraft,
              }}
              direction={transitionDirection}
              draft={defaultConfigDraft}
              onSavingChange={setIsDefaultConfigSaving}
              readyRuntimeIds={readyRuntimeIds}
            />
          )}
        </div>
      </OnboardingFooterProvider>
    </div>
  );
}
