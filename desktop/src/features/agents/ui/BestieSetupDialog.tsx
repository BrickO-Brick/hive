import { ArrowLeft, Bot, Check, ChevronRight, Plus } from "lucide-react";
import * as React from "react";

import {
  BESTIE_CAPABILITIES,
  BESTIE_INCLUDED_BEHAVIORS,
  DEFAULT_BESTIE_CAPABILITIES,
  type BestieCapabilityState,
} from "@/features/agents/lib/bestieCapabilities";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import type { AcpRuntimeCatalogEntry, ManagedAgent } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ChooserDialogContent } from "@/shared/ui/chooser-dialog-content";
import { Dialog } from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Switch } from "@/shared/ui/switch";
import { Textarea } from "@/shared/ui/textarea";
import {
  buildPersonaRuntimeDropdownOptions,
  NO_RUNTIME_DROPDOWN_VALUE,
  PERSONA_FIELD_CONTROL_CLASS,
  PERSONA_FIELD_SHELL_CLASS,
} from "./agentConfigOptions";
import { AgentHarnessField } from "./AgentHarnessField";

export type BestieSetupSubmission = {
  additionalInstructions: string;
  agentName: string;
  agentPubkey: string | null;
  capabilities: BestieCapabilityState;
  personality: string;
  runtime: string;
  source: "existing" | "new";
};

type SetupStep = "source" | "existing" | "identity" | "capabilities" | "review";

type BestieSetupDialogProps = {
  agents: ManagedAgent[];
  /** Pre-fills the flow when managing an already-assigned bestie. */
  initial?: {
    additionalInstructions: string;
    agentPubkey: string;
    capabilities: BestieCapabilityState;
  } | null;
  isLoadingAgents: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (submission: BestieSetupSubmission) => Promise<void>;
  open: boolean;
  runtimes: AcpRuntimeCatalogEntry[];
  runtimesLoading: boolean;
};

/** Matches the shared persona-dialog field shell so both dialogs read alike. */
function FieldLabel({
  children,
  htmlFor,
}: {
  children: React.ReactNode;
  htmlFor: string;
}) {
  return (
    <label className="text-sm font-medium text-foreground" htmlFor={htmlFor}>
      {children}
    </label>
  );
}

function CapabilityRow({
  checked,
  description,
  enforcementNote,
  id,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  description: string;
  enforcementNote?: string;
  id: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-3.5">
      <div className="min-w-0">
        <label className="text-sm font-medium text-foreground" htmlFor={id}>
          {label}
        </label>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          {description}
        </p>
        {enforcementNote ? (
          <p className="mt-1 text-xs leading-5 text-muted-foreground/60">
            {enforcementNote}
          </p>
        ) : null}
      </div>
      <Switch checked={checked} id={id} onCheckedChange={onCheckedChange} />
    </div>
  );
}

