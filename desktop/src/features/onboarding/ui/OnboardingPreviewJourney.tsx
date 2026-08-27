import { Check, Copy, Users } from "lucide-react";
import * as React from "react";

import { HostedCommunityOnboarding } from "@/features/communities/ui/HostedCommunityOnboarding";
import { pubkeyToNpub } from "@/shared/lib/nostrUtils";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
import { InviteRedeemForm } from "./InviteRedeemForm";
import { CommunityProfileStage } from "./CommunityProfileStage";
import {
  ONBOARDING_PRIMARY_CTA_CLASS,
  ONBOARDING_SECONDARY_CTA_CLASS,
} from "./OnboardingChrome";
import { OnboardingFooter } from "./OnboardingFooter";
import { OnboardingPreviewStep } from "./OnboardingPreviewShell";
import { OnboardingSlideTransition } from "./OnboardingSlideTransition";
import { WelcomeChannelAppPreview } from "./WelcomeChannelAppPreview";

const FIELD_CLASS =
  "h-12 rounded-2xl border-foreground/15 bg-white px-4 text-sm shadow-none";
const COMMUNITY_OPTION_CLASS =
  "w-full max-w-[320px] items-center px-6 py-4 text-center text-sm font-normal leading-6 text-foreground [--buzz-card-textured-min-height:88px] transition-[filter] duration-150 ease-out hover:brightness-[0.98] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-foreground/35";
const PREVIEW_PUBLIC_ID = pubkeyToNpub(
  "e5ebc6cdb579be112e336cc319b5989b4bb6af11786ea90dbe52b5f08d741b34",
);

function LabeledField({
  id,
  label,
  onChange,
  placeholder,
  type = "text",
  value,
}: {
  id: string;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  type?: "password" | "text" | "url";
  value: string;
}) {
  return (
    <label className="block w-full text-left" htmlFor={id}>
      <span className="mb-2 block pl-3 text-sm font-medium text-foreground">
        {label}
      </span>
      <Input
        autoComplete="off"
        className={FIELD_CLASS}
        id={id}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type={type}
        value={value}
      />
    </label>
  );
}

type BackupPhase = "password" | "saved" | "verify" | "verified";

