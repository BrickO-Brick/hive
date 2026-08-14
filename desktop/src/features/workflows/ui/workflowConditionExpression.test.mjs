import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildConditionExpression,
  buildConditionExpressions,
  conditionFieldsForTrigger,
  conditionOperatorsForField,
  normalizeWebhookField,
  parseConditionExpression,
  parseConditionExpressions,
} from "./workflowConditionExpression.ts";

test("builds the supported string conditions", () => {
  assert.equal(
    buildConditionExpression({
      field: "trigger_text",
      operator: "contains",
      value: "deploy",
    }),
    'str_contains(trigger_text, "deploy")',
  );
  assert.equal(
    buildConditionExpression({
      field: "trigger_text",
      operator: "not_contains",
      value: "draft",
    }),
    '!str_contains(trigger_text, "draft")',
  );
  assert.equal(
    buildConditionExpression({
      field: "trigger_author",
      operator: "equals",
      value: "abc123",
    }),
    'trigger_author == "abc123"',
  );
});

test("escapes values before placing them in an expression", () => {
  assert.equal(
    buildConditionExpression({
      field: "trigger_text",
      operator: "equals",
      value: 'say "hello"\\world',
    }),
    'trigger_text == "say \\"hello\\"\\\\world"',
  );
});

test("builds empty checks without requiring comparison text", () => {
  assert.equal(
    buildConditionExpression({
      field: "trigger_emoji",
      operator: "is_not_empty",
      value: "",
    }),
    "str_len(trigger_emoji) > 0",
  );
});

test("normalizes safe webhook fields and rejects reserved or invalid names", () => {
  assert.equal(normalizeWebhookField("environment"), "trigger_environment");
  assert.equal(normalizeWebhookField("deploy_id"), "trigger_deploy_id");
  assert.equal(normalizeWebhookField("trigger_text"), null);
  assert.equal(normalizeWebhookField("bad-name"), null);
});

test("shows trigger-relevant fields", () => {
  assert.deepEqual(
    conditionFieldsForTrigger("reaction_added").map((field) => field.value),
    ["trigger_emoji", "trigger_author", "trigger_message_id"],
  );
  assert.equal(conditionFieldsForTrigger("webhook")[0].value, "webhook_field");
  for (const triggerType of ["message_posted", "diff_posted"]) {
    assert.equal(
      conditionFieldsForTrigger(triggerType).some(
        (field) => field.value === "trigger_message_id",
      ),
      false,
    );
  }
  for (const triggerType of [
    "message_posted",
    "diff_posted",
    "reaction_added",
    "webhook",
    "schedule",
  ]) {
    assert.equal(
      conditionFieldsForTrigger(triggerType).some(
        (field) => field.value === "trigger_channel_id",
      ),
      false,
    );
  }
});

test("limits opaque identifiers to equality operators", () => {
  for (const field of [
    "trigger_author",
    "trigger_emoji",
    "trigger_channel_id",
    "trigger_message_id",
    "future_resource_id",
  ]) {
    assert.deepEqual(conditionOperatorsForField(field), [
      "equals",
      "not_equals",
    ]);
  }
  assert.equal(conditionOperatorsForField("trigger_text").length, 8);
});

test("parses generated conditions back into editor fields", () => {
  assert.deepEqual(
    parseConditionExpression(
      'str_contains(trigger_text, "deploy \\"buzz\\"")',
      "message_posted",
    ),
    {
      field: "trigger_text",
      operator: "contains",
      value: 'deploy "buzz"',
      webhookField: "",
    },
  );
  assert.deepEqual(
    parseConditionExpression('trigger_environment == "prod"', "webhook"),
    {
      field: "webhook_field",
      operator: "equals",
      value: "prod",
      webhookField: "environment",
    },
  );
});

test("builds and parses multiple trigger conditions joined by AND", () => {
  const conditions = [
    {
      field: "trigger_emoji",
      operator: "equals",
      value: "👾",
      webhookField: "",
    },
    {
      field: "trigger_author",
      operator: "equals",
      value: "a".repeat(64),
      webhookField: "",
    },
    {
      field: "trigger_message_id",
      operator: "equals",
      value: "b".repeat(64),
      webhookField: "",
    },
  ];
  const expression = buildConditionExpressions(conditions);

  assert.equal(
    expression,
    `trigger_emoji == "👾" && trigger_author == "${"a".repeat(64)}" && trigger_message_id == "${"b".repeat(64)}"`,
  );
  assert.deepEqual(
    parseConditionExpressions(expression, "reaction_added"),
    conditions,
  );
});

test("does not split conjunction text inside strings or nested expressions", () => {
  assert.deepEqual(
    parseConditionExpressions(
      'str_contains(trigger_text, "one && two") && trigger_author == "abc"',
      "message_posted",
    ),
    [
      {
        field: "trigger_text",
        operator: "contains",
        value: "one && two",
        webhookField: "",
      },
      {
        field: "trigger_author",
        operator: "equals",
        value: "abc",
        webhookField: "",
      },
    ],
  );
  assert.equal(
    parseConditionExpressions(
      '(trigger_emoji == "👾" && trigger_author == "abc")',
      "reaction_added",
    ),
    null,
  );
});

test("keeps unsupported expressions in custom mode", () => {
  assert.equal(
    parseConditionExpression("trigger_timestamp > 0", "message_posted"),
    null,
  );
  assert.equal(
    parseConditionExpression('trigger_emoji == "👍"', "message_posted"),
    null,
  );
});
