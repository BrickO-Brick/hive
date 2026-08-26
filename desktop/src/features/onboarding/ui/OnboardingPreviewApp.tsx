import { Check, RotateCcw, ShieldCheck } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import * as React from "react";

import type { JoinPolicy } from "@/shared/api/invites";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";
import { BackupStep } from "./BackupStep";
import { JoinPolicyNotice } from "./JoinPolicyNotice";
import { LandingBees } from "./LandingBees";
import { NostrKeyImportForm } from "./NostrKeyImportForm";
import {
  ONBOARDING_LANDING_CTA_CLASS,
  ONBOARDING_PRIMARY_CTA_CLASS,
  ONBOARDING_SECONDARY_CTA_CLASS,
  OnboardingChrome,
} from "./OnboardingChrome";
import { OnboardingFooter, OnboardingFooterProvider } from "./OnboardingFooter";
import { OnboardingSlideTransition } from "./OnboardingSlideTransition";
import { SetupStepPreview } from "./SetupStepPreview";

type PreviewPage =
  | "landing"
  | "email"
  | "identity-key"
  | "sign-in"
  | "sign-in-key"
  | "forgot-password"
  | "setup";

const EMAIL_SIGNUP_POLICY: JoinPolicy = {
  ageAttestationRequired: true,
  privacyMarkdown: "available",
  termsMarkdown: "available",
  version: "email-signup-workshop",
};

function PreviewBanner({ onRestart }: { onRestart: () => void }) {
  return (
    <aside
      className="fixed right-4 top-4 z-[100] flex max-w-sm items-center gap-3 rounded-2xl border border-foreground/15 bg-background/95 px-4 py-3 text-left shadow-lg backdrop-blur"
      data-testid="onboarding-preview-banner"
    >
      <ShieldCheck className="h-5 w-5 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">Workshop preview</p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          Changes in this workshop aren’t saved.
        </p>
      </div>
      <Button
        aria-label="Restart onboarding preview"
        className="h-8 w-8 shrink-0"
        data-testid="onboarding-preview-restart"
        onClick={onRestart}
        size="icon"
        type="button"
        variant="ghost"
      >
        <RotateCcw className="h-4 w-4" aria-hidden />
      </Button>
    </aside>
  );
}

function Landing({ onNavigate }: { onNavigate: (page: PreviewPage) => void }) {
  return (
    <div
      className="buzz-onboarding-neutral-theme buzz-startup-shell buzz-onboarding-welcome flex max-h-dvh items-start justify-center overflow-hidden px-4 py-8 text-foreground"
      data-testid="onboarding-preview-landing"
    >
      <StartupWindowDragRegion />
      <LandingBees />
      <OnboardingFooterProvider>
        <div className="relative my-auto flex w-full max-w-[720px] flex-col items-center text-center">
          <OnboardingSlideTransition
            className="flex w-full max-w-[720px] flex-col items-center text-center"
            transitionKey="preview-landing"
          >
            <img
              alt="Buzz"
              className="w-full max-w-[600px]"
              src="/landing/buzz-wordmark.png"
            />
            <p className="mt-2 max-w-[560px] text-center text-2xl font-normal leading-none text-foreground">
              Your people, your agents, your projects —<br />
              all in one place.
            </p>
            <div className="mt-10 flex flex-col items-center gap-3">
              <Button
                className={ONBOARDING_LANDING_CTA_CLASS}
                onClick={() => onNavigate("email")}
                type="button"
              >
                Create an account
              </Button>
              <Button
                className={`${ONBOARDING_SECONDARY_CTA_CLASS} px-5`}
                onClick={() => onNavigate("sign-in")}
                type="button"
                variant="ghost"
              >
                Sign in
              </Button>
            </div>
            <OnboardingFooter className="max-w-none">
              <Button
                className="text-foreground/70 hover:text-foreground"
                data-testid="onboarding-preview-without-email"
                onClick={() => onNavigate("identity-key")}
                type="button"
                variant="link"
              >
                Sign up without email
              </Button>
            </OnboardingFooter>
          </OnboardingSlideTransition>
        </div>
      </OnboardingFooterProvider>
    </div>
  );
}