export function BackupPasswordPreview({
  onBack,
  onDone,
}: {
  onBack: () => void;
  onDone: () => void;
}) {
  const [phase, setPhase] = React.useState<BackupPhase>("password");
  const [password, setPassword] = React.useState("");
  const [verificationPassword, setVerificationPassword] = React.useState("");
  const heading =
    phase === "verified"
      ? "Your backup is verified"
      : phase === "verify"
        ? "That’s your backup file"
        : phase === "saved"
          ? "Optionally, test your backup"
          : "Backup your key with a password";
  const description =
    phase === "verified"
      ? "Your file and password can restore your identity."
      : phase === "verify"
        ? "Now enter your password to prove you can unlock it."
        : phase === "saved"
          ? "Learn how your backup works. Choose the file you just saved and unlock it with your password."
          : "Keep the downloaded file private — you need both it and your password to restore your identity. Save the backup password somewhere safe; Buzz cannot reset it if lost.";

  return (
    <OnboardingPreviewStep
      onBack={phase === "password" ? onBack : () => setPhase("password")}
      security
      testId="onboarding-preview-backup-password"
    >
      <OnboardingSlideTransition
        className="flex min-h-0 w-full flex-col items-center"
        transitionKey={`preview-backup-${phase}`}
      >
        <div className="w-full max-w-[500px] shrink-0 text-center">
          <h1 className="text-title font-normal text-foreground">{heading}</h1>
          <p className="mt-5 text-sm leading-6 text-foreground/80">
            {description}
          </p>
        </div>
        <div className="flex w-full max-w-[560px] flex-1 items-center justify-center py-10">
          {phase === "password" ? (
            <div className="w-full space-y-5">
              <LabeledField
                id="preview-backup-password"
                label="Backup password"
                onChange={setPassword}
                placeholder="Create a backup password"
                type="password"
                value={password}
              />
              <Card className="px-5 py-4 text-left" variant="textured">
                <p className="text-sm font-medium">Buzz identity backup</p>
                <p className="mt-1 text-xs leading-5 text-foreground/65">
                  Protected with your backup password and ready to save.
                </p>
              </Card>
            </div>
          ) : phase === "saved" ? (
            <Card
              className="flex w-full items-center gap-4 px-6 py-5 text-left"
              variant="textured"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-green-600 text-white">
                <Check className="h-5 w-5" aria-hidden />
              </span>
              <span>
                <span className="block text-sm font-medium">
                  Buzz identity backup saved
                </span>
                <span className="mt-1 block text-xs text-foreground/65">
                  Keep the file and password somewhere safe.
                </span>
              </span>
            </Card>
          ) : phase === "verify" ? (
            <div className="w-full space-y-5">
              <Card className="px-5 py-4 text-left" variant="textured">
                <p className="text-sm font-medium">Buzz identity backup</p>
                <p className="mt-1 text-xs text-foreground/65">
                  Selected and ready to unlock.
                </p>
              </Card>
              <LabeledField
                id="preview-backup-verification-password"
                label="Backup password"
                onChange={setVerificationPassword}
                placeholder="Enter your backup password"
                type="password"
                value={verificationPassword}
              />
            </div>
          ) : (
            <span className="flex h-20 w-20 items-center justify-center rounded-full bg-green-600 text-white shadow-sm">
              <Check className="h-10 w-10" aria-hidden />
            </span>
          )}
        </div>
        <OnboardingFooter>
          {phase === "password" ? (
            <Button
              className={ONBOARDING_PRIMARY_CTA_CLASS}
              data-testid="preview-create-locked-backup"
              disabled={!password}
              onClick={() => setPhase("saved")}
            >
              Create locked backup
            </Button>
          ) : phase === "saved" ? (
            <>
              <Button
                className={ONBOARDING_PRIMARY_CTA_CLASS}
                data-testid="preview-test-backup"
                onClick={() => setPhase("verify")}
              >
                Test backup
              </Button>
              <Button
                className={ONBOARDING_SECONDARY_CTA_CLASS}
                onClick={onDone}
                variant="ghost"
              >
                Skip for now
              </Button>
            </>
          ) : phase === "verify" ? (
            <Button
              className={ONBOARDING_PRIMARY_CTA_CLASS}
              data-testid="preview-verify-backup"
              disabled={!verificationPassword}
              onClick={() => setPhase("verified")}
            >
              Verify backup
            </Button>
          ) : (
            <Button
              className={ONBOARDING_PRIMARY_CTA_CLASS}
              data-testid="preview-finish-backup"
              onClick={onDone}
            >
              Finish
            </Button>
          )}
        </OnboardingFooter>
      </OnboardingSlideTransition>
    </OnboardingPreviewStep>
  );
}

export function DefaultConfigPreview({
  onBack,
  onNext,
}: {
  onBack: () => void;
  onNext: () => void;
}) {
  const [harness, setHarness] = React.useState("buzz-agent");
  const [provider, setProvider] = React.useState("");
  const [model, setModel] = React.useState("");

  return (
    <OnboardingPreviewStep
      current={4}
      onBack={onBack}
      testId="onboarding-preview-config"
    >
      <OnboardingSlideTransition
        className="flex min-h-full w-full flex-col items-center"
        transitionKey="preview-default-config"
      >
        <div className="w-full max-w-[500px] text-center">
          <h1 className="text-title font-normal text-foreground">
            Configure your default model settings
          </h1>
          <p className="mx-auto mt-3 max-w-[440px] text-sm leading-5 text-foreground/80">
            This will be set as your default model configuration across Buzz.
            You can always change this in your Settings or give specific agents
            a different configuration.
          </p>
        </div>
        <div className="flex w-full flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[328px] space-y-5 text-left">
            <label
              className="block text-sm font-medium"
              htmlFor="preview-default-harness"
            >
              <span className="mb-2 block pl-3">Default harness</span>
              <select
                className={`${FIELD_CLASS} w-full`}
                id="preview-default-harness"
                onChange={(event) => setHarness(event.target.value)}
                value={harness}
              >
                <option value="buzz-agent">Buzz Agent</option>
                <option value="claude">Claude Code</option>
                <option value="codex">Codex</option>
                <option value="goose">Goose</option>
              </select>
            </label>
            <label
              className="block text-sm font-medium"
              htmlFor="preview-default-provider"
            >
              <span className="mb-2 block pl-3">Provider</span>
              <select
                className={`${FIELD_CLASS} w-full`}
                id="preview-default-provider"
                onChange={(event) => setProvider(event.target.value)}
                value={provider}
              >
                <option value="">Select a provider</option>
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="ollama">Ollama</option>
              </select>
            </label>
            <label
              className="block text-sm font-medium"
              htmlFor="preview-default-model"
            >
              <span className="mb-2 block pl-3">Model</span>
              <select
                className={`${FIELD_CLASS} w-full`}
                id="preview-default-model"
                onChange={(event) => setModel(event.target.value)}
                value={model}
              >
                <option value="">Select a model</option>
                <option value="default">Provider default</option>
              </select>
            </label>
          </div>
        </div>
        <OnboardingFooter>
          <Button
            className={ONBOARDING_PRIMARY_CTA_CLASS}
            data-testid="onboarding-preview-config-next"
            onClick={onNext}
          >
            Next
          </Button>
          <Button
            className="h-9 whitespace-nowrap rounded-full px-6 text-sm hover:bg-foreground/10"
            data-testid="onboarding-preview-config-skip"
            onClick={onNext}
            variant="ghost"
          >
            Skip for now
          </Button>
        </OnboardingFooter>
      </OnboardingSlideTransition>
    </OnboardingPreviewStep>
  );
}

