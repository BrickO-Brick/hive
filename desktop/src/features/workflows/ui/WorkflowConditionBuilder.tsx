import * as React from "react";

import { useIdentityQuery } from "@/shared/api/hooks";
import type { Channel } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Input } from "@/shared/ui/input";
import { AuthorGridPicker } from "./AuthorGridPicker";
import { ChannelCombobox } from "./ChannelCombobox";
import { WorkflowEmojiField } from "./WorkflowEmojiField";
import { FieldLabel, FormSelect } from "./workflowFormPrimitives";
import {
  buildConditionExpression,
  conditionFieldsForTrigger,
  conditionOperatorNeedsValue,
  CUSTOM_CONDITION_FIELD,
  normalizeWebhookField,
  parseConditionExpression,
} from "./workflowConditionExpression";
import type {
  ConditionOperator,
  ParsedConditionExpression,
} from "./workflowConditionExpression";
import type { TriggerType } from "./workflowFormTypes";

const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  equals: "is exactly",
  not_equals: "is not",
  is_not_empty: "is not empty",
  is_empty: "is empty",
};

function initialEditorState(
  value: string,
  triggerType: TriggerType,
): ParsedConditionExpression {
  const parsed = parseConditionExpression(value, triggerType);
  if (parsed) return parsed;

  return {
    field: value.trim() ? CUSTOM_CONDITION_FIELD : "",
    operator: "contains",
    value: "",
    webhookField: "",
  };
}

function valueLabel(field: string): string {
  switch (field) {
    case "trigger_author":
      return "Pubkey";
    case "trigger_channel_id":
      return "Channel ID";
    case "trigger_message_id":
      return "Message ID";
    case "trigger_emoji":
      return "Emoji";
    case "trigger_timestamp":
      return "Timestamp";
    default:
      return "Text to match";
  }
}

function valuePlaceholder(field: string): string {
  switch (field) {
    case "trigger_author":
      return "Paste a hex pubkey";
    case "trigger_channel_id":
      return "Paste a channel UUID";
    case "trigger_message_id":
      return "Paste a message event ID";
    case "trigger_timestamp":
      return "e.g. 1723507200";
    default:
      return "e.g. deploy";
  }
}

