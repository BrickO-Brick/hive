import { ChevronRight } from "lucide-react";
import * as React from "react";

import { useUsersBatchQuery } from "@/features/profile/hooks";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { Channel, UserProfileSummary } from "@/shared/api/types";
import { truncatePubkey } from "@/shared/lib/pubkey";
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
  equals: "is",
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

type ActiveConditionEditor =
  | { kind: "field"; draft: ParsedConditionExpression }
  | { kind: "custom"; draft: string };

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

function compactValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 18) return trimmed;
  return `${trimmed.slice(0, 10)}…${trimmed.slice(-5)}`;
}

function editorSummary(editor: ParsedConditionExpression): string {
  const operator = operatorLabel(
    editor.field,
    editor.operator,
    conditionOperatorsForField(editor.field).length === 2,
  );
  if (!conditionOperatorNeedsValue(editor.operator)) return operator;
  const value = compactValue(editor.value);
  if (!value) return "Off";
  return editor.field === "trigger_text"
    ? `${operator} “${value}”`
    : `${operator} ${value}`;
}

function authorSummaryLabel(
  pubkey: string,
  profile?: UserProfileSummary | null,
): string {
  return (
    profile?.displayName?.trim() ||
    profile?.name?.trim() ||
    profile?.nip05Handle?.trim() ||
    truncatePubkey(pubkey)
  );
}

function AuthorConditionSummary({
  editor,
  profile,
}: {
  editor: ParsedConditionExpression;
  profile?: UserProfileSummary | null;
}) {
  const label = authorSummaryLabel(editor.value, profile);
  const isExcluded = editor.operator === "not_equals";

  return (
    <span className="flex shrink-0 items-center">
      <span className="relative shrink-0">
        <ProfileAvatar
          avatarUrl={profile?.avatarUrl ?? null}
          className="h-6 w-6"
          iconClassName="h-4 w-4"
          label={label}
        />
        {isExcluded ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
          >
            <span className="absolute inset-0 [clip-path:circle(50%_at_50%_50%)]">
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
                <span className="block h-1 w-9 translate-y-0.5 -rotate-45 rounded-full bg-background/90" />
              </span>
            </span>
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
              <span className="block h-0.5 w-8 -rotate-45 rounded-full bg-muted-foreground" />
            </span>
          </span>
        ) : null}
      </span>
      <span className="sr-only">
        {isExcluded ? "Excluded author: " : "Selected author: "}
        {label}
      </span>
    </span>
  );
}

function ConditionEditorFields({
  channelId,
  disabled,
  editor,
  idPrefix,
  knownAuthorPubkeys,
  onChange,
}: {
  channelId?: string | null;
  disabled?: boolean;
  editor: ParsedConditionExpression;
  idPrefix: string;
  knownAuthorPubkeys: string[];
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
    <div
      className="space-y-3"
      data-testid={`workflow-condition-editor-${editor.field}`}
    >
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
    </div>
  );
}