function PreviewStep({
  children,
  current = 2,
  onBack,
  testId,
}: {
  children: React.ReactNode;
  current?: number;
  onBack: () => void;
  testId: string;
}) {
  return (
    <div
      className="buzz-onboarding-neutral-theme buzz-startup-shell flex max-h-dvh items-start justify-center overflow-x-hidden overflow-y-auto px-4 pb-28 pt-[106px] text-foreground"
      data-testid={testId}
    >
      <StartupWindowDragRegion />
      <OnboardingChrome current={current} />
      <OnboardingFooterProvider backAction={{ onClick: onBack }}>
        <div className="buzz-onboarding-step-frame relative flex w-full max-w-[1040px] flex-col items-center text-center">
          {children}
        </div>
      </OnboardingFooterProvider>
    </div>
  );
}

type PreviewPasswordStrength = "empty" | "weak" | "moderate" | "strong";

const strengthLabelPhraseVariants = {
  animate: { transition: { staggerChildren: 0.008 } },
  exit: { transition: { staggerChildren: 0.005 } },
  initial: {},
};

const strengthLabelCharacterVariants = {
  animate: {
    filter: "blur(0)",
    opacity: 1,
    transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] as const },
    y: 0,
  },
  exit: {
    filter: "blur(0.25rem)",
    opacity: 0,
    transition: { duration: 0.16, ease: [0.64, 0, 0.78, 0] as const },
    y: "-0.5rem",
  },
  initial: { filter: "blur(0.25rem)", opacity: 0, y: "0.5rem" },
};

function previewPasswordStrength(password: string): PreviewPasswordStrength {
  if (password.length === 0) return "empty";
  if (password.length < 8) return "weak";
  if (password.length < 15) return "moderate";
  return "strong";
}

function PasswordStrengthMeter({
  descriptionId,
  password,
}: {
  descriptionId: string;
  password: string;
}) {
  const strength = previewPasswordStrength(password);
  const reduceMotion = useReducedMotion() ?? false;
  const activeCount =
    strength === "strong"
      ? 3
      : strength === "moderate"
        ? 2
        : strength === "weak"
          ? 1
          : 0;
  const label =
    strength === "empty"
      ? "Empty"
      : strength === "weak"
        ? "Weak"
        : strength === "moderate"
          ? "Moderate"
          : "Strong";
  const labelCharacters = React.useMemo(() => {
    const occurrences = new Map<string, number>();
    return [...label].map((character) => {
      const occurrence = occurrences.get(character) ?? 0;
      occurrences.set(character, occurrence + 1);
      return { character, key: `${character}-${occurrence}` };
    });
  }, [label]);

  return (
    <div
      className={cn(
        "pointer-events-none absolute right-4 top-1/2 flex -translate-y-1/2 items-center gap-2 text-xs font-semibold transition-colors duration-150 motion-reduce:transition-none",
        strength === "weak" && "text-red-700",
        strength === "moderate" && "text-amber-700",
        strength === "strong" && "text-green-700",
        strength === "empty" && "text-transparent",
      )}
      data-strength={strength}
      data-testid="onboarding-preview-password-strength"
    >
      <span className="relative flex h-5 w-[4.75rem] items-center justify-end overflow-visible text-right leading-none">
        {reduceMotion ? (
          <span>{strength === "empty" ? "" : label}</span>
        ) : (
          <AnimatePresence initial={false} mode="wait">
            {strength === "empty" ? null : (
              <motion.span
                animate="animate"
                className="absolute inset-x-0 top-1/2 -translate-y-1/2 whitespace-nowrap"
                exit="exit"
                initial="initial"
                key={label}
                variants={strengthLabelPhraseVariants}
              >
                {labelCharacters.map(({ character, key }) => (
                  <motion.span
                    className="inline-block will-change-[transform,opacity,filter]"
                    key={`${label}-${key}`}
                    variants={strengthLabelCharacterVariants}
                  >
                    {character}
                  </motion.span>
                ))}
              </motion.span>
            )}
          </AnimatePresence>
        )}
      </span>
      <span
        aria-hidden
        className={cn(
          "relative flex h-8 w-5 flex-col items-center justify-center gap-0.5",
          strength === "empty" && "opacity-0",
        )}
        data-testid="onboarding-preview-password-strength-indicator"
      >
        {[3, 2, 1].map((level) => {
          const isTopDot = level === 3;
          const positionClass =
            level === 3
              ? strength === "strong"
                ? "top-1/2 -translate-y-1/2"
                : "top-1"
              : level === 2
                ? "top-[13px]"
                : "top-[22px]";
          return (
            <span
              className={cn(
                "absolute left-1/2 flex -translate-x-1/2 items-center justify-center overflow-hidden transition-[top,width,height,border-radius,background-color,opacity,transform] duration-150 ease-in-out motion-reduce:transition-none",
                positionClass,
                isTopDot && strength === "strong"
                  ? "h-5 w-5 rounded-full bg-green-600"
                  : "h-1.5 w-1.5 rounded-full",
                !isTopDot && strength === "strong"
                  ? level === 2
                    ? "translate-y-1 scale-0 opacity-0"
                    : "-translate-y-1.5 scale-0 opacity-0"
                  : "scale-100 opacity-100",
                strength !== "strong" &&
                  strength !== "empty" &&
                  activeCount >= level &&
                  "bg-amber-500",
                strength === "weak" && activeCount >= level && "bg-red-500",
                strength !== "strong" &&
                  activeCount < level &&
                  "bg-foreground/20",
              )}
              data-level={level}
              key={level}
            >
              {isTopDot ? (
                <Check
                  className={cn(
                    "h-3.5 w-3.5 text-white transition-[opacity,transform] duration-120 ease-in-out motion-reduce:transition-none",
                    strength === "strong"
                      ? "scale-100 opacity-100"
                      : "scale-75 opacity-0",
                  )}
                  data-testid="onboarding-preview-password-strength-check"
                />
              ) : null}
            </span>
          );
        })}
      </span>
      <span
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        id={descriptionId}
        role="status"
      >
        Password strength: {label}
      </span>
    </div>
  );
}

