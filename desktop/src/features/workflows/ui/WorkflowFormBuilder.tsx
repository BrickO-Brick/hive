import {
  ArrowDown,
  CalendarClock,
  Check,
  ChevronDown,
  GitPullRequest,
  MessageSquare,
  Plus,
  SmilePlus,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import * as React from "react";
import { createPortal } from "react-dom";

import { useCustomEmoji } from "@/features/custom-emoji/hooks";
import { reactionEmojiUrl } from "@/shared/api/customEmoji";
import type { Channel } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";
import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Switch } from "@/shared/ui/switch";
import { Textarea } from "@/shared/ui/textarea";
import { WorkflowConditionBuilder } from "./WorkflowConditionBuilder";
import {
  StepReactionDescription,
  TriggerNodeDescription,
} from "./WorkflowNodeDescriptions";
import { WorkflowScheduleFields } from "./WorkflowScheduleFields";
import { WorkflowStepCard } from "./WorkflowStepCard";
import { buildConditionExpression } from "./workflowConditionExpression";
import {
  DEFAULT_FORM_STATE,
  ACTION_LABELS,
  SELECTABLE_ACTION_TYPES,
  TRIGGER_LABELS,
  TRIGGER_TYPES,
  formStateToYaml,
  nextStepId,
  yamlToFormState,
} from "./workflowFormTypes";
import type {
  ActionType,
  StepFormState,
  TriggerConfig,
  TriggerType,
  WorkflowFormState,
} from "./workflowFormTypes";
import { defaultScheduleTrigger } from "./workflowSchedule";
import { workflowStepDescription } from "./workflowStepDescription";
import { useWorkflowTriggerPresentation } from "./useWorkflowTriggerPresentation";
import type { WorkflowEditorPane } from "./workflowEditorPane";

const TRIGGER_ICONS: Record<TriggerType, LucideIcon> = {
  diff_posted: GitPullRequest,
  message_posted: MessageSquare,
  reaction_added: SmilePlus,
  schedule: CalendarClock,
  webhook: Webhook,
};

function TriggerConfigFields({
  channels,
  disabled,
  workflowChannelId,
  trigger,
  onUpdate,
}: {
  channels: Channel[];
  disabled?: boolean;
  workflowChannelId?: string | null;
  trigger: TriggerConfig;
  onUpdate: (trigger: TriggerConfig) => void;
}) {
  switch (trigger.on) {
    case "message_posted":
    case "diff_posted":
      return (
        <div className="h-full">
          <WorkflowConditionBuilder
            channelId={workflowChannelId}
            channels={channels}
            disabled={disabled}
            idPrefix="wf-trigger-filter"
            matchAllLabel={
              trigger.on === "message_posted" ? "All messages" : "All diffs"
            }
            onChange={(filter) => onUpdate({ ...trigger, filter })}
            triggerType={trigger.on}
            value={trigger.filter ?? ""}
          />
        </div>
      );
    case "reaction_added":
      return (
        <div className="h-full">
          <WorkflowConditionBuilder
            channelId={workflowChannelId}
            channels={channels}
            disabled={disabled}
            idPrefix="wf-trigger-filter"
            matchAllLabel="All reactions"
            onChange={(filter) =>
              onUpdate({ ...trigger, emoji: undefined, filter })
            }
            triggerType={trigger.on}
            value={
              trigger.filter ??
              buildConditionExpression({
                field: "trigger_emoji",
                operator: "equals",
                value: trigger.emoji ?? "",
              }) ??
              ""
            }
          />
        </div>
      );
    case "webhook":
      return (
        <p className="text-xs text-muted-foreground">
          A unique URL is generated after creation.
        </p>
      );
    case "schedule":
      return (
        <WorkflowScheduleFields
          disabled={disabled}
          onUpdate={onUpdate}
          trigger={trigger}
        />
      );
    default:
      return null;
  }
}

type WorkflowFormBuilderProps = {
  channels: Channel[];
  disabled?: boolean;
  headerTrailingContainer?: HTMLElement | null;
  mode: WorkflowEditorMode;
  onChange: (yaml: string) => void;
  onSelectedNodeChange: (node: WorkflowEditorPane) => void;
  parseError: string | null;
  scopeField?: React.ReactNode;
  selectedNode: WorkflowEditorPane;
  yaml: string;
  workflowChannelId?: string | null;
};

