import { Trash2 } from "lucide-react";

import type { Channel } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import { ChannelCombobox } from "./ChannelCombobox";
import { WorkflowDurationField } from "./WorkflowDurationField";
import { WorkflowEmojiField } from "./WorkflowEmojiField";
import { WorkflowTemplateTextarea } from "./WorkflowTemplateTextarea";
import { FieldLabel, FormSelect } from "./workflowFormPrimitives";
import { WorkflowWebhookHeadersEditor } from "./WorkflowWebhookHeadersEditor";
import type { StepFormState, TriggerType } from "./workflowFormTypes";

const DEFAULT_STEP_TIMEOUT_SECONDS = 5 * 60;
const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 24 * 60 * 60;

function BackendSupportHint({ action }: { action: StepFormState["action"] }) {
  switch (action) {
    case "send_dm":
      return (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-700">
          Backend note: `send_dm` is not executed yet, so runs fail at this
          step.
        </p>
      );
    case "set_channel_topic":
      return (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-700">
          Backend note: `set_channel_topic` is not executed yet, so runs fail at
          this step.
        </p>
      );
    case "request_approval":
      return (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-700">
          Backend note: approval gates still stop runs with WF-08; approval
          records are not persisted yet.
        </p>
      );
    case "add_reaction":
      return (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-700">
          Backend note: `add_reaction` is not executed yet, so runs fail at this
          step.
        </p>
      );
    default:
      return null;
  }
}