function PreviewCredentialsFields({
  email,
  emailId,
  onEmailChange,
  onPasswordChange,
  onConfirmPasswordChange,
  confirmPassword,
  password,
  passwordAutoComplete,
  passwordHelp,
  passwordId,
  passwordPlaceholder,
  showPasswordStrength = false,
}: {
  email: string;
  emailId: string;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange?: (value: string) => void;
  confirmPassword?: string;
  password: string;
  passwordAutoComplete: "current-password" | "new-password";
  passwordHelp?: React.ReactNode;
  passwordId: string;
  passwordPlaceholder: string;
  showPasswordStrength?: boolean;
}) {
  const passwordStrengthDescriptionId = React.useId();

  return (
    <>
      <div>
        <label
          className="mb-2 block text-sm font-medium text-foreground"
          htmlFor={emailId}
        >
          Email
        </label>
        <Input
          autoComplete="email"
          className="h-12 rounded-2xl border-foreground/15 bg-white px-4"
          id={emailId}
          onChange={(event) => onEmailChange(event.target.value)}
          placeholder="Enter your email address"
          type="email"
          value={email}
        />
      </div>
      <div>
        <label
          className="mb-2 block text-sm font-medium text-foreground"
          htmlFor={passwordId}
        >
          Password
        </label>
        <div className="relative">
          <Input
            aria-describedby={
              showPasswordStrength ? passwordStrengthDescriptionId : undefined
            }
            autoComplete={passwordAutoComplete}
            className={cn(
              "h-12 rounded-2xl border-foreground/15 bg-white px-4",
              showPasswordStrength ? "pr-28" : "pr-4",
            )}
            id={passwordId}
            onChange={(event) => onPasswordChange(event.target.value)}
            placeholder={passwordPlaceholder}
            type="password"
            value={password}
          />
          {showPasswordStrength ? (
            <PasswordStrengthMeter
              descriptionId={passwordStrengthDescriptionId}
              password={password}
            />
          ) : null}
        </div>
        {passwordHelp ? (
          <div className="mt-2 text-left">{passwordHelp}</div>
        ) : null}
        {onConfirmPasswordChange ? (
          <div className="mt-5">
            <label
              className="mb-2 block text-sm font-medium text-foreground"
              htmlFor={`${passwordId}-confirmation`}
            >
              Confirm password
            </label>
            <Input
              autoComplete="new-password"
              className="h-12 rounded-2xl border-foreground/15 bg-white px-4"
              id={`${passwordId}-confirmation`}
              onChange={(event) => onConfirmPasswordChange(event.target.value)}
              placeholder="Confirm your password"
              type="password"
              value={confirmPassword ?? ""}
            />
          </div>
        ) : null}
      </div>
    </>
  );
}