export function WorkflowConditionBuilder({
  channels,
  disabled,
  idPrefix,
  matchAllLabel = "All events",
  onChange,
  triggerType,
  value,
}: {
  channels: Channel[];
  disabled?: boolean;
  idPrefix: string;
  matchAllLabel?: string;
  onChange: (value: string) => void;
  triggerType: TriggerType;
  value: string;
}) {
  const fields = conditionFieldsForTrigger(triggerType);
  const identityQuery = useIdentityQuery();
  const knownAuthorPubkeys = React.useMemo(() => {
    const selfPubkey = identityQuery.data?.pubkey.trim().toLowerCase();
    const rankedPubkeys = new Set<string>();
    const addPubkeys = (pubkeys: string[]) => {
      for (const pubkey of pubkeys) {
        const normalized = pubkey.trim().toLowerCase();
        if (normalized && normalized !== selfPubkey) {
          rankedPubkeys.add(normalized);
        }
      }
    };

    // DM counterparts are the strongest browse-time signal that the user is
    // likely to recognize the author. Group DMs keep participant order and
    // duplicates are removed before the shared-channel tier is appended.
    for (const channel of channels) {
      if (channel.channelType !== "dm") continue;
      addPubkeys(
        channel.participantPubkeys.length > 0
          ? channel.participantPubkeys
          : channel.memberPubkeys,
      );
    }

    for (const channel of channels) {
      if (channel.channelType === "dm") continue;
      addPubkeys(channel.memberPubkeys);
      addPubkeys(channel.participantPubkeys);
    }

    return [...rankedPubkeys];
  }, [channels, identityQuery.data?.pubkey]);
  const [editor, setEditor] = React.useState(() =>
    initialEditorState(value, triggerType),
  );
  const previousTriggerType = React.useRef(triggerType);

  React.useEffect(() => {
    if (previousTriggerType.current === triggerType) return;
    previousTriggerType.current = triggerType;
    setEditor(initialEditorState(value, triggerType));
  }, [triggerType, value]);

  const emitEditor = (next: ParsedConditionExpression) => {
    setEditor(next);
    const expression = buildConditionExpression({
      field: next.field,
      operator: next.operator,
      value: next.value,
      webhookField: next.webhookField,
    });
    onChange(expression ?? "");
  };

  const needsValue = conditionOperatorNeedsValue(editor.operator);
  const webhookFieldInvalid =
    editor.field === "webhook_field" &&
    editor.webhookField.length > 0 &&
    normalizeWebhookField(editor.webhookField) === null;
  const evalexprFields = fields
    .map((field) =>
      field.value === "webhook_field" ? "trigger_<JSON field>" : field.value,
    )
    .join(", ");
  const fieldOptions = [
    { label: matchAllLabel, value: "" },
    ...fields,
    { label: "Custom", value: CUSTOM_CONDITION_FIELD },
  ];

  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="sr-only">Condition</legend>
        <div className="grid grid-cols-2 gap-2.5">
          {fieldOptions.map((field) => {
            const isMatchAll = field.value === "";
            const isCustom = field.value === CUSTOM_CONDITION_FIELD;
            const isSelected = editor.field === field.value;
            return (
              <div
                className={cn(
                  "relative",
                  (isMatchAll || isCustom) && "col-span-2",
                )}
                key={field.value}
              >
                <button
                  aria-pressed={isSelected}
                  className={cn(
                    "flex min-h-12 w-full cursor-pointer items-center justify-center rounded-lg border px-3 py-2 text-center text-sm font-medium",
                    "outline-2 outline-offset-2 outline-transparent transition-[background-color,border-color,color,outline-color]",
                    "focus-visible:ring-2 focus-visible:ring-ring",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    isSelected
                      ? "border-border/0 bg-transparent text-foreground outline-foreground/45"
                      : "border-border/70 bg-background/35 text-muted-foreground hover:border-border hover:bg-muted/55 hover:text-foreground hover:outline-muted-foreground/20",
                  )}
                  disabled={disabled}
                  onClick={() => {
                    if (isSelected) return;
                    if (isMatchAll) {
                      setEditor({
                        field: "",
                        operator: "contains",
                        value: "",
                        webhookField: "",
                      });
                      onChange("");
                      return;
                    }
                    if (isCustom) {
                      setEditor({ ...editor, field: field.value });
                      return;
                    }
                    emitEditor({
                      field: field.value,
                      operator: "contains",
                      value: "",
                      webhookField: "",
                    });
                  }}
                  type="button"
                >
                  {field.label}
                </button>
              </div>
            );
          })}
        </div>
      </fieldset>

      {editor.field === CUSTOM_CONDITION_FIELD ? (
        <div className="space-y-1.5">
          <FieldLabel htmlFor={`${idPrefix}-custom-expression`}>
            Custom expression
          </FieldLabel>
          <Input
            autoCapitalize="off"
            autoCorrect="off"
            disabled={disabled}
            id={`${idPrefix}-custom-expression`}
            onChange={(event) => onChange(event.target.value)}
            placeholder='e.g. str_contains(trigger_text, "deploy")'
            value={value}
          />
          <p className="text-xs text-muted-foreground">
            Use an evalexpr expression with <code>{evalexprFields}</code>.
          </p>
        </div>
      ) : editor.field ? (
        <>
          <div className="space-y-1.5">
            <FieldLabel htmlFor={`${idPrefix}-operator`}>Match</FieldLabel>
            <FormSelect
              disabled={disabled}
              id={`${idPrefix}-operator`}
              onChange={(operator) =>
                emitEditor({
                  ...editor,
                  operator: operator as ConditionOperator,
                })
              }
              value={editor.operator}
            >
              {Object.entries(OPERATOR_LABELS).map(([operator, label]) => (
                <option key={operator} value={operator}>
                  {label}
                </option>
              ))}
            </FormSelect>
          </div>

          {editor.field === "webhook_field" ? (
            <div className="space-y-1.5">
              <FieldLabel htmlFor={`${idPrefix}-webhook-field`}>
                JSON field name
              </FieldLabel>
              <Input
                autoCapitalize="off"
                autoCorrect="off"
                disabled={disabled}
                id={`${idPrefix}-webhook-field`}
                onChange={(event) =>
                  emitEditor({
                    ...editor,
                    webhookField: event.target.value,
                  })
                }
                placeholder="e.g. environment"
                value={editor.webhookField}
              />
              {webhookFieldInvalid ? (
                <p className="text-xs text-destructive">
                  Use letters, numbers, and underscores, starting with a letter
                  or underscore. Names cannot start with trigger_ or steps_.
                </p>
              ) : null}
            </div>
          ) : null}

          {needsValue ? (
            <div className="space-y-1.5">
              <FieldLabel htmlFor={`${idPrefix}-value`}>
                {editor.field === "webhook_field"
                  ? "Value"
                  : valueLabel(editor.field)}
              </FieldLabel>
              {editor.field === "trigger_author" ? (
                <AuthorGridPicker
                  disabled={disabled}
                  id={`${idPrefix}-value`}
                  knownPubkeys={knownAuthorPubkeys}
                  onChange={(pubkey) =>
                    emitEditor({ ...editor, value: pubkey })
                  }
                  value={editor.value}
                />
              ) : editor.field === "trigger_channel_id" ? (
                <ChannelCombobox
                  ariaLabel="Channel ID"
                  channels={channels}
                  disabled={disabled}
                  emptyLabel="Choose a channel"
                  id={`${idPrefix}-value`}
                  onChange={(channelId) =>
                    emitEditor({ ...editor, value: channelId })
                  }
                  value={editor.value}
                  variant="field"
                />
              ) : editor.field === "trigger_emoji" ? (
                <WorkflowEmojiField
                  ariaLabel="Choose condition emoji"
                  clearAriaLabel="Clear condition emoji"
                  disabled={disabled}
                  id={`${idPrefix}-value`}
                  onChange={(emoji) =>
                    emitEditor({ ...editor, value: emoji ?? "" })
                  }
                  value={editor.value}
                />
              ) : (
                <Input
                  autoCapitalize="off"
                  autoCorrect="off"
                  disabled={disabled}
                  id={`${idPrefix}-value`}
                  onChange={(event) =>
                    emitEditor({ ...editor, value: event.target.value })
                  }
                  placeholder={
                    editor.field === "webhook_field"
                      ? "Value to match"
                      : valuePlaceholder(editor.field)
                  }
                  value={editor.value}
                />
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
