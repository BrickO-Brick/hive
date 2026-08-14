import { truncatePubkey } from "@/shared/lib/pubkey";
import { parseConditionExpressions } from "./workflowConditionExpression";
import { TRIGGER_LABELS } from "./workflowFormTypes";
import type { ParsedConditionExpression } from "./workflowConditionExpression";
import type { TriggerConfig } from "./workflowFormTypes";

const EVENT_PHRASES = {
  diff_posted: "Diff posted",
  message_posted: "Message posted",
  reaction_added: "Reaction added",
} as const;

export const TRIGGER_MESSAGE_LOADING_LABEL = "loading message";

function quotedValue(value: string): string {
  const normalized = value.trim().replaceAll(/\s+/g, " ");
  const abbreviated =
    normalized.length > 36 ? `${normalized.slice(0, 33)}...` : normalized;
  return `“${abbreviated}”`;
}

function messageReference(
  condition: ParsedConditionExpression,
  messageLabel?: string,
  messageLoading?: boolean,
): string {
  if (messageLoading) return TRIGGER_MESSAGE_LOADING_LABEL;
  return messageLabel
    ? quotedValue(messageLabel)
    : truncatePubkey(condition.value);
}

function textConditionDescription(
  eventPhrase: string,
  condition: ParsedConditionExpression,
): string {
  const value = quotedValue(condition.value);
  switch (condition.operator) {
    case "contains":
      return `${eventPhrase} containing ${value}`;
    case "not_contains":
      return `${eventPhrase} without ${value}`;
    case "starts_with":
      return `${eventPhrase} starting with ${value}`;
    case "ends_with":
      return `${eventPhrase} ending with ${value}`;
    case "equals":
      return `${eventPhrase} matching ${value}`;
    case "not_equals":
      return `${eventPhrase} not matching ${value}`;
    case "is_not_empty":
      return `Non-empty ${eventPhrase.toLowerCase()}`;
    case "is_empty":
      return `Empty ${eventPhrase.toLowerCase()}`;
  }
}

/** Build the concise trigger summary rendered on the workflow canvas. */
export function workflowTriggerDescription(
  trigger: TriggerConfig,
  options: {
    authorLabel?: string;
    messageLabel?: string;
    messageLoading?: boolean;
  } = {},
): string {
  const baseLabel = TRIGGER_LABELS[trigger.on];
  const eventPhrase = EVENT_PHRASES[trigger.on as keyof typeof EVENT_PHRASES];
  if (!eventPhrase) return baseLabel;

  const conditions = trigger.filter
    ? parseConditionExpressions(trigger.filter, trigger.on)
    : [];
  if (!conditions || conditions.length === 0) {
    return trigger.on === "reaction_added" && trigger.emoji
      ? eventPhrase
      : baseLabel;
  }

  const condition = conditions[0];

  if (conditions.length > 1) {
    const authorCondition = conditions.find(
      ({ field }) => field === "trigger_author",
    );
    const textCondition = conditions.find(
      ({ field }) => field === "trigger_text",
    );
    const emojiCondition = conditions.find(
      ({ field }) => field === "trigger_emoji",
    );
    const messageCondition = conditions.find(
      ({ field }) => field === "trigger_message_id",
    );
    let description = textCondition
      ? textConditionDescription(eventPhrase, textCondition)
      : eventPhrase;

    if (emojiCondition) {
      description =
        emojiCondition.operator === "not_equals"
          ? `Any reaction except ${emojiCondition.value} added`
          : eventPhrase;
    }
    if (authorCondition) {
      const author =
        options.authorLabel ?? truncatePubkey(authorCondition.value);
      description +=
        authorCondition.operator === "not_equals"
          ? ` by anyone except ${author}`
          : ` by ${author}`;
    }
    if (messageCondition) {
      const message = messageReference(
        messageCondition,
        options.messageLabel,
        options.messageLoading,
      );
      description +=
        messageCondition.operator === "not_equals"
          ? ` anywhere except ${message}`
          : ` to ${message}`;
    }
    return description;
  }

  if (condition.field === "trigger_author") {
    const author = options.authorLabel ?? truncatePubkey(condition.value);
    return condition.operator === "not_equals"
      ? `${eventPhrase} by anyone except ${author}`
      : `${eventPhrase} by ${author}`;
  }

  if (condition.field === "trigger_text") {
    return textConditionDescription(eventPhrase, condition);
  }

  if (condition.field === "trigger_emoji") {
    return condition.operator === "not_equals"
      ? `Any reaction except ${condition.value} added`
      : eventPhrase;
  }

  if (condition.field === "trigger_message_id") {
    const message = messageReference(
      condition,
      options.messageLabel,
      options.messageLoading,
    );
    return condition.operator === "not_equals"
      ? `Reaction added anywhere except ${message}`
      : `Reaction added to ${message}`;
  }

  return baseLabel;
}