export type CommunityPreviewRoute = "join" | "create" | "existing";

export function CommunityChoicePreview({
  current = 5,
  includeExistingCommunity = true,
  onBack,
  onChoose,
  total,
}: {
  current?: number;
  includeExistingCommunity?: boolean;
  onBack: () => void;
  onChoose: (route: CommunityPreviewRoute) => void;
  total?: number;
}) {
  const routes: ReadonlyArray<readonly [CommunityPreviewRoute, string]> = [
    ["join", "Join a community"],
    ["create", "Create a community"],
    ...(includeExistingCommunity
      ? ([["existing", "I already have a community"]] as const)
      : []),
  ];

  return (
    <OnboardingPreviewStep
      current={current}
      onBack={onBack}
      testId="onboarding-preview-community-choice"
      total={total}
    >
      <OnboardingSlideTransition
        className="flex min-h-full w-full flex-col items-center"
        transitionKey="preview-community-choice"
      >
        <div className="w-full max-w-[760px]">
          <h1 className="text-title font-normal">Join or create a community</h1>
          <p className="mt-3 text-sm leading-6 text-foreground/80">
            {includeExistingCommunity
              ? "Join with an invite, create your own community, or reconnect one you already have."
              : "Join with an invite or create your own community."}
          </p>
        </div>
        <div className="flex w-full flex-1 translate-y-16 flex-col items-center justify-center gap-20 py-8">
          {routes.map(([route, label]) => (
            <Card
              asChild
              className={COMMUNITY_OPTION_CLASS}
              key={route}
              variant="textured"
            >
              <button
                data-testid={`onboarding-preview-community-${route}`}
                onClick={() => onChoose(route)}
                type="button"
              >
                {label}
              </button>
            </Card>
          ))}
        </div>
      </OnboardingSlideTransition>
    </OnboardingPreviewStep>
  );
}