function EmailSignup({
  password,
  onBack,
  onContinue,
  onPasswordChange,
}: {
  password: string;
  onBack: () => void;
  onContinue: (email: string) => void;
  onPasswordChange: (password: string) => void;
}) {
  const [email, setEmail] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [ageConfirmed, setAgeConfirmed] = React.useState(false);
  const [agreementConfirmed, setAgreementConfirmed] = React.useState(false);
  // This workshop never creates an account, so it deliberately permits the
  // next preview step without collecting real credentials or consent.
  const canContinue = true;

  return (
    <PreviewStep onBack={onBack} testId="onboarding-preview-email">
      <OnboardingSlideTransition
        className="flex min-h-0 w-full max-w-[500px] flex-col items-center"
        transitionKey="preview-email"
      >
        <h1 className="text-title font-normal text-foreground">
          Create an account
        </h1>
        <p className="mt-5 max-w-[440px] text-sm leading-6 text-foreground/80">
          Enter your email address to get started.
        </p>
        <form
          className="mt-8 w-full space-y-5 text-left"
          onSubmit={(event) => {
            event.preventDefault();
            if (canContinue) onContinue(email);
          }}
        >
          <PreviewCredentialsFields
            email={email}
            emailId="onboarding-preview-email-address"
            onEmailChange={setEmail}
            onPasswordChange={onPasswordChange}
            confirmPassword={confirmPassword}
            onConfirmPasswordChange={setConfirmPassword}
            password={password}
            passwordAutoComplete="new-password"
            passwordId="onboarding-preview-password"
            passwordPlaceholder="Choose your password"
            showPasswordStrength
          />
          <JoinPolicyNotice
            ageConfirmed={ageConfirmed}
            agreementConfirmed={agreementConfirmed}
            onAgeConfirmedChange={setAgeConfirmed}
            onAgreementConfirmedChange={setAgreementConfirmed}
            onOpenDocument={() => undefined}
            policy={EMAIL_SIGNUP_POLICY}
            relayWsUrl="wss://preview.invalid"
            textTone="foreground"
          />
          <OnboardingFooter>
            <Button
              className={ONBOARDING_PRIMARY_CTA_CLASS}
              data-testid="onboarding-preview-email-continue"
              disabled={!canContinue}
              onClick={() => onContinue(email)}
              type="button"
            >
              Continue
            </Button>
          </OnboardingFooter>
        </form>
      </OnboardingSlideTransition>
    </PreviewStep>
  );
}

function AgentHarnessStep({
  onBack,
  onNext,
}: {
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <PreviewStep current={3} onBack={onBack} testId="onboarding-preview-setup">
      <SetupStepPreview onBack={onBack} onNext={onNext} />
    </PreviewStep>
  );
}

