import type { TriggerType } from "./workflowFormTypes";

export const CONDITION_OPERATORS = [
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "equals",
  "not_equals",
  "is_not_empty",
  "is_empty",
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

const EXACT_MATCH_OPERATORS = [
  "equals",
  "not_equals",
] as const satisfies readonly ConditionOperator[];

/** IDs and pubkeys are opaque identifiers, so partial string matching is not meaningful. */
export function conditionOperatorsForField(
  field: string,
): readonly ConditionOperator[] {
  return field === "trigger_author" ||
    field === "trigger_emoji" ||
    field.endsWith("_id")
    ? EXACT_MATCH_OPERATORS
    : CONDITION_OPERATORS;
}

export function defaultConditionOperatorForField(
  field: string,
): ConditionOperator {
  return conditionOperatorsForField(field)[0];
}

export type ConditionField = {
  label: string;
  value: string;
};

export type ParsedConditionExpression = {
  field: string;
  operator: ConditionOperator;
  value: string;
  webhookField: string;
};

export const CUSTOM_CONDITION_FIELD = "custom";

const AUTHOR_FIELD: ConditionField = {
  label: "Author",
  value: "trigger_author",
};

const FIELDS_BY_TRIGGER: Record<TriggerType, ConditionField[]> = {
  message_posted: [
    { label: "Message text", value: "trigger_text" },
    AUTHOR_FIELD,
  ],
  diff_posted: [{ label: "Diff text", value: "trigger_text" }, AUTHOR_FIELD],
  reaction_added: [
    { label: "Reaction emoji", value: "trigger_emoji" },
    AUTHOR_FIELD,
    { label: "Message", value: "trigger_message_id" },
  ],
  webhook: [{ label: "Webhook field…", value: "webhook_field" }],
  schedule: [{ label: "Scheduled timestamp", value: "trigger_timestamp" }],
};

export function conditionFieldsForTrigger(
  triggerType: TriggerType,
): ConditionField[] {
  return FIELDS_BY_TRIGGER[triggerType];
}

export function conditionOperatorNeedsValue(
  operator: ConditionOperator,
): boolean {
  return operator !== "is_not_empty" && operator !== "is_empty";
}

function escapeEvalexprString(value: string): string {
  // evalexpr v11 only recognizes escaped quotes and backslashes. Other
  // backslash escapes (including \n and \t) are rejected by its parser.
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function normalizeWebhookField(field: string): string | null {
  const trimmed = field.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return null;
  if (trimmed.startsWith("trigger_") || trimmed.startsWith("steps_")) {
    return null;
  }
  return `trigger_${trimmed}`;
}

export function buildConditionExpression({
  field,
  operator,
  value,
  webhookField,
}: {
  field: string;
  operator: ConditionOperator;
  value: string;
  webhookField?: string;
}): string | null {
  const variable =
    field === "webhook_field"
      ? normalizeWebhookField(webhookField ?? "")
      : field;
  if (!variable) return null;

  if (operator === "is_not_empty") return `str_len(${variable}) > 0`;
  if (operator === "is_empty") return `str_len(${variable}) == 0`;
  if (!value.trim()) return null;

  const quotedValue = `"${escapeEvalexprString(value)}"`;
  switch (operator) {
    case "contains":
      return `str_contains(${variable}, ${quotedValue})`;
    case "not_contains":
      return `!str_contains(${variable}, ${quotedValue})`;
    case "starts_with":
      return `str_starts_with(${variable}, ${quotedValue})`;
    case "ends_with":
      return `str_ends_with(${variable}, ${quotedValue})`;
    case "equals":
      return `${variable} == ${quotedValue}`;
    case "not_equals":
      return `${variable} != ${quotedValue}`;
    default:
      return null;
  }
}

/** Build a conjunction from every complete condition in the form editor. */
export function buildConditionExpressions(
  conditions: ParsedConditionExpression[],
): string {
  return conditions
    .map((condition) => buildConditionExpression(condition))
    .filter((condition): condition is string => condition !== null)
    .join(" && ");
}

function unescapeEvalexprString(value: string): string {
  return value.replaceAll(/\\(["\\])/g, "$1");
}

function parsedField(
  variable: string,
  triggerType: TriggerType,
): Pick<ParsedConditionExpression, "field" | "webhookField"> | null {
  const fields = conditionFieldsForTrigger(triggerType);
  if (fields.some((field) => field.value === variable)) {
    return { field: variable, webhookField: "" };
  }

  if (
    fields.some((field) => field.value === "webhook_field") &&
    variable.startsWith("trigger_")
  ) {
    const webhookField = variable.slice("trigger_".length);
    if (normalizeWebhookField(webhookField) === variable) {
      return { field: "webhook_field", webhookField };
    }
  }

  return null;
}

/** Parse expressions emitted by the condition editor back into form state. */
export function parseConditionExpression(
  expression: string,
  triggerType: TriggerType,
): ParsedConditionExpression | null {
  const trimmed = expression.trim();
  const emptyMatch = /^str_len\(([A-Za-z_][A-Za-z0-9_]*)\) (>|==) 0$/.exec(
    trimmed,
  );
  if (emptyMatch) {
    const field = parsedField(emptyMatch[1], triggerType);
    if (!field) return null;
    return {
      ...field,
      operator: emptyMatch[2] === ">" ? "is_not_empty" : "is_empty",
      value: "",
    };
  }

  const stringLiteral = '"((?:\\\\["\\\\]|[^"\\\\])*)"';
  const functionMatch = new RegExp(
    `^(!)?str_(contains|starts_with|ends_with)\\(([A-Za-z_][A-Za-z0-9_]*), ${stringLiteral}\\)$`,
  ).exec(trimmed);
  if (functionMatch) {
    const field = parsedField(functionMatch[3], triggerType);
    if (!field) return null;
    const operator = functionMatch[1]
      ? "not_contains"
      : functionMatch[2] === "starts_with"
        ? "starts_with"
        : functionMatch[2] === "ends_with"
          ? "ends_with"
          : "contains";
    return {
      ...field,
      operator,
      value: unescapeEvalexprString(functionMatch[4]),
    };
  }

  const equalityMatch = new RegExp(
    `^([A-Za-z_][A-Za-z0-9_]*) (!=|==) ${stringLiteral}$`,
  ).exec(trimmed);
  if (equalityMatch) {
    const field = parsedField(equalityMatch[1], triggerType);
    if (!field) return null;
    return {
      ...field,
      operator: equalityMatch[2] === "==" ? "equals" : "not_equals",
      value: unescapeEvalexprString(equalityMatch[3]),
    };
  }

  return null;
}

function splitTopLevelConjunctions(expression: string): string[] | null {
  const parts: string[] = [];
  let start = 0;
  let parenthesisDepth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "(") {
      parenthesisDepth += 1;
    } else if (character === ")") {
      parenthesisDepth -= 1;
      if (parenthesisDepth < 0) return null;
    } else if (
      character === "&" &&
      expression[index + 1] === "&" &&
      parenthesisDepth === 0
    ) {
      const part = expression.slice(start, index).trim();
      if (!part) return null;
      parts.push(part);
      index += 1;
      start = index + 1;
    }
  }

  if (inString || parenthesisDepth !== 0) return null;
  const finalPart = expression.slice(start).trim();
  if (!finalPart) return null;
  parts.push(finalPart);
  return parts;
}

/** Parse a form-generated `&&` filter back into independently editable fields. */
export function parseConditionExpressions(
  expression: string,
  triggerType: TriggerType,
): ParsedConditionExpression[] | null {
  const trimmed = expression.trim();
  if (!trimmed) return [];

  const parts = splitTopLevelConjunctions(trimmed);
  if (!parts) return null;
  const parsed = parts.map((part) =>
    parseConditionExpression(part, triggerType),
  );
  if (parsed.some((condition) => condition === null)) return null;

  const conditions = parsed.filter(
    (condition): condition is ParsedConditionExpression => condition !== null,
  );
  const fields = new Set(conditions.map((condition) => condition.field));
  return fields.size === conditions.length ? conditions : null;
}