function StepConfigFields({
  step,
  prefix,
  disabled,
  channels,
  previousSteps,
  triggerType,
  workflowChannelId,
  onUpdate,
}: {
  step: StepFormState;
  prefix: string;
  disabled?: boolean;
  channels: Channel[];
  previousSteps: StepFormState[];
  triggerType: TriggerType;
  workflowChannelId?: string | null;
  onUpdate: (step: StepFormState) => void;
}) {
  switch (step.action) {
    case "delay":
      return (
        <WorkflowDurationField
          disabled={disabled}
          id={`${prefix}-duration`}
          onChange={(duration) => onUpdate({ ...step, duration })}
          value={step.duration ?? ""}
        />
      );
    case "send_message":
      return (
        <div className="space-y-2">
          <div className="space-y-1.5">
            <FieldLabel htmlFor={`${prefix}-text`}>Message text</FieldLabel>
            <WorkflowTemplateTextarea
              autoCapitalize="off"
              className="min-h-[60px] resize-y text-xs"
              disabled={disabled}
              id={`${prefix}-text`}
              onValueChange={(text) => onUpdate({ ...step, text })}
              placeholder="e.g. Deployment started by {{trigger.author}}"
              previousSteps={previousSteps}
              triggerType={triggerType}
              value={step.text ?? ""}
            />
          </div>
          {!workflowChannelId ? (
            <div className="space-y-1.5">
              <FieldLabel htmlFor={`${prefix}-channel`}>
                Channel override (optional)
              </FieldLabel>
              <ChannelCombobox
                allowEmpty
                ariaLabel="Channel override (optional)"
                channels={channels}
                disabled={disabled}
                emptyLabel="Use trigger channel"
                id={`${prefix}-channel`}
                onChange={(channel) => onUpdate({ ...step, channel })}
                value={step.channel ?? ""}
                variant="field"
              />
              <p className="text-xs text-muted-foreground">
                Defaults to the channel that triggered the workflow. Webhook and
                manual triggers require a channel.
              </p>
              {triggerType === "webhook" && !(step.channel ?? "").trim() ? (
                <p className="text-xs text-amber-700">
                  This step will fail for webhook-triggered runs until a channel
                  override is set.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      );
    case "send_dm":
      return (
        <div className="space-y-2">
          <BackendSupportHint action={step.action} />
          <div className="space-y-1.5">
            <FieldLabel htmlFor={`${prefix}-to`}>To (pubkey)</FieldLabel>
            <Input
              autoCapitalize="off"
              disabled={disabled}
              id={`${prefix}-to`}
              onChange={(event) =>
                onUpdate({ ...step, to: event.target.value })
              }
              placeholder="e.g. {{trigger.author}} or hex pubkey"
              value={step.to ?? ""}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor={`${prefix}-text`}>Message text</FieldLabel>
            <Textarea
              autoCapitalize="off"
              className="min-h-[60px] resize-y text-xs"
              disabled={disabled}
              id={`${prefix}-text`}
              onChange={(event) =>
                onUpdate({ ...step, text: event.target.value })
              }
              placeholder="DM content"
              value={step.text ?? ""}
            />
          </div>
        </div>
      );
    case "call_webhook":
      return (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <FieldLabel htmlFor={`${prefix}-url`}>Endpoint URL</FieldLabel>
            <Input
              autoCapitalize="off"
              disabled={disabled}
              id={`${prefix}-url`}
              onChange={(event) =>
                onUpdate({ ...step, url: event.target.value })
              }
              placeholder="https://..."
              value={step.url ?? ""}
            />
            {step.url && !step.url.startsWith("https://") ? (
              <p className="text-xs text-destructive">
                URL must start with https://
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor={`${prefix}-method`}>HTTP method</FieldLabel>
            <FormSelect
              disabled={disabled}
              id={`${prefix}-method`}
              onChange={(value) => onUpdate({ ...step, method: value })}
              value={step.method ?? "POST"}
            >
              <option value="POST">POST</option>
              <option value="GET">GET</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
              <option value="DELETE">DELETE</option>
            </FormSelect>
          </div>
          <WorkflowWebhookHeadersEditor
            disabled={disabled}
            headers={step.headers ?? []}
            onChange={(headers) => onUpdate({ ...step, headers })}
            stepId={step.id || prefix}
          />
          <div className="space-y-1.5">
            <FieldLabel htmlFor={`${prefix}-body`}>
              Request body (optional)
            </FieldLabel>
            <Textarea
              autoCapitalize="off"
              className="min-h-[60px] resize-y font-mono text-xs"
              disabled={disabled}
              id={`${prefix}-body`}
              onChange={(event) =>
                onUpdate({ ...step, body: event.target.value })
              }
              placeholder='{"key": "{{trigger.text}}"}'
              value={step.body ?? ""}
            />
          </div>
        </div>
      );
    case "request_approval":
      return (
        <div className="space-y-2">
          <BackendSupportHint action={step.action} />
          <div className="space-y-1.5">
            <FieldLabel htmlFor={`${prefix}-from`}>From (approver)</FieldLabel>
            <Input
              autoCapitalize="off"
              disabled={disabled}
              id={`${prefix}-from`}
              onChange={(event) =>
                onUpdate({ ...step, from: event.target.value })
              }
              placeholder="Pubkey or role"
              value={step.from ?? ""}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor={`${prefix}-message`}>Message</FieldLabel>
            <Input
              autoCapitalize="off"
              disabled={disabled}
              id={`${prefix}-message`}
              onChange={(event) =>
                onUpdate({ ...step, message: event.target.value })
              }
              placeholder="Approval request message"
              value={step.message ?? ""}
            />
          </div>
          <WorkflowDurationField
            disabled={disabled}
            fallbackSeconds={DEFAULT_APPROVAL_TIMEOUT_SECONDS}
            id={`${prefix}-timeout`}
            label="Timeout"
            onChange={(timeout) => onUpdate({ ...step, timeout })}
            placeholder="24h"
            value={step.timeout ?? ""}
          />
        </div>
      );
    case "add_reaction":
      return (
        <div className="space-y-2">
          <BackendSupportHint action={step.action} />
          <FieldLabel htmlFor={`${prefix}-emoji`}>Emoji</FieldLabel>
          <WorkflowEmojiField
            ariaLabel="Choose reaction emoji"
            disabled={disabled}
            id={`${prefix}-emoji`}
            onChange={(emoji) => onUpdate({ ...step, emoji })}
            value={step.emoji ?? ""}
          />
        </div>
      );
    case "set_channel_topic":
      return (
        <div className="space-y-2">
          <BackendSupportHint action={step.action} />
          <div className="space-y-1.5">
            <FieldLabel htmlFor={`${prefix}-topic`}>Topic</FieldLabel>
            <Input
              autoCapitalize="off"
              disabled={disabled}
              id={`${prefix}-topic`}
              onChange={(event) =>
                onUpdate({ ...step, topic: event.target.value })
              }
              placeholder="New channel topic"
              value={step.topic ?? ""}
            />
          </div>
        </div>
      );
    default:
      return null;
  }
}

export function WorkflowStepCard({
  bare = false,
  channels = [],
  showHeader = true,
  index,
  disabled,
  onRemove,
  onUpdate,
  step,
  previousSteps = [],
  triggerType,
  workflowChannelId,
}: {
  bare?: boolean;
  channels?: Channel[];
  showHeader?: boolean;
  index: number;
  disabled?: boolean;
  onRemove: () => void;
  onUpdate: (step: StepFormState) => void;
  step: StepFormState;
  previousSteps?: StepFormState[];
  triggerType: TriggerType;
  workflowChannelId?: string | null;
}) {
  const prefix = `wf-step-${index}`;

  return (
    <div
      className={cn(
        "space-y-0",
        !bare && "rounded-lg border border-border/70 bg-muted/10 p-3",
      )}
    >
      {showHeader ? (
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Step {index + 1}
          </span>
          <Button
            aria-label="Remove step"
            className="h-7 w-7"
            disabled={disabled}
            onClick={onRemove}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2 className="h-4 w-4 text-muted-foreground" />
          </Button>
        </div>
      ) : null}

      <section className="space-y-5 pb-5">
        <StepConfigFields
          channels={channels}
          disabled={disabled}
          onUpdate={onUpdate}
          prefix={prefix}
          previousSteps={previousSteps}
          step={step}
          triggerType={triggerType}
          workflowChannelId={workflowChannelId}
        />
        <WorkflowDurationField
          disabled={disabled}
          fallbackSeconds={DEFAULT_STEP_TIMEOUT_SECONDS}
          id={`${prefix}-timeout-secs`}
          label="Timeout"
          onChange={(timeoutSecs) => onUpdate({ ...step, timeoutSecs })}
          placeholder="5m"
          value={step.timeoutSecs ?? ""}
        />
      </section>

      <section className="space-y-4 border-t border-border/50 pt-5">
        <div className="space-y-1.5">
          <FieldLabel htmlFor={`${prefix}-name`}>Name (optional)</FieldLabel>
          <Input
            autoCapitalize="off"
            disabled={disabled}
            id={`${prefix}-name`}
            onChange={(event) =>
              onUpdate({ ...step, name: event.target.value })
            }
            placeholder="e.g. Notify deployment channel"
            value={step.name ?? ""}
          />
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor={`${prefix}-id`}>Step ID</FieldLabel>
          <Input
            autoCapitalize="off"
            disabled={disabled}
            id={`${prefix}-id`}
            onChange={(event) => onUpdate({ ...step, id: event.target.value })}
            placeholder="unique_step_id"
            value={step.id}
          />
          <p className="text-xs text-muted-foreground">
            Used in configuration and run history.
          </p>
        </div>
      </section>
    </div>
  );
}