export type WorkflowEditorMode = "form" | "yaml";

function nodePosition(node: Exclude<WorkflowEditorPane, null>): number {
  return node.type === "trigger" ? 0 : node.index + 1;
}

const inspectorContentVariants = {
  enter: (direction: number) => ({
    opacity: 0,
    y: direction < 0 ? 12 : -12,
  }),
  center: { opacity: 1, y: 0 },
  exit: (direction: number) => ({
    opacity: 0,
    y: direction < 0 ? -12 : 12,
  }),
};

function InspectorTypeMenu<T extends string>({
  ariaLabel,
  disabled,
  labels,
  onChange,
  options,
  value,
}: {
  ariaLabel: string;
  disabled?: boolean;
  labels: Record<T, string>;
  onChange: (value: T) => void;
  options: readonly T[];
  value: T;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={ariaLabel}
          className="group inline-flex max-w-full items-center gap-1.5 rounded-md py-0.5 text-base font-semibold text-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
          data-value={value}
          disabled={disabled}
          type="button"
        >
          <span className="truncate">{labels[value]}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8}>
        {options.map((option) => (
          <DropdownMenuItem key={option} onSelect={() => onChange(option)}>
            <Check
              className={cn(
                "h-4 w-4",
                option === value ? "opacity-100" : "opacity-0",
              )}
            />
            <span>{labels[option]}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkflowNode({
  description,
  disabled,
  icon,
  label,
  number,
  onAddAfter,
  onClick,
  onRemove,
  selected,
  showTitle = true,
  subtitle,
  terminal,
  title,
}: {
  description: React.ReactNode;
  disabled?: boolean;
  icon?: React.ReactNode;
  label: string;
  number?: number;
  onAddAfter: (action: ActionType) => void;
  onClick: () => void;
  onRemove?: () => void;
  selected: boolean;
  showTitle?: boolean;
  subtitle?: string;
  terminal: boolean;
  title: string;
}) {
  const isNumbered = number !== undefined;
  const [addMenuOpen, setAddMenuOpen] = React.useState(false);

  return (
    <li className="flex flex-col items-center">
      <div className="group relative isolate w-full after:absolute after:left-full after:top-0 after:z-0 after:h-full after:w-12 after:content-['']">
        <button
          aria-label={label}
          aria-pressed={selected}
          className={cn(
            "relative z-20 flex w-full items-center gap-3 text-left transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            "rounded-full bg-muted/25 p-3 outline outline-2 outline-offset-4 outline-muted-foreground/0",
            "data-[selected=true]:bg-muted/70 data-[selected=true]:outline-muted-foreground/20",
            "data-[selected=false]:hover:bg-muted/45",
          )}
          data-selected={selected}
          disabled={disabled}
          onClick={onClick}
          type="button"
        >
          <span
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center",
              "rounded-full bg-muted/60 text-muted-foreground",
              "data-[selected=true]:bg-foreground/15 data-[selected=true]:text-foreground",
              isNumbered && "text-sm font-semibold",
            )}
            data-selected={selected}
          >
            {isNumbered ? number : icon}
          </span>
          <span className="min-w-0 flex-1">
            {showTitle ? (
              <span className="block text-2xs font-semibold uppercase tracking-wide text-muted-foreground/70">
                {title}
              </span>
            ) : null}
            {subtitle ? (
              <span className="block truncate text-2xs font-semibold uppercase tracking-wide text-muted-foreground/70">
                {subtitle}
              </span>
            ) : null}
            <span className="block truncate text-sm font-semibold text-foreground">
              {description}
            </span>
          </span>
        </button>

        {onRemove ? (
          <Button
            aria-label={`Remove ${title}`}
            className="pointer-events-none absolute -right-8 top-1/2 z-10 h-8 w-8 -translate-y-1/2 rounded-full bg-transparent opacity-0 transition-all duration-200 group-focus-within:pointer-events-auto group-focus-within:translate-x-3 group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:translate-x-3 group-hover:opacity-100 hover:bg-destructive/15 hover:text-destructive"
            disabled={disabled}
            onClick={onRemove}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      <div
        className="group relative flex h-18 items-center justify-center"
        data-menu-open={addMenuOpen}
        data-terminal={terminal}
        data-testid="workflow-node-ingress"
      >
        {terminal ? null : (
          <ArrowDown
            aria-hidden="true"
            className="h-5 w-5 text-muted-foreground transition-opacity duration-200 ease-out group-hover:opacity-10 group-data-[menu-open=true]:opacity-10 group-has-[:focus-visible]:opacity-10 motion-reduce:transition-none"
          />
        )}
        <DropdownMenu onOpenChange={setAddMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={
                title === "Trigger" ? "Add step" : `Add after ${title}`
              }
              className={cn(
                "relative z-10 h-7 w-7 rounded-full bg-background shadow-sm",
                !terminal &&
                  "pointer-events-none absolute scale-125 opacity-0 transition-[opacity,transform,background-color,color,border-color,box-shadow] duration-200 ease-out group-hover:pointer-events-auto group-hover:scale-100 group-hover:opacity-100 group-data-[menu-open=true]:pointer-events-auto group-data-[menu-open=true]:scale-100 group-data-[menu-open=true]:opacity-100 focus-visible:pointer-events-auto focus-visible:scale-100 focus-visible:opacity-100 motion-reduce:transition-none",
              )}
              disabled={disabled}
              size="icon"
              type="button"
              variant="outline"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" side="right" sideOffset={8}>
            {SELECTABLE_ACTION_TYPES.map((action) => (
              <DropdownMenuItem
                key={action}
                onSelect={() => onAddAfter(action)}
              >
                <span>{ACTION_LABELS[action]}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

export function WorkflowFormBuilder({
  channels,
  disabled,
  headerTrailingContainer,
  mode,
  onChange,
  onSelectedNodeChange,
  parseError,
  scopeField,
  selectedNode: selectedRouteNode,
  yaml,
  workflowChannelId,
}: WorkflowFormBuilderProps) {
  // Parse once on mount instead of calling yamlToFormState three times
  const initialParseRef = React.useRef(yaml ? yamlToFormState(yaml) : null);
  const [formState, setFormState] = React.useState<WorkflowFormState>(
    initialParseRef.current?.ok
      ? initialParseRef.current.state
      : DEFAULT_FORM_STATE,
  );
  const selectedNode =
    mode === "form" &&
    (selectedRouteNode?.type === "trigger" ||
      (selectedRouteNode?.type === "step" &&
        selectedRouteNode.index < formState.steps.length))
      ? selectedRouteNode
      : null;
  const [selectionDirection, setSelectionDirection] = React.useState<1 | -1>(1);
  const shouldReduceMotion = useReducedMotion();
  const previousModeRef = React.useRef(mode);
  const customEmoji = useCustomEmoji();
  const triggerPresentation = useWorkflowTriggerPresentation({
    trigger: formState.trigger,
    workflowChannelId,
  });
  const triggerReaction = triggerPresentation.emoji;
  const triggerReactionUrl = triggerReaction
    ? reactionEmojiUrl(triggerReaction, customEmoji)
    : undefined;
  const triggerDescription = triggerPresentation.description;
  const TriggerIcon = TRIGGER_ICONS[formState.trigger.on];

  const updateFormState = React.useCallback(
    (next: WorkflowFormState) => {
      setFormState(next);
      onChange(formStateToYaml(next));
    },
    [onChange],
  );

  React.useEffect(() => {
    if (previousModeRef.current === mode) return;
    previousModeRef.current = mode;

    if (mode === "yaml") return;

    const result = yamlToFormState(yaml);
    if (result.ok) setFormState(result.state);
  }, [mode, yaml]);

  React.useEffect(() => {
    if (!yaml.trim()) return;
    const result = yamlToFormState(yaml);
    if (!result.ok) return;
    setFormState((current) =>
      current.name === result.state.name
        ? current
        : { ...current, name: result.state.name },
    );
  }, [yaml]);

  const selectNode = React.useCallback(
    (nextNode: Exclude<WorkflowEditorPane, null>) => {
      if (selectedNode) {
        const currentPosition = nodePosition(selectedNode);
        const nextPosition = nodePosition(nextNode);
        if (nextPosition !== currentPosition) {
          setSelectionDirection(nextPosition < currentPosition ? -1 : 1);
        }
      }
      onSelectedNodeChange(nextNode);
    },
    [onSelectedNodeChange, selectedNode],
  );

  const insertStep = React.useCallback(
    (index: number, action: ActionType) => {
      const nextSteps = [...formState.steps];
      const newStep: StepFormState = {
        id: nextStepId(formState.steps),
        action,
      };
      if (action === "delay") {
        newStep.duration = "1s";
      }
      if (action === "call_webhook") {
        newStep.method = "POST";
      }
      nextSteps.splice(index, 0, newStep);
      updateFormState({
        ...formState,
        steps: nextSteps,
      });
      selectNode({ type: "step", index });
    },
    [formState, selectNode, updateFormState],
  );

  const removeStep = React.useCallback(
    (index: number) => {
      updateFormState({
        ...formState,
        steps: formState.steps.filter((_, i) => i !== index),
      });

      if (selectedNode?.type !== "step") return;

      if (selectedNode.index === index) {
        setSelectionDirection(-1);
        onSelectedNodeChange(
          index === 0
            ? { type: "trigger" }
            : { type: "step", index: index - 1 },
        );
      } else if (selectedNode.index > index) {
        setSelectionDirection(-1);
        onSelectedNodeChange({
          type: "step",
          index: selectedNode.index - 1,
        });
      }
    },
    [formState, onSelectedNodeChange, selectedNode, updateFormState],
  );

  const updateStep = React.useCallback(
    (index: number, step: StepFormState) => {
      const next = [...formState.steps];
      next[index] = step;
      updateFormState({ ...formState, steps: next });
    },
    [formState, updateFormState],
  );

  const selectedStep =
    selectedNode?.type === "step"
      ? formState.steps[selectedNode.index]
      : undefined;

  return (
    <>
      <div className="flex h-full min-h-0 flex-col [container-type:inline-size]">
        {parseError ? (
          <p className="mx-6 mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Cannot switch to form view: {parseError}
          </p>
        ) : null}

        {mode === "yaml" ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-6 pb-3 pt-3">
            <div className="max-w-md flex-shrink-0">{scopeField}</div>
            <div className="flex min-h-0 flex-1 flex-col gap-1.5">
              <Textarea
                aria-label="Workflow YAML"
                autoCapitalize="off"
                className="min-h-0 flex-1 resize-none font-mono text-xs"
                disabled={disabled}
                onChange={(event) => onChange(event.target.value)}
                value={yaml}
              />
              <p className="flex-shrink-0 text-xs text-muted-foreground">
                Edit the raw YAML definition directly.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="relative isolate flex min-h-0 flex-1">
              <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-5">
                <div className="mx-auto w-full max-w-sm">
                  {scopeField ? <div className="mb-3">{scopeField}</div> : null}
                  <ol aria-label="Workflow sequence">
                    <WorkflowNode
                      description={
                        <TriggerNodeDescription
                          authorAvatarUrl={triggerPresentation.authorAvatarUrl}
                          authorLabel={triggerPresentation.authorLabel}
                          authorLoading={triggerPresentation.authorLoading}
                          description={triggerDescription}
                          messageLoading={triggerPresentation.messageLoading}
                        />
                      }
                      disabled={disabled}
                      icon={
                        triggerReaction ? (
                          triggerReactionUrl ? (
                            <img
                              alt={triggerReaction}
                              className="h-7 w-7 object-contain"
                              data-testid="workflow-trigger-selected-reaction"
                              draggable={false}
                              src={rewriteRelayUrl(triggerReactionUrl)}
                            />
                          ) : (
                            <span
                              className={cn(
                                "max-w-8 overflow-hidden leading-none",
                                triggerReaction.startsWith(":")
                                  ? "text-xs"
                                  : "text-2xl",
                              )}
                              data-testid="workflow-trigger-selected-reaction"
                            >
                              {triggerReaction}
                            </span>
                          )
                        ) : (
                          <TriggerIcon
                            aria-hidden="true"
                            className="h-4 w-4"
                            data-testid={`workflow-trigger-icon-${formState.trigger.on}`}
                          />
                        )
                      }
                      label={`Trigger: ${triggerDescription}`}
                      onAddAfter={(action) => insertStep(0, action)}
                      onClick={() => selectNode({ type: "trigger" })}
                      selected={selectedNode?.type === "trigger"}
                      terminal={formState.steps.length === 0}
                      title="Trigger"
                    />

                    {formState.steps.map((step, index) => {
                      const actionLabel = ACTION_LABELS[step.action];
                      const channelLabel = step.channel
                        ? channels.find(
                            (channel) => channel.id === step.channel,
                          )?.name
                        : undefined;
                      const nodeDescription = workflowStepDescription(step, {
                        channelLabel,
                      });
                      const showActionSubtitle =
                        nodeDescription !== actionLabel;
                      return (
                        <WorkflowNode
                          description={
                            step.action === "add_reaction" && step.emoji ? (
                              <StepReactionDescription
                                description={nodeDescription}
                                emoji={step.emoji}
                                emojiUrl={reactionEmojiUrl(
                                  step.emoji,
                                  customEmoji,
                                )}
                              />
                            ) : (
                              nodeDescription
                            )
                          }
                          disabled={disabled}
                          key={step.id}
                          label={`Step ${index + 1}: ${nodeDescription}`}
                          number={index + 1}
                          onAddAfter={(action) => insertStep(index + 1, action)}
                          onClick={() => selectNode({ type: "step", index })}
                          onRemove={() => removeStep(index)}
                          selected={
                            selectedNode?.type === "step" &&
                            selectedNode.index === index
                          }
                          showTitle={false}
                          subtitle={
                            showActionSubtitle ? actionLabel : undefined
                          }
                          terminal={index === formState.steps.length - 1}
                          title={`Step ${index + 1}`}
                        />
                      );
                    })}
                  </ol>
                </div>
              </div>

              <AnimatePresence initial={false}>
                {selectedNode ? (
                  <motion.button
                    animate={{ opacity: 1 }}
                    aria-label="Close inspector overlay"
                    className="absolute inset-0 z-20 hidden bg-background/15 backdrop-blur-sm [@container(max-width:58rem)]:block"
                    data-testid="workflow-node-inspector-backdrop"
                    exit={{ opacity: 0 }}
                    initial={{ opacity: 0 }}
                    key="workflow-node-inspector-backdrop"
                    onClick={() => onSelectedNodeChange(null)}
                    transition={
                      shouldReduceMotion
                        ? { duration: 0 }
                        : { duration: 0.18, ease: "easeOut" }
                    }
                    type="button"
                  />
                ) : null}
                {selectedNode ? (
                  <motion.aside
                    animate={{ opacity: 1, width: "26rem", x: 0 }}
                    className="flex flex-shrink-0 p-4 [@container(max-width:58rem)]:absolute [@container(max-width:58rem)]:inset-y-0 [@container(max-width:58rem)]:right-0 [@container(max-width:58rem)]:z-30 [@container(max-width:58rem)]:max-w-full"
                    data-testid="workflow-node-inspector"
                    exit={{ opacity: 0, width: 0, x: 24 }}
                    initial={{ opacity: 0, width: 0, x: 24 }}
                    key="workflow-node-inspector"
                    transition={
                      shouldReduceMotion
                        ? { duration: 0 }
                        : { duration: 0.24, ease: [0.22, 1, 0.36, 1] }
                    }
                  >
                    <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-muted/40 [@container(max-width:58rem)]:bg-background [@container(max-width:58rem)]:shadow-2xl">
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 z-0 hidden bg-muted/40 [@container(max-width:58rem)]:block"
                      />
                      <div className="relative z-10 flex w-96 min-w-96 flex-shrink-0 items-start justify-between gap-3 px-5 pb-3 pt-5 [@container(max-width:26rem)]:w-full [@container(max-width:26rem)]:min-w-0">
                        <div className="min-w-0">
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            {selectedNode.type === "trigger"
                              ? "Trigger"
                              : `Step ${selectedNode.index + 1}`}
                          </p>
                          {selectedNode.type === "trigger" ? (
                            <InspectorTypeMenu
                              ariaLabel="Trigger event"
                              disabled={disabled}
                              labels={TRIGGER_LABELS}
                              onChange={(triggerType) =>
                                updateFormState({
                                  ...formState,
                                  trigger:
                                    triggerType === "schedule"
                                      ? defaultScheduleTrigger()
                                      : { on: triggerType },
                                })
                              }
                              options={TRIGGER_TYPES}
                              value={formState.trigger.on}
                            />
                          ) : selectedStep ? (
                            <InspectorTypeMenu
                              ariaLabel="Action"
                              disabled={disabled}
                              labels={ACTION_LABELS}
                              onChange={(action) => {
                                const next = { ...selectedStep, action };
                                if (action === "delay" && !next.duration) {
                                  next.duration = "1s";
                                }
                                if (action === "call_webhook" && !next.method) {
                                  next.method = "POST";
                                }
                                updateStep(selectedNode.index, next);
                              }}
                              options={SELECTABLE_ACTION_TYPES}
                              value={selectedStep.action}
                            />
                          ) : null}
                        </div>
                        <div className="flex items-center gap-1">
                          {selectedNode.type === "step" && selectedStep ? (
                            <Button
                              aria-label="Remove step"
                              className="h-8 w-8"
                              disabled={disabled}
                              onClick={() => removeStep(selectedNode.index)}
                              size="icon"
                              type="button"
                              variant="ghost"
                            >
                              <Trash2 className="h-4 w-4 text-muted-foreground" />
                            </Button>
                          ) : null}
                          <Button
                            aria-label="Close inspector"
                            className="h-8 w-8"
                            onClick={() => onSelectedNodeChange(null)}
                            size="icon"
                            type="button"
                            variant="ghost"
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>

                      <div className="relative z-10 min-h-0 w-96 min-w-96 flex-1 overflow-y-auto px-5 pb-5 pt-2 [@container(max-width:26rem)]:w-full [@container(max-width:26rem)]:min-w-0">
                        <AnimatePresence
                          custom={selectionDirection}
                          initial={false}
                          mode="wait"
                        >
                          <motion.div
                            animate="center"
                            className="h-full"
                            custom={selectionDirection}
                            exit="exit"
                            initial="enter"
                            key={
                              selectedNode.type === "trigger"
                                ? "trigger"
                                : `step-${selectedNode.index}`
                            }
                            transition={
                              shouldReduceMotion
                                ? { duration: 0 }
                                : { duration: 0.15, ease: "easeOut" }
                            }
                            variants={inspectorContentVariants}
                          >
                            {selectedNode.type === "trigger" ? (
                              <div className="h-full">
                                <TriggerConfigFields
                                  channels={channels}
                                  disabled={disabled}
                                  onUpdate={(trigger) =>
                                    updateFormState({ ...formState, trigger })
                                  }
                                  trigger={formState.trigger}
                                  workflowChannelId={workflowChannelId}
                                />
                              </div>
                            ) : selectedStep ? (
                              <WorkflowStepCard
                                bare
                                channels={channels}
                                disabled={disabled}
                                index={selectedNode.index}
                                onRemove={() => removeStep(selectedNode.index)}
                                onUpdate={(updated) =>
                                  updateStep(selectedNode.index, updated)
                                }
                                previousSteps={formState.steps.slice(
                                  0,
                                  selectedNode.index,
                                )}
                                showHeader={false}
                                step={selectedStep}
                                triggerType={formState.trigger.on}
                                workflowChannelId={workflowChannelId}
                              />
                            ) : null}
                          </motion.div>
                        </AnimatePresence>
                      </div>
                    </div>
                  </motion.aside>
                ) : null}
              </AnimatePresence>
            </div>
          </div>
        )}
      </div>
      {mode === "form" && headerTrailingContainer
        ? createPortal(
            <div className="flex items-center gap-3">
              <label className="text-sm text-foreground" htmlFor="wf-enabled">
                Enable
              </label>
              <Switch
                checked={formState.enabled}
                disabled={disabled}
                id="wf-enabled"
                onCheckedChange={(checked) =>
                  updateFormState({ ...formState, enabled: checked })
                }
              />
            </div>,
            headerTrailingContainer,
          )
        : null}
    </>
  );
}