export function CommunityEntryPreview({
  current = 5,
  onBack,
  onContinue,
  route,
  total,
}: {
  current?: number;
  onBack: () => void;
  onContinue: (communityName: string) => void;
  route: Exclude<CommunityPreviewRoute, "create">;
  total?: number;
}) {
  const [copiedPublicId, setCopiedPublicId] = React.useState(false);
  const heading =
    route === "existing" ? "Reconnect to your community" : "Join a community";
  const continueToCommunity = () => onContinue("Block Community");

  return (
    <OnboardingPreviewStep
      current={current}
      onBack={onBack}
      testId="onboarding-preview-community-entry"
      total={total}
    >
      <OnboardingSlideTransition
        className="flex min-h-[calc(100dvh-15.625rem)] w-full flex-col items-center text-center"
        transitionKey={`preview-community-${route}`}
      >
        <div className="w-full max-w-[620px]">
          <h1 className="text-title font-normal">{heading}</h1>
          <p className="mt-3 text-sm leading-6 text-foreground/80">
            {route === "existing"
              ? "Enter the community URL or an invite link. Your role will be restored when you connect."
              : "Enter the invite link or community URL you received."}
          </p>
        </div>
        <div className="flex w-full flex-1 flex-col items-center justify-center gap-16">
          <InviteRedeemForm
            error={null}
            isRedeeming={false}
            onCancel={onBack}
            onConnect={continueToCommunity}
            onRedeem={continueToCommunity}
            placeholder="Invite link or community URL"
            previewMode
            variant="onboarding-spotlight"
          />
          {route === "join" ? (
            <div className="w-full max-w-[560px] text-left">
              <p className="text-sm font-medium text-foreground">
                Joining a private community?
              </p>
              <p className="mt-2 text-sm leading-6 text-foreground/75">
                Some communities need the owner to add you before you can join.
                Copy your public ID and send it to the community owner.
              </p>
              <div className="mt-4 flex items-center gap-3 rounded-xl border border-foreground/10 bg-background/35 px-4 py-3">
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/80">
                  {PREVIEW_PUBLIC_ID}
                </code>
                <Button
                  aria-label="Copy public ID"
                  className="h-9 shrink-0 rounded-full px-3"
                  onClick={() => {
                    setCopiedPublicId(true);
                    window.setTimeout(() => setCopiedPublicId(false), 1500);
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {copiedPublicId ? (
                    <Check className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Copy className="h-4 w-4" aria-hidden="true" />
                  )}
                  <span>{copiedPublicId ? "Copied" : "Copy"}</span>
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </OnboardingSlideTransition>
    </OnboardingPreviewStep>
  );
}

export function CommunityCreatePreview({
  current = 5,
  onBack,
  onContinue,
  total,
}: {
  current?: number;
  onBack: () => void;
  onContinue: (communityName: string) => void;
  total?: number;
}) {
  return (
    <OnboardingPreviewStep
      current={current}
      testId="onboarding-preview-community-entry"
      total={total}
    >
      <OnboardingSlideTransition
        className="flex min-h-full w-full flex-col items-center"
        transitionKey="preview-community-create"
      >
        <HostedCommunityOnboarding
          onBack={onBack}
          onPreviewContinue={onContinue}
          previewMode
        />
      </OnboardingSlideTransition>
    </OnboardingPreviewStep>
  );
}

export function CommunityConnectingPreview({
  communityName,
  onBack,
  onContinue,
}: {
  communityName: string;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <OnboardingPreviewStep
      current={5}
      onBack={onBack}
      testId="onboarding-preview-community-connecting"
    >
      <OnboardingSlideTransition
        className="flex min-h-full w-full max-w-[560px] flex-col items-center justify-center"
        transitionKey="preview-community-connecting"
      >
        <Users className="h-10 w-10" aria-hidden />
        <h1 className="mt-5 text-title font-normal">Joining {communityName}</h1>
        <p className="mt-3 text-sm text-foreground/80">Connecting securely…</p>
        <OnboardingFooter>
          <Button
            className={ONBOARDING_PRIMARY_CTA_CLASS}
            data-testid="onboarding-preview-connecting-continue"
            onClick={onContinue}
          >
            Continue
          </Button>
        </OnboardingFooter>
      </OnboardingSlideTransition>
    </OnboardingPreviewStep>
  );
}

export function CommunityProfilePreview({
  avatarUrl,
  current = 6,
  displayName,
  onAvatarUrlChange,
  onBack,
  onDisplayNameChange,
  onNext,
  total,
}: {
  avatarUrl: string;
  current?: number;
  displayName: string;
  onAvatarUrlChange: (value: string) => void;
  onBack: () => void;
  onDisplayNameChange: (value: string) => void;
  onNext: () => void;
  total?: number;
}) {
  const [isUploadingAvatar, setIsUploadingAvatar] = React.useState(false);

  return (
    <OnboardingPreviewStep
      current={current}
      onBack={onBack}
      testId="onboarding-preview-community-profile"
      total={total}
    >
      <OnboardingSlideTransition
        className="flex min-h-full w-full max-w-[500px] flex-col items-center"
        transitionKey="preview-community-profile"
      >
        <CommunityProfileStage
          avatarUrl={avatarUrl}
          displayName={displayName}
          isPending={false}
          isUploadingAvatar={isUploadingAvatar}
          onAvatarUrlChange={onAvatarUrlChange}
          onDisplayNameChange={onDisplayNameChange}
          onNext={onNext}
          onUploadingChange={setIsUploadingAvatar}
          previewMode
        />
      </OnboardingSlideTransition>
    </OnboardingPreviewStep>
  );
}

const STARTER_TEAM = ["Fizz", "Honey", "Pollen"] as const;

export function StarterTeamPreview({
  onBack,
  onNext,
}: {
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <OnboardingPreviewStep
      current={7}
      onBack={onBack}
      testId="onboarding-preview-starter-team"
    >
      <OnboardingSlideTransition
        className="flex min-h-full w-full max-w-[760px] flex-col items-center"
        transitionKey="preview-starter-team"
      >
        <h1 className="text-title font-normal">Meet your starter team</h1>
        <p className="mx-auto mt-3 max-w-[400px] text-sm leading-6 text-foreground/80">
          Buzz lets you bring multiple agents into the same workspace. Your team
          will help you get started using Buzz.
        </p>
        <div className="flex w-full flex-1 items-center justify-center py-10">
          <div className="flex flex-wrap justify-center gap-8">
            {STARTER_TEAM.map((name) => (
              <div className="flex w-40 flex-col items-center gap-3" key={name}>
                <img
                  alt={`${name} animated character`}
                  className="h-40 w-40 object-contain"
                  src={`/onboarding/starter-team/${name.toLowerCase()}.png`}
                />
                <span className="font-mono text-xs font-medium uppercase tracking-[0.15em]">
                  {name}
                </span>
              </div>
            ))}
          </div>
        </div>
        <OnboardingFooter>
          <Button
            className={ONBOARDING_PRIMARY_CTA_CLASS}
            data-testid="onboarding-preview-team-next"
            onClick={onNext}
          >
            Take me to Buzz
          </Button>
        </OnboardingFooter>
      </OnboardingSlideTransition>
    </OnboardingPreviewStep>
  );
}

export function WelcomeChannelPreview({
  communityName,
  onBack,
  onNext,
}: {
  communityName: string;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <OnboardingPreviewStep
      current={7}
      onBack={onBack}
      testId="onboarding-preview-welcome-channel"
    >
      <OnboardingSlideTransition
        className="flex min-h-full w-full max-w-[680px] flex-col items-center justify-center"
        transitionKey="preview-welcome-channel"
      >
        <h1 className="text-title font-normal">
          Your Welcome channel is ready
        </h1>
        <p className="mt-4 max-w-[480px] text-sm leading-6 text-foreground/80">
          This is your starting place in {communityName}. Your starter team can
          help you learn the space and decide what to do next.
        </p>
        <Card
          className="mt-10 w-full max-w-[520px] px-6 py-6 text-left"
          variant="textured"
        >
          <p className="text-lg font-medium"># Welcome</p>
          <p className="mt-2 text-sm leading-6 text-foreground/70">
            Meet your team, start a conversation, or explore your community.
          </p>
          <div className="mt-5 flex -space-x-2">
            {STARTER_TEAM.map((name) => (
              <span
                aria-label={name}
                className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-background bg-primary/15 text-xs font-semibold"
                key={name}
                role="img"
              >
                {name[0]}
              </span>
            ))}
          </div>
        </Card>
        <OnboardingFooter>
          <Button
            className={ONBOARDING_PRIMARY_CTA_CLASS}
            data-testid="onboarding-preview-welcome-open"
            onClick={onNext}
          >
            Open Welcome
          </Button>
        </OnboardingFooter>
      </OnboardingSlideTransition>
    </OnboardingPreviewStep>
  );
}

export function CommunityHomePreview({
  avatarUrl,
  communityName,
  displayName,
}: {
  avatarUrl: string;
  communityName: string;
  displayName: string;
}) {
  return (
    <WelcomeChannelAppPreview
      avatarUrl={avatarUrl}
      communityName={communityName}
      displayName={displayName}
    />
  );
}