function EmailSignIn({
  email,
  onBack,
  onContinue,
  onEmailChange,
  onForgotPassword,
  onSignInWithKey,
}: {
  email: string;
  onBack: () => void;
  onContinue: () => void;
  onEmailChange: (email: string) => void;
  onForgotPassword: () => void;
  onSignInWithKey: () => void;
}) {
  const [password, setPassword] = React.useState("");
  const canContinue = email.trim().length > 0 && password.length > 0;

  return (
    <PreviewStep onBack={onBack} testId="onboarding-preview-sign-in">
      <OnboardingSlideTransition
        className="flex min-h-0 w-full max-w-[500px] flex-col items-center"
        transitionKey="preview-sign-in"
      >
        <h1 className="text-title font-normal text-foreground">Sign in</h1>
        <p className="mt-5 max-w-[440px] text-sm leading-6 text-foreground/80">
          Enter your email address and password to sign in.
        </p>
        <form
          className="mt-8 w-full space-y-5 text-left"
          onSubmit={(event) => {
            event.preventDefault();
            if (canContinue) onContinue();
          }}
        >
          <PreviewCredentialsFields
            email={email}
            emailId="onboarding-preview-sign-in-email"
            onEmailChange={onEmailChange}
            onPasswordChange={setPassword}
            password={password}
            passwordAutoComplete="current-password"
            passwordHelp={
              <Button
                className="h-auto justify-start p-0 text-xs font-medium text-foreground/70 no-underline hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline"
                onClick={onForgotPassword}
                type="button"
                variant="link"
              >
                Forgot password?
              </Button>
            }
            passwordId="onboarding-preview-sign-in-password"
            passwordPlaceholder="Enter your password"
          />
          <div className="flex w-full flex-col items-center gap-3 pt-1">
            <Button
              className={ONBOARDING_PRIMARY_CTA_CLASS}
              data-testid="onboarding-preview-sign-in-submit"
              disabled={!canContinue}
              onClick={onContinue}
              type="button"
            >
              Sign in
            </Button>
            <div
              aria-hidden
              className="flex w-full max-w-64 items-center gap-3 text-xs text-foreground/70"
            >
              <span className="h-px flex-1 bg-foreground/20" />
              <span>or</span>
              <span className="h-px flex-1 bg-foreground/20" />
            </div>
            <Button
              className={ONBOARDING_SECONDARY_CTA_CLASS}
              onClick={onSignInWithKey}
              type="button"
              variant="ghost"
            >
              Sign in with a key
            </Button>
          </div>
        </form>
      </OnboardingSlideTransition>
    </PreviewStep>
  );
}

function PasswordReset({
  initialEmail,
  onBack,
}: {
  initialEmail: string;
  onBack: () => void;
}) {
  const [email, setEmail] = React.useState(initialEmail);
  const [submitted, setSubmitted] = React.useState(false);

  if (submitted) {
    return (
      <PreviewStep
        onBack={onBack}
        testId="onboarding-preview-password-reset-sent"
      >
        <OnboardingSlideTransition
          className="flex min-h-0 w-full max-w-[500px] flex-col items-center"
          transitionKey="preview-password-reset-sent"
        >
          <h1 className="text-title font-normal text-foreground">
            Check your email
          </h1>
          <p className="mt-5 max-w-[440px] text-sm leading-6 text-foreground/80">
            Use the link we sent to {email.trim()} to reset your password.
          </p>
        </OnboardingSlideTransition>
      </PreviewStep>
    );
  }

  return (
    <PreviewStep onBack={onBack} testId="onboarding-preview-password-reset">
      <OnboardingSlideTransition
        className="flex min-h-0 w-full max-w-[500px] flex-col items-center"
        transitionKey="preview-password-reset"
      >
        <h1 className="text-title font-normal text-foreground">
          Reset your password
        </h1>
        <p className="mt-5 max-w-[440px] text-sm leading-6 text-foreground/80">
          Enter your email address and we'll send you a link to reset your
          password.
        </p>
        <form
          className="mt-8 w-full text-left"
          onSubmit={(event) => {
            event.preventDefault();
            if (email.trim()) setSubmitted(true);
          }}
        >
          <label
            className="mb-2 block text-sm font-medium text-foreground"
            htmlFor="onboarding-preview-password-reset-email"
          >
            Email
          </label>
          <Input
            autoComplete="email"
            className="h-12 rounded-2xl border-foreground/15 bg-white px-4"
            id="onboarding-preview-password-reset-email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Enter your email address"
            type="email"
            value={email}
          />
          <OnboardingFooter>
            <Button
              className={ONBOARDING_PRIMARY_CTA_CLASS}
              disabled={!email.trim()}
              onClick={() => setSubmitted(true)}
              type="button"
            >
              Send reset link
            </Button>
          </OnboardingFooter>
        </form>
      </OnboardingSlideTransition>
    </PreviewStep>
  );
}