export function WorkflowConditionBuilder({
  channelId,
  channels,
  disabled,
  idPrefix,
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
  const [activeEditor, setActiveEditor] =
    React.useState<ActiveConditionEditor | null>(null);
  const previousTriggerType = React.useRef(triggerType);
  const selectedAuthorPubkey = editorState.custom
    ? ""
    : (editorState.editors
        .find((editor) => editor.field === "trigger_author")
        ?.value.trim()
        .toLowerCase() ?? "");
  const selectedAuthorProfileQuery = useUsersBatchQuery(
    selectedAuthorPubkey ? [selectedAuthorPubkey] : [],
  );
  const selectedAuthorProfile = selectedAuthorPubkey
    ? selectedAuthorProfileQuery.data?.profiles[selectedAuthorPubkey]
    : undefined;

  React.useEffect(() => {
    if (previousTriggerType.current === triggerType) return;
    previousTriggerType.current = triggerType;
    setEditorState(initialEditorState(value, triggerType));
    setActiveEditor(null);
  }, [triggerType, value]);

  const emitEditors = (editors: ParsedConditionExpression[]) => {
    setEditorState({ custom: false, editors });
    onChange(buildConditionExpressions(editors));
  };

  const evalexprFields = fields
    .map((field) =>
      field.value === "webhook_field" ? "trigger_<JSON field>" : field.value,
    )
    .join(", ");
  const openFieldEditor = (field: (typeof fields)[number]) => {
    if (
      activeEditor?.kind === "field" &&
      activeEditor.draft.field === field.value
    ) {
      setActiveEditor(null);
      return;
    }
    const existing = editorState.editors.find(
      (editor) => editor.field === field.value,
    );
    setActiveEditor({
      kind: "field",
      draft: existing ?? {
        field: field.value,
        operator: defaultConditionOperatorForField(field.value),
        value: "",
        webhookField: "",
      },
    });
  };

  const updateFieldEditor = (draft: ParsedConditionExpression) => {
    const isComplete =
      (draft.field !== "webhook_field" ||
        normalizeWebhookField(draft.webhookField) !== null) &&
      (!conditionOperatorNeedsValue(draft.operator) ||
        draft.value.trim().length > 0);
    setActiveEditor({ kind: "field", draft });
    if (!isComplete) {
      emitEditors(
        editorState.editors.filter((editor) => editor.field !== draft.field),
      );
      return;
    }
    emitEditors(
      editorState.custom
        ? [draft]
        : [
            ...editorState.editors.filter(
              (editor) => editor.field !== draft.field,
            ),
            draft,
          ],
    );
  };

  const updateCustomEditor = (draft: string) => {
    const trimmed = draft.trim();
    setActiveEditor({
      kind: "custom",
      draft,
    });
    if (trimmed) {
      setEditorState({ custom: true, editors: [] });
      onChange(trimmed);
    } else {
      setEditorState({ custom: false, editors: [] });
      onChange("");
    }
  };

  return (
    <div className="divide-y divide-border/50">
      {fields.map((field) => {
        const editor = editorState.custom
          ? undefined
          : editorState.editors.find(
              (candidate) => candidate.field === field.value,
            );
        const isExpanded =
          activeEditor?.kind === "field" &&
          activeEditor.draft.field === field.value;
        return (
          <div key={field.value}>
            <button
              aria-expanded={isExpanded}
              className="flex min-h-12 w-full items-center gap-3 py-3 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              disabled={disabled}
              onClick={() => openFieldEditor(field)}
              type="button"
            >
              <span className="min-w-0 flex-1 truncate text-base font-medium">
                {field.label}
              </span>
              {editor?.field === "trigger_author" ? (
                <AuthorConditionSummary
                  editor={editor}
                  profile={selectedAuthorProfile}
                />
              ) : (
                <span className="max-w-40 truncate text-sm text-muted-foreground">
                  {editor
                    ? editorSummary(editor)
                    : field.value === "trigger_text"
                      ? "Any"
                      : "Off"}
                </span>
              )}
              <ChevronRight
                className={`h-4 w-4 shrink-0 text-muted-foreground/70 transition-transform duration-150 motion-reduce:transition-none ${
                  isExpanded ? "rotate-90" : "rotate-0"
                }`}
              />
            </button>

            {isExpanded ? (
              <div className="animate-in space-y-4 pb-4 pt-1 fade-in slide-in-from-top-1 duration-150 motion-reduce:animate-none">
                <ConditionEditorFields
                  channelId={channelId}
                  disabled={disabled}
                  editor={activeEditor.draft}
                  idPrefix={idPrefix}
                  knownAuthorPubkeys={knownAuthorPubkeys}
                  onChange={updateFieldEditor}
                />
              </div>
            ) : null}
          </div>
        );
      })}

      <div>
        <button
          aria-expanded={activeEditor?.kind === "custom"}
          className="flex min-h-12 w-full items-center gap-3 py-3 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled}
          onClick={() =>
            setActiveEditor((current) =>
              current?.kind === "custom"
                ? null
                : {
                    kind: "custom",
                    draft: editorState.custom ? value : "",
                  },
            )
          }
          type="button"
        >
          <span className="min-w-0 flex-1 truncate text-base font-medium">
            Custom
          </span>
          <span className="max-w-40 truncate text-sm text-muted-foreground">
            {editorState.custom ? compactValue(value) : "Off"}
          </span>
          <ChevronRight
            className={`h-4 w-4 shrink-0 text-muted-foreground/70 transition-transform duration-150 motion-reduce:transition-none ${
              activeEditor?.kind === "custom" ? "rotate-90" : "rotate-0"
            }`}
          />
        </button>

        {activeEditor?.kind === "custom" ? (
          <div className="animate-in space-y-4 pb-4 pt-1 fade-in slide-in-from-top-1 duration-150 motion-reduce:animate-none">
            <div className="space-y-2">
              <FieldLabel htmlFor={`${idPrefix}-custom-expression`}>
                Expression
              </FieldLabel>
              <Input
                autoCapitalize="off"
                autoCorrect="off"
                disabled={disabled}
                id={`${idPrefix}-custom-expression`}
                onChange={(event) => updateCustomEditor(event.target.value)}
                placeholder='e.g. str_contains(trigger_text, "deploy")'
                value={activeEditor.draft}
              />
              <p className="text-xs text-muted-foreground">
                Use an evalexpr expression with <code>{evalexprFields}</code>.
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