export function BestieSetupDialog({
  agents,
  initial,
  isLoadingAgents,
  onOpenChange,
  onSubmit,
  open,
  runtimes,
  runtimesLoading,
}: BestieSetupDialogProps) {
  const isManaging = Boolean(initial);
  const [step, setStep] = React.useState<SetupStep>("source");
  const [source, setSource] = React.useState<"existing" | "new">("new");
  const [selectedPubkey, setSelectedPubkey] = React.useState<string | null>(
    null,
  );
  const [newName, setNewName] = React.useState("");
  const [personality, setPersonality] = React.useState("");
  const [runtime, setRuntime] = React.useState("");
  const [additionalInstructions, setAdditionalInstructions] =
    React.useState("");
  const [capabilities, setCapabilities] = React.useState<BestieCapabilityState>(
    DEFAULT_BESTIE_CAPABILITIES,
  );
  const [isSaving, setIsSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  // Seed once per open: managing starts from stored values, a fresh setup from
  // role defaults.
  const seededRef = React.useRef(false);
  if (open && !seededRef.current) {
    seededRef.current = true;
    if (initial) {
      setStep("capabilities");
      setSource("existing");
      setSelectedPubkey(initial.agentPubkey);
      setCapabilities(initial.capabilities);
      setAdditionalInstructions(initial.additionalInstructions);
    }
  }
  if (!open && seededRef.current) {
    seededRef.current = false;
  }

  const selectedAgent =
    agents.find((agent) => agent.pubkey === selectedPubkey) ?? null;
  const agentName =
    source === "existing" ? (selectedAgent?.name ?? "") : newName.trim();
  const displayName = agentName || "your bestie";

  const { blankRuntimeOptionLabel, runtimeDropdownOptions } =
    buildPersonaRuntimeDropdownOptions({
      isCreateMode: true,
      runtime,
      runtimes,
      runtimesLoading,
    });

  function reset() {
    setStep("source");
    setSource("new");
    setSelectedPubkey(null);
    setNewName("");
    setPersonality("");
    setRuntime("");
    setAdditionalInstructions("");
    setCapabilities(DEFAULT_BESTIE_CAPABILITIES);
    setIsSaving(false);
    setSaveError(null);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && isSaving) return;
    onOpenChange(nextOpen);
    if (!nextOpen) reset();
  }

  function setCapability(id: keyof BestieCapabilityState, value: boolean) {
    setCapabilities((current) => ({ ...current, [id]: value }));
  }

  /**
   * Selecting an existing agent carries its real identity into the flow: its
   * name and avatar are shown as already-decided, and its own instructions seed
   * the instructions field so the role is layered onto what it already does
   * rather than silently replacing it.
   */
  function selectExistingAgent(agent: ManagedAgent) {
    setSelectedPubkey(agent.pubkey);
    setAdditionalInstructions(agent.systemPrompt?.trim() ?? "");
  }

  function back() {
    if (step === "existing") setStep("source");
    else if (step === "identity") {
      setStep(source === "existing" ? "existing" : "source");
    } else if (step === "capabilities") setStep("identity");
    else if (step === "review") setStep("capabilities");
  }

  async function submit() {
    setIsSaving(true);
    setSaveError(null);
    try {
      await onSubmit({
        additionalInstructions,
        agentName,
        agentPubkey: source === "existing" ? selectedPubkey : null,
        capabilities,
        personality,
        runtime,
        source,
      });
      handleOpenChange(false);
    } catch (cause) {
      setSaveError(
        cause instanceof Error
          ? cause.message
          : "Couldn’t save this bestie. Try again.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  const title = {
    source: "Set up your bestie",
    existing: "Choose an agent",
    identity:
      source === "existing" ? `Set up ${displayName}` : "Create your bestie",
    capabilities: isManaging
      ? `What ${displayName} can do`
      : "What your bestie can do",
    review: agentName ? `${agentName} is ready` : "Review",
  }[step];

  const subtitle = {
    source:
      "Create a new agent for the role or give it to one you already use.",
    existing: "Its name, personality, and existing work stay the same.",
    identity:
      source === "existing"
        ? "It keeps everything it already has. You can add to it here."
        : "You can change any of this later.",
    capabilities:
      "Your bestie always keeps up with your work and explains itself. Choose what else it can do.",
    review: "One last look before you save.",
  }[step];

  const canContinue = {
    source: false,
    existing: Boolean(selectedAgent),
    // An existing agent already has a name; only the create path needs one.
    identity:
      source === "existing" ? Boolean(selectedAgent) : Boolean(newName.trim()),
    capabilities: true,
    review: true,
  }[step];

  function continueFrom() {
    if (step === "existing") setStep("identity");
    else if (step === "identity") setStep("capabilities");
    else if (step === "capabilities") setStep("review");
  }

  const footer = (
    <div className="flex w-full items-center justify-between gap-3">
      {step === "source" ? (
        <span />
      ) : (
        <Button
          disabled={isSaving}
          onClick={back}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ArrowLeft />
          Back
        </Button>
      )}

      {step === "source" ? null : step === "review" ? (
        <Button disabled={isSaving} onClick={() => void submit()}>
          {isSaving
            ? "Saving…"
            : isManaging
              ? "Save changes"
              : `Make ${agentName} your bestie`}
        </Button>
      ) : (
        <Button disabled={!canContinue} onClick={continueFrom}>
          Continue
        </Button>
      )}
    </div>
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <ChooserDialogContent
        className="max-w-2xl"
        data-testid="bestie-setup-dialog"
        footer={footer}
        headerSubtitle={subtitle}
        title={title}
      >
        {step === "source" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              className="group flex flex-col items-start rounded-xl border border-input bg-muted/40 p-5 text-left transition-colors hover:border-muted-foreground/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                setSource("new");
                setStep("identity");
              }}
              type="button"
            >
              <span className="flex size-9 items-center justify-center rounded-lg bg-primary/12 text-primary">
                <Plus className="size-4" />
              </span>
              <span className="mt-9 flex w-full items-end justify-between gap-3">
                <span>
                  <span className="block text-sm font-medium text-foreground">
                    Create a new agent
                  </span>
                  <span className="mt-1 block text-sm leading-5 text-muted-foreground">
                    Start fresh and name it yourself.
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
              </span>
            </button>
            <button
              className="group flex flex-col items-start rounded-xl border border-input bg-muted/40 p-5 text-left transition-colors hover:border-muted-foreground/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                setSource("existing");
                setStep("existing");
              }}
              data-testid="bestie-source-existing"
              type="button"
            >
              <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Bot className="size-4" />
              </span>
              <span className="mt-9 flex w-full items-end justify-between gap-3">
                <span>
                  <span className="block text-sm font-medium text-foreground">
                    Use an agent you have
                  </span>
                  <span className="mt-1 block text-sm leading-5 text-muted-foreground">
                    Add the role without changing its identity.
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
              </span>
            </button>
          </div>
        ) : null}

        {step === "existing" ? (
          isLoadingAgents ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Loading your agents…
            </p>
          ) : agents.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              You don’t have an agent to use yet.
            </p>
          ) : (
            <div className="space-y-1">
              {agents.map((agent) => (
                <button
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  key={agent.pubkey}
                  onClick={() => selectExistingAgent(agent)}
                  type="button"
                >
                  <ProfileAvatar
                    avatarUrl={agent.avatarUrl}
                    className="size-10"
                    label={agent.name}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {agent.name}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Keeps its current personality and instructions
                    </span>
                  </span>
                  <Check
                    className={cn(
                      "size-4 shrink-0",
                      agent.pubkey === selectedPubkey
                        ? "text-primary"
                        : "text-transparent",
                    )}
                  />
                </button>
              ))}
            </div>
          )
        ) : null}

        {step === "identity" ? (
          <div className="space-y-5">
            {selectedAgent ? (
              <div className="flex items-center gap-3 rounded-xl bg-muted/40 p-4">
                <ProfileAvatar
                  avatarUrl={selectedAgent.avatarUrl}
                  className="size-12"
                  label={selectedAgent.name}
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {selectedAgent.name}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Keeps its name and avatar
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <FieldLabel htmlFor="bestie-name">Agent name</FieldLabel>
                <div
                  className={cn(
                    "flex min-h-11 items-center px-3",
                    PERSONA_FIELD_SHELL_CLASS,
                  )}
                >
                  <Input
                    autoCorrect="off"
                    autoFocus
                    className={cn(
                      "h-8 px-0 py-0 leading-6",
                      PERSONA_FIELD_CONTROL_CLASS,
                    )}
                    id="bestie-name"
                    onChange={(event) => setNewName(event.target.value)}
                    placeholder="Name your agent"
                    value={newName}
                  />
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <FieldLabel htmlFor="bestie-personality">Personality</FieldLabel>
              <div className={PERSONA_FIELD_SHELL_CLASS}>
                <Textarea
                  className={cn(
                    "min-h-28 resize-y px-3 py-3 leading-5",
                    PERSONA_FIELD_CONTROL_CLASS,
                  )}
                  id="bestie-personality"
                  onChange={(event) => setPersonality(event.target.value)}
                  placeholder="How it talks to you. Direct and brief, warm and chatty, dry sense of humor."
                  value={personality}
                />
              </div>
              {selectedAgent ? (
                <p className="text-sm leading-5 text-muted-foreground">
                  Optional. Add this only if you want to change how{" "}
                  {selectedAgent.name} talks to you.
                </p>
              ) : null}
            </div>

            {selectedAgent ? null : (
              <AgentHarnessField
                disabled={runtimesLoading}
                onValueChange={(value) =>
                  setRuntime(value === NO_RUNTIME_DROPDOWN_VALUE ? "" : value)
                }
                options={runtimeDropdownOptions}
                placeholder={blankRuntimeOptionLabel}
                value={runtime.trim() || NO_RUNTIME_DROPDOWN_VALUE}
              />
            )}
          </div>
        ) : null}

        {step === "capabilities" ? (
          <div className="space-y-5">
            <div className="rounded-xl bg-muted/40 p-4">
              <p className="text-sm font-medium text-foreground">
                Always included
              </p>
              <div className="mt-2.5 grid gap-x-5 gap-y-1.5 sm:grid-cols-2">
                {BESTIE_INCLUDED_BEHAVIORS.map((behavior) => (
                  <div
                    className="flex items-start gap-2 text-sm text-muted-foreground"
                    key={behavior}
                  >
                    <Check className="mt-0.5 size-3.5 shrink-0 text-primary" />
                    <span>{behavior}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="divide-y divide-border/50">
              {BESTIE_CAPABILITIES.map((capability) => (
                <CapabilityRow
                  checked={capabilities[capability.id]}
                  description={capability.description}
                  enforcementNote={capability.enforcementNote}
                  id={`bestie-capability-${capability.id}`}
                  key={capability.id}
                  label={capability.label}
                  onCheckedChange={(checked) =>
                    setCapability(capability.id, checked)
                  }
                />
              ))}
            </div>

            <div className="space-y-1.5 border-t border-border/50 pt-5">
              <FieldLabel htmlFor="bestie-instructions">
                Agent instructions
              </FieldLabel>
              <p className="text-sm leading-5 text-muted-foreground">
                {source === "existing"
                  ? "Its existing instructions, plus anything you want to add for the role. These can’t widen what you turned off."
                  : "How it should handle your attention. These can’t widen what you turned off."}
              </p>
              <div className={PERSONA_FIELD_SHELL_CLASS}>
                <Textarea
                  className={cn(
                    "min-h-28 resize-y px-3 py-3 leading-5",
                    PERSONA_FIELD_CONTROL_CLASS,
                  )}
                  id="bestie-instructions"
                  onChange={(event) =>
                    setAdditionalInstructions(event.target.value)
                  }
                  placeholder="Lead with what changed and why the timing matters. Don’t interrupt me about routine activity."
                  value={additionalInstructions}
                />
              </div>
            </div>
          </div>
        ) : null}

        {step === "review" ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl bg-muted/40 p-4">
              {selectedAgent ? (
                <ProfileAvatar
                  avatarUrl={selectedAgent.avatarUrl}
                  className="size-12"
                  label={agentName}
                />
              ) : (
                <span className="flex size-12 items-center justify-center rounded-xl bg-primary/12 text-primary">
                  <Bot className="size-5" />
                </span>
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {agentName}
                </p>
                <p className="text-sm text-muted-foreground">Your bestie</p>
              </div>
            </div>
            <div className="divide-y divide-border/50 rounded-xl border border-input px-4">
              {BESTIE_CAPABILITIES.map((capability) => (
                <div
                  className="flex items-center justify-between gap-4 py-2.5 text-sm"
                  key={capability.id}
                >
                  <span className="text-foreground">{capability.label}</span>
                  <span className="text-muted-foreground">
                    {capabilities[capability.id] ? "On" : "Off"}
                  </span>
                </div>
              ))}
            </div>
            {saveError ? (
              <p className="text-sm text-destructive">{saveError}</p>
            ) : null}
          </div>
        ) : null}
      </ChooserDialogContent>
    </Dialog>
  );
}