function KeySignIn({
  onBack,
  onContinue,
}: {
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <PreviewStep onBack={onBack} testId="onboarding-preview-sign-in-key">
      <OnboardingSlideTransition
        className="flex min-h-[calc(100dvh-13.25rem)] w-full max-w-[560px] flex-col items-center justify-center"
        transitionKey="preview-sign-in-key"
      >
        <h1 className="text-title font-normal text-foreground">
          Enter your private key
        </h1>
        <p className="mt-5 max-w-[440px] text-sm leading-6 text-foreground/80">
          Paste your private key to sign in to Buzz. You can also use a backup
          file, or recover from your phone.
        </p>
        <div className="buzz-onboarding-key-import-position w-full">
          <NostrKeyImportForm
            onBack={onBack}
            onImport={async () => onContinue()}
            previewMode
            showBack={false}
            variant="spotlight"
          />
        </div>
      </OnboardingSlideTransition>
    </PreviewStep>
  );
}

export function OnboardingPreviewApp() {
  const [run, setRun] = React.useState(0);
  const [page, setPage] = React.useState<PreviewPage>("landing");
  const [signInEmail, setSignInEmail] = React.useState("");
  const [signupPassword, setSignupPassword] = React.useState("");
  const [passwordResetEmail, setPasswordResetEmail] = React.useState("");
  const [setupBackPage, setSetupBackPage] =
    React.useState<PreviewPage>("landing");

  React.useEffect(() => {
    if (page === "landing") {
      setPasswordResetEmail("");
      setSignInEmail("");
      setSignupPassword("");
    }
  }, [page]);

  const restart = React.useCallback(() => {
    setPage("landing");
    setPasswordResetEmail("");
    setRun((current) => current + 1);
    setSignInEmail("");
    setSignupPassword("");
  }, []);

  let content: React.ReactNode;
  if (page === "landing") {
    content = <Landing key={run} onNavigate={setPage} />;
  } else if (page === "email") {
    content = (
      <EmailSignup
        password={signupPassword}
        onBack={() => setPage("landing")}
        onContinue={() => {
          setSetupBackPage("email");
          setPage("setup");
        }}
        onPasswordChange={setSignupPassword}
      />
    );
  } else if (page === "identity-key") {
    content = (
      <PreviewStep
        onBack={() => setPage("landing")}
        testId="onboarding-preview-identity-key"
      >
        <BackupStep
          direction="forward"
          onNext={() => {
            setSetupBackPage("identity-key");
            setPage("setup");
          }}
          onOpenPasswordBackup={() => undefined}
          onShowOptions={() => undefined}
          optionsExpanded={false}
          previewMode
          returningFromSecurity={false}
        />
      </PreviewStep>
    );
  } else if (page === "sign-in") {
    content = (
      <EmailSignIn
        email={signInEmail}
        onBack={() => setPage("landing")}
        onContinue={() => {
          setSetupBackPage("sign-in");
          setPage("setup");
        }}
        onEmailChange={setSignInEmail}
        onForgotPassword={() => {
          setPasswordResetEmail(signInEmail);
          setPage("forgot-password");
        }}
        onSignInWithKey={() => setPage("sign-in-key")}
      />
    );
  } else if (page === "forgot-password") {
    content = (
      <PasswordReset
        initialEmail={passwordResetEmail}
        onBack={() => setPage("sign-in")}
      />
    );
  } else if (page === "sign-in-key") {
    content = (
      <KeySignIn
        onBack={() => setPage("sign-in")}
        onContinue={() => {
          setSetupBackPage("sign-in-key");
          setPage("setup");
        }}
      />
    );
  } else {
    content = (
      <AgentHarnessStep
        onBack={() => setPage(setupBackPage)}
        onNext={() => undefined}
      />
    );
  }

  return (
    <>
      <PreviewBanner onRestart={restart} />
      {content}
    </>
  );
}
