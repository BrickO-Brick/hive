import type { Workflow } from "@/shared/api/types";
import {
  scheduleFormFromTrigger,
  SCHEDULE_FREQUENCY_LABELS,
} from "./workflowSchedule";
import { ACTION_LABELS, TRIGGER_LABELS } from "./workflowFormTypes";
import type { ActionType } from "./workflowFormTypes";
import type { TriggerType } from "./workflowFormTypes";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function humanizeIdentifier(value: string): string {
  return value.replaceAll("_", " ").replace(/\s+/g, " ").trim();
}

function getWorkflowSteps(
  definition: Record<string, unknown>,
): Record<string, unknown>[] {
  return Array.isArray(definition.steps)
    ? definition.steps.map(asRecord).filter((step) => step !== null)
    : [];
}

export function getWorkflowTriggerType(
  definition: Record<string, unknown>,
): string | null {
  return nonEmptyString(asRecord(definition.trigger)?.on);
}

export function getWorkflowPrimaryAction(
  definition: Record<string, unknown>,
): string | null {
  return nonEmptyString(getWorkflowSteps(definition)[0]?.action);
}

function getScheduleCardClause(trigger: Record<string, unknown>): string {
  const schedule = scheduleFormFromTrigger({
    on: "schedule",
    cron: nonEmptyString(trigger.cron) ?? undefined,
    interval: nonEmptyString(trigger.interval) ?? undefined,
  });

  switch (schedule.frequency) {
    case "daily":
      return `Every day at ${schedule.time} UTC`;
    case "weekly":
      return `Every week at ${schedule.time} UTC`;
    case "monthly":
      return `Every month at ${schedule.time} UTC`;
    case "custom_interval":
      return schedule.customInterval
        ? `Every ${schedule.customInterval}`
        : "On a schedule";
    case "custom_cron":
      return "On a custom schedule";
    default:
      return SCHEDULE_FREQUENCY_LABELS[schedule.frequency];
  }
}

function getTriggerCardClause(definition: Record<string, unknown>): string {
  const trigger = asRecord(definition.trigger);
  const triggerType = nonEmptyString(trigger?.on);
  if (!trigger || !triggerType) return "When this workflow starts";

  switch (triggerType) {
    case "message_posted":
      return nonEmptyString(trigger.filter)
        ? "When a matching message is posted"
        : "When a message is posted";
    case "reaction_added": {
      const emoji = nonEmptyString(trigger.emoji);
      return emoji
        ? `When someone reacts with ${emoji}`
        : "When someone adds a reaction";
    }
    case "diff_posted":
      return nonEmptyString(trigger.filter)
        ? "When a matching diff is posted"
        : "When a diff is posted";
    case "webhook":
      return "When a webhook arrives";
    case "schedule":
      return getScheduleCardClause(trigger);
    default:
      return `When ${humanizeIdentifier(triggerType)} happens`;
  }
}

function getActionCardClause(step: Record<string, unknown>): string | null {
  const action = nonEmptyString(step.action);
  if (!action) return null;

  switch (action) {
    case "delay": {
      const duration = nonEmptyString(step.duration);
      return duration ? `wait ${duration}` : "wait for a moment";
    }
    case "send_message":
      return "send a channel message";
    case "call_webhook":
      return "call a webhook";
    case "send_dm":
      return "send a direct message";
    case "request_approval":
      return "request approval";
    case "add_reaction": {
      const emoji = nonEmptyString(step.emoji);
      return emoji ? `add a ${emoji} reaction` : "add a reaction";
    }
    case "set_channel_topic":
      return "update the channel topic";
    default: {
      const knownLabel = ACTION_LABELS[action as ActionType];
      return (knownLabel ?? humanizeIdentifier(action)).toLocaleLowerCase();
    }
  }
}

/** Build a short plain-language label from the workflow's trigger and steps. */
export function getWorkflowCardLabel(
  definition: Record<string, unknown>,
): string {
  const triggerClause = getTriggerCardClause(definition);
  const steps = getWorkflowSteps(definition);
  const firstAction = steps[0] ? getActionCardClause(steps[0]) : null;
  if (!firstAction) return triggerClause;

  const remainingStepCount = steps.length - 1;
  if (remainingStepCount === 0) return `${triggerClause}, ${firstAction}`;

  return `${triggerClause}, ${firstAction}, then ${remainingStepCount} more ${
    remainingStepCount === 1 ? "step" : "steps"
  }`;
}

export function getWorkflowEnabled(
  definition: Record<string, unknown>,
): boolean {
  return definition.enabled !== false;
}

export function getWorkflowDisplayStatus(
  workflow: Workflow,
): Workflow["status"] | "disabled" {
  if (workflow.status !== "active") {
    return workflow.status;
  }

  return getWorkflowEnabled(workflow.definition) ? workflow.status : "disabled";
}

export function getWorkflowDescription(
  definition: Record<string, unknown>,
): string | null {
  const description = definition.description;
  return typeof description === "string" && description.trim().length > 0
    ? description.trim()
    : null;
}

export function getWorkflowTriggerSummary(
  definition: Record<string, unknown>,
): string | null {
  const trigger = asRecord(definition.trigger);
  if (!trigger) return null;

  const on = trigger.on;
  if (typeof on !== "string") return null;

  const label = TRIGGER_LABELS[on as TriggerType] ?? on;
  switch (on) {
    case "message_posted":
    case "diff_posted":
      return typeof trigger.filter === "string" &&
        trigger.filter.trim().length > 0
        ? `${label} · ${trigger.filter}`
        : label;
    case "reaction_added":
      return typeof trigger.emoji === "string" &&
        trigger.emoji.trim().length > 0
        ? `${label} · ${trigger.emoji}`
        : label;
    case "schedule":
      if (typeof trigger.cron === "string" && trigger.cron.trim().length > 0) {
        return `${label} · ${trigger.cron}`;
      }
      if (
        typeof trigger.interval === "string" &&
        trigger.interval.trim().length > 0
      ) {
        return `${label} · ${trigger.interval}`;
      }
      return label;
    default:
      return label;
  }
}
