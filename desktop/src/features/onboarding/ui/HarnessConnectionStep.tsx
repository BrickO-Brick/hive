import { ChevronRight } from "lucide-react";
import * as React from "react";

import { AgentDropdownSelect } from "@/features/agents/ui/agentConfigControls";
import {
  getProviderApiKeyLabel,
  getPersonaModelOptions,
  PERSONA_LLM_PROVIDER_OPTIONS,
  runtimeSupportsLlmProviderSelection,
} from "@/features/agents/ui/agentConfigOptions";
import {
  BUZZ_AGENT_THINKING_EFFORT_VALUES,
  getProviderEffortConfig,
} from "@/features/agents/ui/buzzAgentConfig";
import type { AcpRuntimeCatalogEntry } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { SegmentedControl } from "@/shared/ui/segmented-control";
import { ONBOARDING_PRIMARY_CTA_CLASS } from "./OnboardingChrome";
import { OnboardingFooter } from "./OnboardingFooter";
import { OnboardingPreviewInput } from "./OnboardingPreviewInput";
import {
  OnboardingPreviewStep,
  useOnboardingPreviewCardLayout,
} from "./OnboardingPreviewShell";
import { OnboardingSlideTransition } from "./OnboardingSlideTransition";
import { getRuntimeDisplayLabel, RuntimeIcon } from "./RuntimeIcon";
import { ONBOARDING_PREVIEW_CARD_INPUT_CLASS } from "./onboardingPreviewCardStyles";

export type HarnessConnectionMethod = "subscription" | "api";

export type HarnessConnectionOption = {
  methods: readonly HarnessConnectionMethod[];
  runtime: AcpRuntimeCatalogEntry;
};

const CONNECTION_METHOD_OPTIONS = [
  { label: "Subscription", value: "subscription" },
  { label: "API", value: "api" },
] as const;

function previewRuntime({
  available = false,
  id,
  label,
  source = "preset",
}: {
  available?: boolean;
  id: string;
  label: string;
  source?: AcpRuntimeCatalogEntry["source"];
}): AcpRuntimeCatalogEntry {
  return {
    authStatus: available
      ? { status: "not_applicable" }
      : { status: "unknown" },
    availability: available ? "available" : "not_installed",
    avatarUrl: "",
    binaryPath: available ? `/usr/local/bin/${id}` : null,
    canAutoInstall: true,
    command: available ? id : null,
    contextLimitEnvVar: null,
    defaultArgs: [],
    id,
    installHint: `Install ${label} to connect it to Buzz.`,
    installInstructionsUrl: "https://github.com/block/buzz",
    label,
    loginHint: null,
    maxRoundsEnvVar: null,
    maxTokensEnvVar: null,
    mcpCommand: null,
    modelEnvVar: null,
    nodeRequired: false,
    providerEnvVar: null,
    requiresExternalCli: id !== "buzz-agent",
    source,
    thinkingEnvVar: null,
    underlyingCliPath: null,
  };
}

/** Fixed workshop catalog. Availability changes only in React memory. */
export const HARNESS_CONNECTION_OPTIONS: readonly HarnessConnectionOption[] = [
  {
    methods: ["subscription", "api"],
    runtime: previewRuntime({
      available: true,
      id: "claude",
      label: "Claude Code",
      source: "builtin",
    }),
  },
  {
    methods: ["subscription", "api"],
    runtime: previewRuntime({ id: "codex", label: "Codex", source: "builtin" }),
  },
  {
    methods: ["api"],
    runtime: previewRuntime({
      available: true,
      id: "goose",
      label: "Goose",
      source: "builtin",
    }),
  },
  {
    methods: ["api"],
    runtime: previewRuntime({
      available: true,
      id: "buzz-agent",
      label: "Buzz Agent",
      source: "builtin",
    }),
  },
  {
    methods: ["subscription"],
    runtime: previewRuntime({ id: "cursor", label: "Cursor" }),
  },
  {
    methods: ["subscription"],
    runtime: previewRuntime({ id: "devin", label: "Devin" }),
  },
  {
    methods: ["api"],
    runtime: previewRuntime({ id: "omp", label: "Oh My Pi" }),
  },
  {
    methods: ["api"],
    runtime: previewRuntime({ id: "grok", label: "Grok Build" }),
  },
  {
    methods: ["api"],
    runtime: previewRuntime({ id: "opencode", label: "OpenCode" }),
  },
  {
    methods: ["api"],
    runtime: previewRuntime({ id: "kimi", label: "Kimi Code" }),
  },
  {
    methods: ["subscription"],
    runtime: previewRuntime({ id: "amp", label: "Amp" }),
  },
  {
    methods: ["api"],
    runtime: previewRuntime({ id: "hermes", label: "Hermes Agent" }),
  },
  {
    methods: ["api"],
    runtime: previewRuntime({ id: "openclaw", label: "OpenClaw" }),
  },
];

