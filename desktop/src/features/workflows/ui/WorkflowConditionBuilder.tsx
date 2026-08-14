import * as React from "react";

import { useIdentityQuery } from "@/shared/api/hooks";
import type { Channel } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Input } from "@/shared/ui/input";
import { AuthorGridPicker } from "./AuthorGridPicker";
import { MessageIdPicker } from "./MessageIdPicker";
import { WorkflowEmojiField } from "./WorkflowEmojiField";
import { FieldLabel, FormSelect } from "./workflowFormPrimitives";
import {
  buildConditionExpressions,
  conditionFieldsForTrigger,
  conditionOperatorsForField,
  conditionOperatorNeedsValue,
  CUSTOM_CONDITION_FIELD,
  defaultConditionOperatorForField,
  normalizeWebhookField,
  parseConditionExpressions,
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

function operatorLabel(
  field: string,
  operator: ConditionOperator,
  usesExactMatchOperators: boolean,
): string {
  if (usesExactMatchOperators && operator === "equals") return "is";
  if (field === "trigger_text") {
    if (operator === "is_not_empty") return "has text";
    if (operator === "is_empty") return "has no text";
  }
  return OPERATOR_LABELS[operator];
}

type ConditionEditorState = {
  custom: boolean;
  editors: ParsedConditionExpression[];
};

function normalizedEditor(
  editor: ParsedConditionExpression,
): ParsedConditionExpression {
  const supportedOperators = conditionOperatorsForField(editor.field);
  return supportedOperators.includes(editor.operator)
    ? editor
    : {
        ...editor,
        operator: defaultConditionOperatorForField(editor.field),
      };
}

function initialEditorState(
  value: string,
  triggerType: TriggerType,
): ConditionEditorState {
  const parsed = parseConditionExpressions(value, triggerType);
  if (parsed) {
    return { custom: false, editors: parsed.map(normalizedEditor) };
  }

  return { custom: value.trim().length > 0, editors: [] };
}

function valueLabel(field: string): string {
  switch (field) {
    case "trigger_author":
      return "Author";
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
    case "trigger_message_id":
      return "Paste a message event ID";
    case "trigger_timestamp":
      return "e.g. 1723507200";
    default:
      return "e.g. deploy";
  }
}

function ConditionEditorControls({
  channelId,
  disabled,
  editor,
  idPrefix,
  knownAuthorPubkeys,
  label,
  onChange,
}: {
  channelId?: string | null;
  disabled?: boolean;
  editor: ParsedConditionExpression;
  idPrefix: string;
  knownAuthorPubkeys: string[];
  label: string;
  onChange: (editor: ParsedConditionExpression) => void;
}) {
  const needsValue = conditionOperatorNeedsValue(editor.operator);
  const operatorOptions = conditionOperatorsForField(editor.field);
  const usesExactMatchOperators = operatorOptions.length === 2;
  const webhookFieldInvalid =
    editor.field === "webhook_field" &&
    editor.webhookField.length > 0 &&
    normalizeWebhookField(editor.webhookField) === null;
  const controlIdPrefix = `${idPrefix}-${editor.field}`;

  return (
    <fieldset
      className="space-y-3 rounded-lg border border-border/60 bg-background/20 p-3"
      data-testid={`workflow-condition-editor-${editor.field}`}
    >
      <legend className="px-1 text-xs font-semibold text-foreground">
        {label}
      </legend>
      <div className="space-y-1.5">
        <FieldLabel htmlFor={`${controlIdPrefix}-operator`}>Match</FieldLabel>
        <FormSelect
          disabled={disabled}
          id={`${controlIdPrefix}-operator`}
          onChange={(operator) =>
            onChange({
              ...editor,
              operator: operator as ConditionOperator,
            })
          }
          value={editor.operator}
        >
          {operatorOptions.map((operator) => (
            <option key={operator} value={operator}>
              {operatorLabel(editor.field, operator, usesExactMatchOperators)}
            </option>
          ))}
        </FormSelect>
      </div>

      {editor.field === "webhook_field" ? (
        <div className="space-y-1.5">
          <FieldLabel htmlFor={`${controlIdPrefix}-webhook-field`}>
            JSON field name
          </FieldLabel>
          <Input
            autoCapitalize="off"
            autoCorrect="off"
            disabled={disabled}
            id={`${controlIdPrefix}-webhook-field`}
            onChange={(event) =>
              onChange({
                ...editor,
                webhookField: event.target.value,
              })
            }
            placeholder="e.g. environment"
            value={editor.webhookField}
          />
          {webhookFieldInvalid ? (
            <p className="text-xs text-destructive">
              Use letters, numbers, and underscores, starting with a letter or
              underscore. Names cannot start with trigger_ or steps_.
            </p>
          ) : null}
        </div>
      ) : null}

      {needsValue ? (
        <div className="space-y-1.5">
          <FieldLabel htmlFor={`${controlIdPrefix}-value`}>
            {editor.field === "webhook_field"
              ? "Value"
              : valueLabel(editor.field)}
          </FieldLabel>
          {editor.field === "trigger_author" ? (
            <AuthorGridPicker
              disabled={disabled}
              id={`${controlIdPrefix}-value`}
              knownPubkeys={knownAuthorPubkeys}
              onChange={(pubkey) => onChange({ ...editor, value: pubkey })}
              value={editor.value}
            />
          ) : editor.field === "trigger_emoji" ? (
            <WorkflowEmojiField
              ariaLabel="Choose condition emoji"
              clearAriaLabel="Clear condition emoji"
              disabled={disabled}
              id={`${controlIdPrefix}-value`}
              onChange={(emoji) => onChange({ ...editor, value: emoji ?? "" })}
              value={editor.value}
            />
          ) : editor.field === "trigger_message_id" ? (
            <MessageIdPicker
              channelId={channelId}
              disabled={disabled}
              id={`${controlIdPrefix}-value`}
              onChange={(messageId) =>
                onChange({ ...editor, value: messageId })
              }
              value={editor.value}
            />
          ) : (
            <Input
              autoCapitalize="off"
              autoCorrect="off"
              disabled={disabled}
              id={`${controlIdPrefix}-value`}
              onChange={(event) =>
                onChange({ ...editor, value: event.target.value })
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
    </fieldset>
  );
}

export function WorkflowConditionBuilder({
  channelId,
  channels,
  disabled,
  idPrefix,
  matchAllLabel = "All events",
  onChange,
  triggerType,
  value,
}: {
  channelId?: string | null;
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
  const [editorState, setEditorState] = React.useState(() =>
    initialEditorState(value, triggerType),
  );
  const previousTriggerType = React.useRef(triggerType);

  React.useEffect(() => {
    if (previousTriggerType.current === triggerType) return;
    previousTriggerType.current = triggerType;
    setEditorState(initialEditorState(value, triggerType));
  }, [triggerType, value]);

  const emitEditors = (editors: ParsedConditionExpression[]) => {
    setEditorState({ custom: false, editors });
    onChange(buildConditionExpressions(editors));
  };

  const updateEditor = (next: ParsedConditionExpression) => {
    emitEditors(
      editorState.editors.map((editor) =>
        editor.field === next.field ? next : editor,
      ),
    );
  };

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
  const selectedFields = new Set(
    editorState.editors.map((editor) => editor.field),
  );

  return (
    <div className="space-y-3">
      <fieldset aria-label="Condition">
        <legend className="sr-only">Condition</legend>
        <div className="grid grid-cols-2 gap-2.5">
          {fieldOptions.map((field) => {
            const isMatchAll = field.value === "";
            const isCustom = field.value === CUSTOM_CONDITION_FIELD;
            const isSelected = isMatchAll
              ? !editorState.custom && editorState.editors.length === 0
              : isCustom
                ? editorState.custom
                : selectedFields.has(field.value);
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
                    if (isMatchAll) {
                      setEditorState({ custom: false, editors: [] });
                      onChange("");
                      return;
                    }
                    if (isCustom) {
                      setEditorState({ custom: true, editors: [] });
                      return;
                    }
                    if (isSelected) {
                      emitEditors(
                        editorState.editors.filter(
                          (editor) => editor.field !== field.value,
                        ),
                      );
                    } else {
                      emitEditors([
                        ...editorState.editors,
                        {
                          field: field.value,
                          operator: defaultConditionOperatorForField(
                            field.value,
                          ),
                          value: "",
                          webhookField: "",
                        },
                      ]);
                    }
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

      {editorState.custom ? (
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
      ) : (
        editorState.editors.map((editor) => (
          <ConditionEditorControls
            channelId={channelId}
            disabled={disabled}
            editor={editor}
            idPrefix={idPrefix}
            key={editor.field}
            knownAuthorPubkeys={knownAuthorPubkeys}
            label={
              fields.find((field) => field.value === editor.field)?.label ??
              editor.field
            }
            onChange={updateEditor}
          />
        ))
      )}
    </div>
  );
}
