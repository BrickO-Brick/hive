import {
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  Plus,
  ShieldCheck,
} from "lucide-react";
import * as React from "react";

import {
  BESTIE_CAPABILITIES,
  BESTIE_INCLUDED_BEHAVIORS,
  DEFAULT_BESTIE_CAPABILITIES,
  type BestieCapabilityState,
} from "@/features/agents/lib/bestieCapabilities";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import type { ManagedAgent } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import { Dialog, DialogContent } from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Switch } from "@/shared/ui/switch";
import { Textarea } from "@/shared/ui/textarea";

export type BestieSetupSubmission = {
  additionalInstructions: string;
  agentName: string;
  agentPubkey: string | null;
  capabilities: BestieCapabilityState;
  source: "existing" | "new";
};

type SetupStep =
  | "capabilities"
  | "source"
  | "existing"
  | "identity"
  | "instructions"
  | "review";

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
};

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
    <div className="flex items-start justify-between gap-6 py-4">
      <div className="min-w-0">
        <label className="text-sm font-medium" htmlFor={id}>
          {label}
        </label>
        <p className="mt-1 max-w-lg text-sm leading-5 text-muted-foreground">
          {description}
        </p>
        {enforcementNote ? (
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground/80">
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
}: BestieSetupDialogProps) {
  const isManaging = Boolean(initial);
  const [step, setStep] = React.useState<SetupStep>("capabilities");
  const [source, setSource] = React.useState<"existing" | "new">("new");
  const [selectedPubkey, setSelectedPubkey] = React.useState<string | null>(
    null,
  );
  const [newName, setNewName] = React.useState("");
  const [additionalInstructions, setAdditionalInstructions] =
    React.useState("");
  const [capabilities, setCapabilities] = React.useState<BestieCapabilityState>(
    DEFAULT_BESTIE_CAPABILITIES,
  );
  const [isSaving, setIsSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  // Re-seed whenever the dialog opens so managing an assignment starts from
  // its stored values and a fresh setup starts from role defaults.
  const seededRef = React.useRef(false);
  if (open && !seededRef.current) {
    seededRef.current = true;
    if (initial) {
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

  function reset() {
    setStep("capabilities");
    setSource("new");
    setSelectedPubkey(null);
    setNewName("");
    setAdditionalInstructions("");
    setCapabilities(DEFAULT_BESTIE_CAPABILITIES);
    setIsSaving(false);
    setSaveError(null);
  }

  function handleOpenChange(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (!nextOpen) reset();
  }

  function setCapability(id: keyof BestieCapabilityState, value: boolean) {
    setCapabilities((current) => ({ ...current, [id]: value }));
  }

  function back() {
    if (step === "source") setStep("capabilities");
    else if (step === "existing" || step === "identity") setStep("source");
    else if (step === "instructions")
      setStep(
        isManaging
          ? "capabilities"
          : source === "existing"
            ? "existing"
            : "identity",
      );
    else if (step === "review") setStep("instructions");
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
    capabilities: isManaging
      ? `What ${displayName} can do`
      : "What your bestie can do",
    source: "Choose how to set it up",
    existing: "Choose an agent",
    identity: "Name your agent",
    instructions: `How should ${displayName} work with you?`,
    review: agentName ? `${agentName} is ready` : "Review",
  }[step];

  const description = {
    capabilities:
      "Set what the role can do. You can give these capabilities to a new agent or one you already use.",
    source: "Create a new agent or give the role to one you already use.",
    existing: "Its name, personality, and existing work stay the same.",
    identity:
      "This is the name you’ll see across Buzz. You can change it later.",
    instructions:
      "Add preferences for tone, detail, or timing. These never change its privacy or authority boundaries.",
    review: "Review the role before you save it.",
  }[step];

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent
        className="flex max-h-[88vh] max-w-2xl flex-col gap-0 overflow-hidden p-0"
        data-testid="bestie-setup-dialog"
      >
        <div className="flex min-h-20 shrink-0 items-center border-b border-border/60 px-7 pr-14">
          {step !== "capabilities" ? (
            <Button
              aria-label="Back"
              className="mr-3"
              onClick={back}
              size="icon"
              variant="ghost"
            >
              <ArrowLeft />
            </Button>
          ) : null}
          <div>
            <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {description}
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
          {step === "capabilities" ? (
            <div className="space-y-7">
              <section>
                <div className="flex items-center gap-2">
                  <ShieldCheck className="size-4 text-primary" />
                  <h3 className="text-sm font-semibold">
                    Always included with the role
                  </h3>
                </div>
                <div className="mt-3 grid gap-x-5 gap-y-2 rounded-xl bg-muted/55 p-4 sm:grid-cols-2">
                  {BESTIE_INCLUDED_BEHAVIORS.map((behavior) => (
                    <div
                      className="flex items-start gap-2 text-sm"
                      key={behavior}
                    >
                      <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                      <span>{behavior}</span>
                    </div>
                  ))}
                </div>
              </section>
              <section className="divide-y divide-border/60">
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
              </section>
            </div>
          ) : null}

          {step === "source" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                className="group flex min-h-48 flex-col rounded-2xl border border-border/70 p-5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setSource("new");
                  setStep("identity");
                }}
                type="button"
              >
                <span className="flex size-10 items-center justify-center rounded-xl bg-primary/12 text-primary">
                  <Plus />
                </span>
                <span className="mt-auto flex items-end justify-between gap-4">
                  <span>
                    <span className="block text-sm font-semibold">
                      Create a new agent
                    </span>
                    <span className="mt-1 block text-sm leading-5 text-muted-foreground">
                      Start fresh and name it yourself.
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </span>
              </button>
              <button
                className="group flex min-h-48 flex-col rounded-2xl border border-border/70 p-5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setSource("existing");
                  setStep("existing");
                }}
                type="button"
              >
                <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <Bot />
                </span>
                <span className="mt-auto flex items-end justify-between gap-4">
                  <span>
                    <span className="block text-sm font-semibold">
                      Use an agent you have
                    </span>
                    <span className="mt-1 block text-sm leading-5 text-muted-foreground">
                      Add the role without changing its identity.
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </span>
              </button>
            </div>
          ) : null}

          {step === "existing" ? (
            isLoadingAgents ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Loading your agents…
              </p>
            ) : agents.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                You don’t have an agent to use yet.
              </p>
            ) : (
              <div className="space-y-1">
                {agents.map((agent) => (
                  <button
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    key={agent.pubkey}
                    onClick={() => setSelectedPubkey(agent.pubkey)}
                    type="button"
                  >
                    <ProfileAvatar
                      avatarUrl={agent.avatarUrl}
                      className="size-11"
                      label={agent.name}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {agent.name}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        Keeps its current personality and instructions
                      </span>
                    </span>
                    <span
                      className={
                        agent.pubkey === selectedPubkey
                          ? "text-primary"
                          : "text-transparent"
                      }
                    >
                      <Check />
                    </span>
                  </button>
                ))}
              </div>
            )
          ) : null}

          {step === "identity" ? (
            <div className="mx-auto max-w-md space-y-5 py-4">
              <div className="flex items-center gap-4">
                <span className="flex size-16 items-center justify-center rounded-2xl bg-primary/12 text-primary">
                  <Bot className="size-7" />
                </span>
                <div className="min-w-0 flex-1">
                  <label className="text-sm font-medium" htmlFor="bestie-name">
                    Name
                  </label>
                  <Input
                    autoFocus
                    id="bestie-name"
                    onChange={(event) => setNewName(event.target.value)}
                    placeholder="Name your agent"
                    value={newName}
                  />
                </div>
              </div>
              <p className="text-sm leading-6 text-muted-foreground">
                Bestie is the role this agent holds. Everywhere else in Buzz,
                you’ll see the name you choose.
              </p>
            </div>
          ) : null}

          {step === "instructions" ? (
            <div className="space-y-3">
              <label
                className="text-sm font-medium"
                htmlFor="bestie-instructions"
              >
                Additional instructions
              </label>
              <Textarea
                className="min-h-40 resize-none"
                id="bestie-instructions"
                onChange={(event) =>
                  setAdditionalInstructions(event.target.value)
                }
                placeholder="Keep it brief. Lead with what changed and why the timing matters. Don’t interrupt me about routine activity."
                value={additionalInstructions}
              />
              <p className="text-sm leading-5 text-muted-foreground">
                {displayName} follows these when helping you. They can’t widen
                what you turned off.
              </p>
            </div>
          ) : null}

          {step === "review" ? (
            <div className="space-y-5">
              <div className="flex items-center gap-4 rounded-2xl bg-muted/55 p-4">
                {selectedAgent ? (
                  <ProfileAvatar
                    avatarUrl={selectedAgent.avatarUrl}
                    className="size-14"
                    label={agentName}
                  />
                ) : (
                  <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/12 text-primary">
                    <Bot />
                  </span>
                )}
                <div>
                  <p className="font-semibold">{agentName}</p>
                  <p className="text-sm text-muted-foreground">Your bestie</p>
                </div>
              </div>
              <div className="divide-y divide-border/60 rounded-xl border border-border/60 px-4">
                {BESTIE_CAPABILITIES.map((capability) => (
                  <div
                    className="flex items-center justify-between gap-4 py-3 text-sm"
                    key={capability.id}
                  >
                    <span className="font-medium">{capability.label}</span>
                    <span className="text-muted-foreground">
                      {capabilities[capability.id] ? "On" : "Off"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {saveError ? (
          <p className="shrink-0 border-t border-destructive/20 bg-destructive/5 px-7 py-3 text-sm text-destructive">
            {saveError}
          </p>
        ) : null}

        <div className="flex shrink-0 justify-end gap-2 border-t border-border/60 px-7 py-4">
          {step === "capabilities" ? (
            <Button
              onClick={() => setStep(isManaging ? "instructions" : "source")}
            >
              Continue
            </Button>
          ) : null}
          {step === "existing" ? (
            <Button
              disabled={!selectedAgent}
              onClick={() => setStep("instructions")}
            >
              Use {selectedAgent?.name ?? "this agent"}
            </Button>
          ) : null}
          {step === "identity" ? (
            <Button
              disabled={!newName.trim()}
              onClick={() => setStep("instructions")}
            >
              Continue
            </Button>
          ) : null}
          {step === "instructions" ? (
            <Button onClick={() => setStep("review")}>Review</Button>
          ) : null}
          {step === "review" ? (
            <Button disabled={isSaving} onClick={() => void submit()}>
              {isSaving
                ? "Saving…"
                : isManaging
                  ? "Save changes"
                  : `Make ${agentName} your bestie`}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