/**
 * Reusable row list for selecting or installing an AI client. The caller owns
 * availability and side effects so onboarding can remain a session-only
 * workshop while an in-app surface can wire the same presentation to Tauri.
 */
export function HarnessConnectionList({
  installedIds,
  onInstall,
  onSelect,
  options,
}: {
  installedIds: ReadonlySet<string>;
  onInstall: (option: HarnessConnectionOption) => void;
  onSelect: (option: HarnessConnectionOption) => void;
  options: readonly HarnessConnectionOption[];
}) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [canScrollUp, setCanScrollUp] = React.useState(false);
  const [canScrollDown, setCanScrollDown] = React.useState(false);
  const orderedOptions = React.useMemo(() => {
    const group = ({ runtime }: HarnessConnectionOption) => {
      if (runtime.id === "buzz-agent") return 0;
      if (runtime.id === "goose") return 1;
      return installedIds.has(runtime.id) ? 2 : 3;
    };
    return [...options].sort((left, right) => group(left) - group(right));
  }, [installedIds, options]);
  const updateScrollEdges = React.useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    setCanScrollUp(element.scrollTop > 1);
    setCanScrollDown(
      element.scrollTop + element.clientHeight < element.scrollHeight - 1,
    );
  }, []);

  React.useEffect(() => {
    updateScrollEdges();
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(updateScrollEdges);
    observer.observe(element);
    return () => observer.disconnect();
  }, [updateScrollEdges]);

  return (
    <div className="relative -mx-2 min-h-0 w-[calc(100%+1rem)] flex-1">
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-10 h-4 transition-opacity duration-150 motion-reduce:transition-none",
          canScrollUp ? "opacity-100" : "opacity-0",
        )}
        style={{
          background: "linear-gradient(to bottom, white, rgb(255 255 255 / 0))",
        }}
      />
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-4 transition-opacity duration-150 motion-reduce:transition-none",
          canScrollDown ? "opacity-100" : "opacity-0",
        )}
        style={{
          background: "linear-gradient(to top, white, rgb(255 255 255 / 0))",
        }}
      />
      <div
        className="h-full min-h-0 space-y-1 overflow-y-auto overscroll-contain pr-1"
        data-testid="onboarding-preview-harness-list"
        onScroll={updateScrollEdges}
        ref={scrollRef}
      >
        {orderedOptions.map((option) => {
          const { runtime } = option;
          const installed = installedIds.has(runtime.id);
          const label = getRuntimeDisplayLabel(runtime);
          const rowClassName =
            "group flex min-h-14 w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-sm font-medium text-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.04] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-foreground/20 motion-reduce:transition-none";
          const contents = (
            <>
              <span className="flex size-10 shrink-0 items-center justify-center">
                <RuntimeIcon className="size-9" runtime={runtime} />
              </span>
              <span className="min-w-0 flex-1 truncate">{label}</span>
            </>
          );

          if (installed) {
            return (
              <button
                className={rowClassName}
                data-testid={`onboarding-preview-harness-${runtime.id}`}
                key={runtime.id}
                onClick={() => onSelect(option)}
                type="button"
              >
                {contents}
                <span className="flex size-10 shrink-0 items-center justify-center">
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 text-muted-foreground transition-[color,transform] duration-150 ease-out group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transition-none"
                  />
                </span>
              </button>
            );
          }

          return (
            <div className={rowClassName} key={runtime.id}>
              {contents}
              <Button
                aria-label={`Install ${label}`}
                className="ml-auto h-7 shrink-0 rounded-full bg-foreground px-3 text-xs text-background shadow-none hover:bg-foreground/85"
                data-testid={`onboarding-preview-harness-install-${runtime.id}`}
                onClick={() => onInstall(option)}
                size="xs"
                type="button"
              >
                Install
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function HarnessConnectionPreview({
  installedIds,
  onBack,
  onInstall,
  onSelect,
  total,
}: {
  installedIds: ReadonlySet<string>;
  onBack: () => void;
  onInstall: (option: HarnessConnectionOption) => void;
  onSelect: (option: HarnessConnectionOption) => void;
  total: number;
}) {
  return (
    <OnboardingPreviewStep
      current={3}
      onBack={onBack}
      testId="onboarding-preview-harness-connection"
      total={total}
    >
      <OnboardingSlideTransition
        className="flex min-h-0 flex-1 flex-col"
        containerClassName="min-h-0 flex-1"
        transitionKey="preview-harness-connection"
      >
        <div className="shrink-0">
          <h1 className="text-title font-normal text-foreground">
            Connect your AI client
          </h1>
          <p className="mt-2 text-base leading-6 text-foreground/80">
            Choose which AI client your agents will use. You can change this
            anytime.
          </p>
        </div>
        <div className="mt-6 flex min-h-0 flex-1 flex-col">
          <HarnessConnectionList
            installedIds={installedIds}
            onInstall={onInstall}
            onSelect={onSelect}
            options={HARNESS_CONNECTION_OPTIONS}
          />
        </div>
      </OnboardingSlideTransition>
    </OnboardingPreviewStep>
  );
}

const API_PROVIDER_OPTIONS = PERSONA_LLM_PROVIDER_OPTIONS.map((provider) => ({
  label: provider.label,
  value: provider.id,
}));

const SUBSCRIPTION_NAMES: Record<string, string> = {
  amp: "Amp subscription",
  claude: "Claude subscription",
  codex: "ChatGPT subscription",
  cursor: "Cursor subscription",
  devin: "Devin account",
};

function defaultApiProvider(runtimeId: string) {
  if (runtimeId === "codex") return "openai";
  return "anthropic";
}

function apiKeyLabel(provider: string) {
  return (
    getProviderApiKeyLabel(provider)?.replace("API Key", "API key") ?? "API key"
  );
}

const DEFAULT_MODEL_OPTION = { label: "Default model", value: "" } as const;

function modelOptions(runtimeId: string, provider: string) {
  const options = getPersonaModelOptions(runtimeId, provider).map((option) => ({
    label: option.label,
    value: option.id,
  }));
  return options.length > 0 ? options : [DEFAULT_MODEL_OPTION];
}

function ConnectedConfiguration({
  effort,
  model,
  onEffortChange,
  onModelChange,
  provider,
  runtimeId,
}: {
  effort: string;
  model: string;
  onEffortChange: (value: string) => void;
  onModelChange: (value: string) => void;
  provider: string;
  runtimeId: string;
}) {
  const models = modelOptions(runtimeId, provider);
  const effortConfig = getProviderEffortConfig(provider, model);
  const efforts = BUZZ_AGENT_THINKING_EFFORT_VALUES.filter((value) =>
    effortConfig.validValues.includes(value),
  ).map((value) => ({
    label: value === effortConfig.defaultValue ? `${value} (default)` : value,
    value,
  }));
  const availableEfforts =
    efforts.length > 0
      ? efforts
      : BUZZ_AGENT_THINKING_EFFORT_VALUES.map((value) => ({
          label: value,
          value,
        }));

  return (
    <div
      className="space-y-5"
      data-testid="onboarding-preview-harness-connected"
    >
      <div>
        <label
          className="mb-2 block text-sm font-medium text-foreground"
          htmlFor="onboarding-preview-harness-model"
        >
          Model
        </label>
        <AgentDropdownSelect
          className={ONBOARDING_PREVIEW_CARD_INPUT_CLASS}
          id="onboarding-preview-harness-model"
          onValueChange={onModelChange}
          options={models}
          testId="onboarding-preview-harness-model"
          value={model}
        />
      </div>
      <div>
        <label
          className="mb-2 block text-sm font-medium text-foreground"
          htmlFor="onboarding-preview-harness-effort"
        >
          Effort
        </label>
        <AgentDropdownSelect
          className={ONBOARDING_PREVIEW_CARD_INPUT_CLASS}
          id="onboarding-preview-harness-effort"
          onValueChange={onEffortChange}
          options={availableEfforts}
          testId="onboarding-preview-harness-effort"
          value={effort}
        />
      </div>
    </div>
  );
}

export function HarnessConnectionDetailPreview({
  method,
  onBack,
  onContinue,
  onMethodChange,
  option,
  total,
}: {
  method: HarnessConnectionMethod;
  onBack: () => void;
  onContinue: () => void;
  onMethodChange: (method: HarnessConnectionMethod) => void;
  option: HarnessConnectionOption;
  total: number;
}) {
  const cardLayout = useOnboardingPreviewCardLayout();
  const label = getRuntimeDisplayLabel(option.runtime);
  const hasMethodChoice = option.methods.length > 1;
  const [provider, setProvider] = React.useState(() =>
    defaultApiProvider(option.runtime.id),
  );
  const [apiKey, setApiKey] = React.useState("workshop-preview-key");
  const [connected, setConnected] = React.useState(false);
  const [model, setModel] = React.useState("");
  const [effort, setEffort] = React.useState("medium");
  const canChooseProvider = runtimeSupportsLlmProviderSelection(
    option.runtime.id,
  );
  const subscriptionName = SUBSCRIPTION_NAMES[option.runtime.id] ?? label;
  const requiresApiKey = getProviderApiKeyLabel(provider) !== null;
  const canConnect =
    method === "subscription" || !requiresApiKey || apiKey.trim().length > 0;

  React.useEffect(() => {
    if (!option.methods.includes(method)) {
      onMethodChange(option.methods[0] ?? "api");
    }
  }, [method, onMethodChange, option.methods]);

  function handleMethodChange(nextMethod: HarnessConnectionMethod) {
    setApiKey("workshop-preview-key");
    setConnected(false);
    setProvider(defaultApiProvider(option.runtime.id));
    setModel("");
    setEffort("medium");
    onMethodChange(nextMethod);
  }

  function handleProviderChange(nextProvider: string) {
    setProvider(nextProvider);
    setApiKey("workshop-preview-key");
    setConnected(false);
    setModel("");
    setEffort("medium");
  }

  function handlePrimaryAction() {
    if (connected) {
      onContinue();
      return;
    }
    if (canConnect) setConnected(true);
  }

  return (
    <OnboardingPreviewStep
      current={3}
      onBack={onBack}
      testId="onboarding-preview-harness-connection-detail"
      total={total}
    >
      <OnboardingSlideTransition
        className={cn(
          "flex min-h-0 w-full max-w-[500px] flex-1 flex-col",
          cardLayout ? "items-stretch" : "items-center",
        )}
        containerClassName="min-h-0 flex-1"
        transitionKey={`preview-harness-connection-${option.runtime.id}`}
      >
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center">
            <RuntimeIcon className="size-9" runtime={option.runtime} />
          </span>
          <h1 className="text-title font-normal text-foreground">
            Connect {label}
          </h1>
        </div>
        <p className="mt-2 max-w-[440px] text-base leading-6 text-foreground/80">
          {connected
            ? "Choose a model and effort level. You can change these anytime."
            : hasMethodChoice
              ? "Choose how you want to connect. You can change this anytime."
              : method === "subscription"
                ? `Sign in to connect ${label}. You can change this anytime.`
                : "Add your connection details. You can change this anytime."}
        </p>

        <div className="mt-8 flex min-h-0 flex-1 flex-col gap-6">
          {hasMethodChoice && !connected ? (
            <SegmentedControl
              appearance="onboarding-inline"
              className="w-fit self-start"
              legend={`Connection method for ${label}`}
              onValueChange={handleMethodChange}
              optionTestIdPrefix="onboarding-preview-harness-method"
              options={CONNECTION_METHOD_OPTIONS.filter((item) =>
                option.methods.includes(item.value),
              )}
              size="compact"
              testId="onboarding-preview-harness-methods"
              value={method}
            />
          ) : null}

          {connected ? (
            <ConnectedConfiguration
              effort={effort}
              model={model}
              onEffortChange={setEffort}
              onModelChange={setModel}
              provider={provider}
              runtimeId={option.runtime.id}
            />
          ) : method === "subscription" ? (
            <div
              className="flex items-center gap-3 rounded-xl bg-[#e2e2e2]/30 px-4 py-4"
              data-testid="onboarding-preview-harness-subscription"
            >
              <RuntimeIcon className="size-9" runtime={option.runtime} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  {subscriptionName}
                </p>
                <p className="mt-0.5 text-xs leading-5 text-foreground/70">
                  Buzz will open a sign-in window for {label}.
                </p>
              </div>
              <Button
                className="ml-auto h-7 shrink-0 rounded-full bg-foreground px-3 text-xs text-background shadow-none hover:bg-foreground/85"
                data-testid="onboarding-preview-harness-subscription-sign-in"
                onClick={() => setConnected(true)}
                size="xs"
                type="button"
              >
                Sign in
              </Button>
            </div>
          ) : (
            <form
              className="space-y-5"
              data-testid="onboarding-preview-harness-api-form"
              onSubmit={(event) => {
                event.preventDefault();
                handlePrimaryAction();
              }}
            >
              {canChooseProvider ? (
                <div>
                  <label
                    className="mb-2 block text-sm font-medium text-foreground"
                    htmlFor="onboarding-preview-harness-provider"
                  >
                    Provider
                  </label>
                  <AgentDropdownSelect
                    className={ONBOARDING_PREVIEW_CARD_INPUT_CLASS}
                    id="onboarding-preview-harness-provider"
                    onValueChange={handleProviderChange}
                    options={API_PROVIDER_OPTIONS}
                    testId="onboarding-preview-harness-provider"
                    value={provider}
                  />
                </div>
              ) : null}
              {requiresApiKey ? (
                <div>
                  <label
                    className="mb-2 block text-sm font-medium text-foreground"
                    htmlFor="onboarding-preview-harness-api-key"
                  >
                    {apiKeyLabel(provider)}
                  </label>
                  <OnboardingPreviewInput
                    autoComplete="off"
                    className={ONBOARDING_PREVIEW_CARD_INPUT_CLASS}
                    id="onboarding-preview-harness-api-key"
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      setConnected(false);
                    }}
                    placeholder="Paste API key"
                    smooth
                    type="password"
                    value={apiKey}
                  />
                </div>
              ) : null}
            </form>
          )}
        </div>

        {method === "api" || connected ? (
          <OnboardingFooter>
            <Button
              className={ONBOARDING_PRIMARY_CTA_CLASS}
              data-testid="onboarding-preview-harness-continue"
              disabled={!canConnect}
              onClick={handlePrimaryAction}
              type="button"
            >
              {connected ? "Continue" : "Connect"}
            </Button>
          </OnboardingFooter>
        ) : null}
      </OnboardingSlideTransition>
    </OnboardingPreviewStep>
  );
}
