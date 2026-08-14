import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const TRIGGER_OPTION_LABELS: Record<string, string> = {
  diff_posted: "Diff posted",
  message_posted: "Message posted",
  reaction_added: "Reaction added",
  schedule: "Schedule",
  webhook: "Webhook",
};

const WORKFLOW_AUTHOR_DIRECTORY = Array.from({ length: 60 }, (_, index) => {
  const memberNumber = index + 1;
  return {
    pubkey: (10_000 + memberNumber).toString(16).padStart(64, "0"),
    displayName: `Workflow member ${memberNumber.toString().padStart(2, "0")}`,
  };
});
const PROFILELESS_WORKFLOW_MEMBER = "abcdef12".padEnd(64, "3");

test.beforeEach(async ({ page }, testInfo) => {
  const needsLargeAuthorDirectory =
    testInfo.title ===
    "chooses a trigger author condition from live user search";
  await installMockBridge(
    page,
    needsLargeAuthorDirectory
      ? {
          additionalRelayMembers: WORKFLOW_AUTHOR_DIRECTORY.map(
            ({ pubkey }) => ({ pubkey }),
          ).concat({ pubkey: PROFILELESS_WORKFLOW_MEMBER }),
          searchProfiles: WORKFLOW_AUTHOR_DIRECTORY,
        }
      : undefined,
  );
});

async function navigateToWorkflows(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("open-workflows-view").click();
  await expect(page).toHaveURL(/#\/workflows$/);
  await expect(page.getByTestId("workflows-view")).toBeVisible();
}

async function selectFirstChannel(dialog: import("@playwright/test").Locator) {
  await dialog.getByRole("combobox", { name: "Channel" }).click();
  await dialog
    .getByTestId("channel-combobox-list")
    .getByRole("button")
    .first()
    .click();
}

async function expectUnsupportedActionWarnings(
  menu: import("@playwright/test").Locator,
) {
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Delay",
    "Send Message",
    "Call Webhook",
    "Send DM",
    "Request Approval",
    "Add Reaction",
    "Set Channel Topic",
  ]);

  for (const label of [
    "Send DM",
    "Request Approval",
    "Add Reaction",
    "Set Channel Topic",
  ]) {
    await expect(
      menu
        .getByRole("menuitem", { name: label })
        .getByRole("img", { name: "Not supported yet" }),
    ).toBeVisible();
  }

  for (const label of ["Delay", "Send Message", "Call Webhook"]) {
    await expect(
      menu
        .getByRole("menuitem", { name: label, exact: true })
        .getByRole("img", { name: "Not supported yet" }),
    ).toHaveCount(0);
  }
}

async function createWorkflow(
  page: import("@playwright/test").Page,
  name: string,
  options?: {
    description?: string;
    enabled?: boolean;
    trigger?: string;
    triggerCondition?: string;
    stepName?: string;
    stepTimeoutSecs?: string;
  },
) {
  await page.getByRole("button", { name: "Create Workflow" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Choose a channel")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Create workflow" }),
  ).toBeDisabled();
  await selectFirstChannel(dialog);

  await dialog.getByLabel("Workflow name").fill(name);
  if (options?.description) {
    await dialog.getByLabel("Description (optional)").fill(options.description);
  }
  if (options?.enabled === false) {
    await dialog.getByLabel("Enable").click();
  }
  if (options?.trigger) {
    await dialog.getByRole("button", { name: /^Trigger:/ }).click();
    await dialog.getByLabel("Trigger event").click();
    await page
      .getByRole("menuitem", { name: TRIGGER_OPTION_LABELS[options.trigger] })
      .click();
  }
  if (options?.triggerCondition) {
    await dialog.getByRole("button", { name: /^Trigger:/ }).click();
    await dialog
      .getByRole("group", { name: "Condition" })
      .getByRole("button", { name: "Custom" })
      .click();
    await dialog.getByLabel("Custom expression").fill(options.triggerCondition);
  }

  await dialog.getByRole("button", { name: "Add step" }).click();
  await page.getByRole("menuitem", { name: "Delay" }).click();
  if (options?.stepName) {
    await dialog.getByLabel("Name (optional)").fill(options.stepName);
  }
  if (options?.stepTimeoutSecs) {
    await dialog.getByLabel("Timeout (seconds)").fill(options.stepTimeoutSecs);
  }

  await dialog.getByRole("button", { name: "Create workflow" }).click();

  await expect(
    page.getByRole("heading", { name: "Create workflow" }),
  ).not.toBeVisible();
}

test("navigates to workflows view and shows empty state", async ({ page }) => {
  await navigateToWorkflows(page);

  await expect(page.getByText("No workflows yet")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create your first workflow" }),
  ).toBeVisible();
});

test("creates a workflow via the form builder", async ({ page }) => {
  const workflowName = `test_workflow_${Date.now()}`;

  await navigateToWorkflows(page);
  await createWorkflow(page, workflowName);

  // Verify workflow appears in the list
  await expect(page.getByTestId("workflows-view")).toContainText(workflowName);
});

test("disables autocapitalization in the workflow form", async ({ page }) => {
  await navigateToWorkflows(page);

  await page.getByRole("button", { name: "Create Workflow" }).click();
  const dialog = page.getByRole("dialog");

  await expect(dialog.getByLabel("Workflow name")).toHaveAttribute(
    "autocapitalize",
    "off",
  );

  await dialog.getByRole("button", { name: "Add step" }).click();
  await page.getByRole("menuitem", { name: "Delay" }).click();
  await expect(dialog.getByLabel("Name (optional)")).toHaveAttribute(
    "autocapitalize",
    "off",
  );
});

test("configures common schedules and exposes custom cron", async ({
  page,
}) => {
  await navigateToWorkflows(page);

  await page.getByRole("button", { name: "Create Workflow" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Trigger:/ }).click();
  const inspector = dialog.getByTestId("workflow-node-inspector");
  await inspector.getByLabel("Trigger event").click();
  await page.getByRole("menuitem", { name: "Schedule" }).click();

  const repeatOptions = inspector.getByRole("radio");
  await expect(repeatOptions).toHaveCount(7);
  await expect(repeatOptions.first()).toHaveAccessibleName("Every 15 minutes");
  await expect(repeatOptions.last()).toHaveAccessibleName("Custom");
  await expect(inspector.getByRole("radio", { name: "Daily" })).toBeChecked();
  await expect(inspector.getByLabel("Run time (UTC)")).toHaveValue("09:00");

  await inspector.getByText("Monthly", { exact: true }).click();
  await inspector.getByLabel("Day of month").selectOption("31");
  await expect(
    inspector.getByText("This schedule won’t run in some months."),
  ).toBeVisible();
  await dialog.getByRole("tab", { name: "YAML" }).click();
  await expect(dialog.getByLabel("Workflow YAML")).toHaveValue(
    /cron: 0 9 31 \* \*/,
  );
  await dialog.getByRole("tab", { name: "Form" }).click();
  await dialog.getByRole("button", { name: /^Trigger:/ }).click();

  await inspector.getByText("Weekly", { exact: true }).click();
  const weekdayPicker = inspector.getByRole("group", { name: "Repeat on" });
  await weekdayPicker.getByText("T", { exact: true }).nth(1).click();
  await expect(
    weekdayPicker.getByRole("checkbox", { name: "Monday" }),
  ).toBeChecked();
  await expect(
    weekdayPicker.getByRole("checkbox", { name: "Thursday" }),
  ).toBeChecked();
  await inspector.getByLabel("Run time (UTC)").fill("14:30");
  await dialog.getByRole("tab", { name: "YAML" }).click();
  await expect(dialog.getByLabel("Workflow YAML")).toHaveValue(
    /cron: 30 14 \* \* 1,4/,
  );
  await dialog.getByRole("tab", { name: "Form" }).click();
  await dialog.getByRole("button", { name: /^Trigger:/ }).click();
  await dialog.getByText("Custom", { exact: true }).click();
  const cronInput = inspector.getByRole("group", { name: "Cron expression" });
  const minuteField = cronInput.getByRole("textbox", { name: "Minute" });
  await expect(cronInput).toBeVisible();
  await expect(minuteField).toHaveValue("30");
  await expect(cronInput.getByRole("textbox", { name: "Hour" })).toHaveValue(
    "14",
  );
  await expect(cronInput.getByRole("textbox", { name: "Weekday" })).toHaveValue(
    "1,4",
  );

  await minuteField.fill("60");
  await expect(
    inspector.getByText("Minute must be between 0 and 59."),
  ).toBeVisible();

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("0 */2 * * 1,3,5"));
  await minuteField.press("ControlOrMeta+V");
  await expect(minuteField).toHaveValue("0");
  await expect(cronInput.getByRole("textbox", { name: "Hour" })).toHaveValue(
    "*/2",
  );
  await expect(cronInput.getByRole("textbox", { name: "Weekday" })).toHaveValue(
    "1,3,5",
  );

  await dialog.getByRole("tab", { name: "YAML" }).click();
  await expect(dialog.getByLabel("Workflow YAML")).toHaveValue(
    /cron: 0 \*\/2 \* \* 1,3,5/,
  );
});

test("builds a valid trigger condition from plain-language choices", async ({
  page,
}) => {
  await navigateToWorkflows(page);

  await page.getByRole("button", { name: "Create Workflow" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Trigger:/ }).click();
  const inspector = dialog.getByTestId("workflow-node-inspector");

  const conditionFields = inspector.getByRole("group", { name: "Condition" });
  const conditionOptions = conditionFields.getByRole("button");
  await expect(conditionOptions).toHaveCount(4);
  const allMessages = conditionFields.getByRole("button", {
    name: "All messages",
  });
  await expect(allMessages).toHaveAttribute("aria-pressed", "true");
  await allMessages.click();
  await expect(allMessages).toHaveAttribute("aria-pressed", "true");
  await expect(
    conditionFields.getByRole("button", { name: "Message text" }),
  ).toHaveAttribute("aria-pressed", "false");
  for (const name of ["Author", "Custom"]) {
    await expect(conditionFields.getByRole("button", { name })).toBeVisible();
  }
  for (const name of ["Channel ID", "Message ID"]) {
    await expect(conditionFields.getByRole("button", { name })).toHaveCount(0);
  }

  await conditionFields.getByRole("button", { name: "Message text" }).click();
  await expect(allMessages).toHaveAttribute("aria-pressed", "false");
  const matchSelect = inspector.getByLabel("Match");
  await expect(matchSelect.locator('option[value="is_not_empty"]')).toHaveText(
    "has text",
  );
  await expect(matchSelect.locator('option[value="is_empty"]')).toHaveText(
    "has no text",
  );
  await inspector.getByLabel("Text to match").fill('deploy "buzz"');
  await dialog.getByRole("tab", { name: "YAML" }).click();
  await expect(dialog.getByLabel("Workflow YAML")).toHaveValue(
    /str_contains\(trigger_text, "deploy \\"buzz\\""\)/,
  );

  await dialog.getByRole("tab", { name: "Form" }).click();
  await dialog.getByRole("button", { name: /^Trigger:/ }).click();
  const roundTrippedFields = inspector.getByRole("group", {
    name: "Condition",
  });
  await expect(
    roundTrippedFields.getByRole("button", { name: "Message text" }),
  ).toHaveAttribute("aria-pressed", "true");
  const customCondition = roundTrippedFields.getByRole("button", {
    name: "Custom",
  });
  await customCondition.click();
  await expect(inspector.getByLabel("Custom expression")).toHaveValue(
    'str_contains(trigger_text, "deploy \\"buzz\\"")',
  );
  await expect(inspector.getByText(/Use an evalexpr expression/)).toBeVisible();
  await customCondition.click();
  await expect(customCondition).toHaveAttribute("aria-pressed", "true");
  await expect(inspector.getByLabel("Custom expression")).toBeVisible();
  await roundTrippedFields
    .getByRole("button", { name: "All messages" })
    .click();
  await expect(customCondition).toHaveAttribute("aria-pressed", "false");
  await expect(inspector.getByLabel("Custom expression")).not.toBeVisible();
});

test("keeps a step condition separate from its action configuration", async ({
  page,
}) => {
  await navigateToWorkflows(page);

  await page.getByRole("button", { name: "Create Workflow" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add step" }).click();
  await page.getByRole("menuitem", { name: "Send Message" }).click();

  const inspector = dialog.getByTestId("workflow-node-inspector");
  await expect(inspector.getByLabel("Message text")).toBeVisible();
  await expect(
    inspector.getByRole("heading", { name: "Step condition" }),
  ).toBeVisible();
  await inspector.getByRole("button", { name: "Message text" }).click();
  await inspector.getByLabel("Text to match").fill("deploy");

  await dialog.getByRole("tab", { name: "YAML" }).click();
  await expect(dialog.getByLabel("Workflow YAML")).toHaveValue(
    /if: str_contains\(trigger_text, "deploy"\)/,
  );
});

test("chooses a trigger author condition from live user search", async ({
  page,
}) => {
  await navigateToWorkflows(page);

  await page.getByRole("button", { name: "Create Workflow" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Trigger:/ }).click();
  const inspector = dialog.getByTestId("workflow-node-inspector");

  await inspector.getByRole("button", { name: "Author" }).click();
  const authorPicker = inspector.getByTestId("author-grid-picker");
  await expect(authorPicker).toBeVisible();
  await expect
    .poll(() =>
      authorPicker
        .locator("fieldset")
        .evaluate(
          (element) =>
            getComputedStyle(element)
              .gridTemplateColumns.split(" ")
              .filter(Boolean).length,
        ),
    )
    .toBe(3);
  const authorList = authorPicker.getByTestId("author-grid-list");
  const authorResults = page.getByTestId(/^workflow-author-result-/);
  await expect.poll(() => authorResults.count()).toBeGreaterThanOrEqual(50);
  await expect
    .poll(() =>
      authorResults.evaluateAll((elements) =>
        elements
          .slice(0, 3)
          .map((element) =>
            element
              .getAttribute("data-testid")
              ?.replace("workflow-author-result-", ""),
          ),
      ),
    )
    .toEqual([
      TEST_IDENTITIES.alice.pubkey,
      TEST_IDENTITIES.bob.pubkey,
      TEST_IDENTITIES.charlie.pubkey,
    ]);
  await authorList.hover();
  await page.mouse.wheel(0, 10_000);
  await expect.poll(() => authorResults.count()).toBeGreaterThan(60);

  await page
    .getByPlaceholder("Search people or paste a public key...")
    .fill("abcdef12");
  await expect(
    page.getByTestId(`workflow-author-result-${PROFILELESS_WORKFLOW_MEMBER}`),
  ).toBeVisible();

  await page
    .getByPlaceholder("Search people or paste a public key...")
    .fill("charlie");
  await expect(authorList.getByText("charlie", { exact: true })).toBeVisible();

  await page
    .getByPlaceholder("Search people or paste a public key...")
    .fill("outsider");
  await expect(
    page.getByTestId(
      `workflow-author-result-${TEST_IDENTITIES.outsider.pubkey}`,
    ),
  ).toBeVisible();

  await page
    .getByPlaceholder("Search people or paste a public key...")
    .fill("Workflow");
  await expect(authorResults).toHaveCount(50);
  await page.getByRole("button", { name: "Load more authors" }).click();
  await expect(authorResults).toHaveCount(60);

  await page
    .getByPlaceholder("Search people or paste a public key...")
    .fill("Workflow member 59");
  const selectedAuthor = page.getByTestId(
    `workflow-author-result-${WORKFLOW_AUTHOR_DIRECTORY[58].pubkey}`,
  );
  await selectedAuthor.click();
  await expect(selectedAuthor).toHaveAttribute("aria-pressed", "true");
  const triggerNode = dialog.getByRole("button", {
    name: "Trigger: Message posted by Workflow member 59",
  });
  await expect(triggerNode).toBeVisible();
  await expect(
    triggerNode.getByTestId("workflow-trigger-icon-message_posted"),
  ).toBeVisible();
  await expect(
    triggerNode.locator('[data-testid^="workflow-trigger-author-avatar-"]'),
  ).toBeVisible();

  await dialog.getByRole("tab", { name: "YAML" }).click();
  await expect(dialog.getByLabel("Workflow YAML")).toHaveValue(
    /trigger_author\s+==\s+"[0-9a-f]{64}"/,
  );
});

test("chooses and clears a reaction trigger with the app emoji picker", async ({
  page,
}) => {
  await navigateToWorkflows(page);

  await page.getByRole("button", { name: "Create Workflow" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Trigger:/ }).click();
  const inspector = dialog.getByTestId("workflow-node-inspector");
  await inspector.getByLabel("Trigger event").click();
  await page.getByRole("menuitem", { name: "Reaction added" }).click();
  await inspector.getByRole("button", { name: "Reaction emoji" }).click();

  const trigger = inspector.getByRole("button", {
    name: "Choose condition emoji",
  });
  await expect(trigger).toContainText("Choose a reaction");
  await trigger.click();

  const picker = page.locator("em-emoji-picker");
  await picker.locator("input[type='search']").fill("buzz");
  await picker.getByRole("button", { name: ":buzz:" }).first().click();

  await expect(trigger).toContainText(":buzz:");
  const triggerNode = dialog.getByRole("button", {
    name: "Trigger: Reaction added",
  });
  await expect(triggerNode).toBeVisible();
  await expect(
    triggerNode.getByTestId("workflow-trigger-selected-reaction"),
  ).toHaveAttribute("alt", ":buzz:");
  await dialog.getByRole("tab", { name: "YAML" }).click();
  await expect(dialog.getByLabel("Workflow YAML")).toHaveValue(/:buzz:/);

  await dialog.getByRole("tab", { name: "Form" }).click();
  await dialog.getByRole("button", { name: /^Trigger:/ }).click();
  await dialog.getByRole("button", { name: "Clear condition emoji" }).click();
  await expect(
    dialog.getByRole("button", { name: "Choose condition emoji" }),
  ).toContainText("Choose a reaction");
  await expect(
    dialog
      .getByRole("button", { name: "Trigger: Reaction added" })
      .getByTestId("workflow-trigger-icon-reaction_added"),
  ).toBeVisible();
});

test("chooses an add-reaction step emoji with the app emoji picker", async ({
  page,
}) => {
  await navigateToWorkflows(page);

  await page.getByRole("button", { name: "Create Workflow" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add step" }).click();
  await expectUnsupportedActionWarnings(page.getByRole("menu"));
  await page.getByRole("menuitem", { name: "Add Reaction" }).click();

  const inspector = dialog.getByTestId("workflow-node-inspector");
  await expect(inspector).toContainText(
    "Backend note: `add_reaction` is not executed yet, so runs fail at this step.",
  );
  await inspector.getByRole("button", { name: "Action", exact: true }).click();
  await expectUnsupportedActionWarnings(page.getByRole("menu"));
  await page.keyboard.press("Escape");
  const stepEmoji = inspector.getByRole("button", {
    name: "Choose reaction emoji",
  });
  await expect(stepEmoji).toContainText("Choose a reaction");
  await stepEmoji.click();

  const picker = page.locator("em-emoji-picker");
  await picker.locator("input[type='search']").fill("buzz");
  await picker.getByRole("button", { name: ":buzz:" }).first().click();

  await expect(stepEmoji).toContainText(":buzz:");
  await dialog.getByRole("tab", { name: "YAML" }).click();
  await expect(dialog.getByLabel("Workflow YAML")).toHaveValue(
    /action: add_reaction[\s\S]*emoji: ":buzz:"/,
  );
});

test("chooses a reaction emoji condition with the app emoji picker", async ({
  page,
}) => {
  await navigateToWorkflows(page);

  await page.getByRole("button", { name: "Create Workflow" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Trigger:/ }).click();
  let inspector = dialog.getByTestId("workflow-node-inspector");
  await inspector.getByLabel("Trigger event").click();
  await page.getByRole("menuitem", { name: "Reaction added" }).click();

  inspector = dialog.getByTestId("workflow-node-inspector");
  await expect(
    inspector.getByRole("button", { name: "Message ID" }),
  ).toBeVisible();
  await expect(
    inspector.getByRole("button", { name: "Channel ID" }),
  ).toHaveCount(0);
  await inspector.getByRole("button", { name: "Reaction emoji" }).click();

  const conditionEmoji = inspector.getByRole("button", {
    name: "Choose condition emoji",
  });
  await conditionEmoji.click();
  const picker = page.locator("em-emoji-picker");
  await picker.locator("input[type='search']").fill("buzz");
  await picker.getByRole("button", { name: ":buzz:" }).first().click();

  await expect(conditionEmoji).toContainText(":buzz:");
  await dialog.getByRole("tab", { name: "YAML" }).click();
  await expect(dialog.getByLabel("Workflow YAML")).toHaveValue(
    /filter: trigger_emoji == ":buzz:"/,
  );
});

test("chooses a reacted-to message from the workflow channel", async ({
  page,
}) => {
  await navigateToWorkflows(page);

  await page.getByRole("button", { name: "Create Workflow" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Channel" }).click();
  await dialog
    .getByTestId("channel-combobox-list")
    .getByRole("button", { name: /general/i })
    .click();
  const inspector = dialog.getByTestId("workflow-node-inspector");
  await inspector.getByLabel("Trigger event").click();
  await page.getByRole("menuitem", { name: "Reaction added" }).click();
  const emojiField = inspector.getByRole("button", {
    name: "Reaction emoji",
  });
  const authorField = inspector.getByRole("button", { name: "Author" });
  const messageField = inspector.getByRole("button", { name: "Message ID" });

  await emojiField.click();
  await inspector
    .getByRole("button", { name: "Choose condition emoji" })
    .click();
  const emojiPicker = page.locator("em-emoji-picker");
  await emojiPicker.locator("input[type='search']").fill("buzz");
  await emojiPicker.getByRole("button", { name: ":buzz:" }).first().click();

  await authorField.click();
  await page
    .getByTestId(`workflow-author-result-${TEST_IDENTITIES.alice.pubkey}`)
    .click();

  await messageField.click();

  const search = inspector.getByLabel("Search messages or paste a message ID");
  const messageList = inspector.getByTestId("message-id-picker-list");
  await expect(search).toBeVisible();
  await expect(messageList).toHaveCSS("overflow-y", "auto");
  await expect(
    messageList.getByRole("button", { name: /Hey team — checking in\./ }),
  ).toBeVisible();

  await search.fill("custom emoji");
  const targetMessage = messageList.getByRole("button", {
    name: /React to me with a custom emoji/,
  });
  await expect(targetMessage).toBeVisible();
  await targetMessage.click();

  for (const field of [emojiField, authorField, messageField]) {
    await expect(field).toHaveAttribute("aria-pressed", "true");
  }
  await expect(
    dialog.getByRole("button", {
      name: "Trigger: Reaction added by alice to “React to me with a custom emoji”",
    }),
  ).toBeVisible();

  await dialog.getByRole("tab", { name: "YAML" }).click();
  const workflowYaml = dialog.getByLabel("Workflow YAML");
  await expect(workflowYaml).toHaveValue(
    /filter: trigger_emoji == ":buzz:" && trigger_author ==\s+"[0-9a-f]{64}" &&\s+trigger_message_id ==\s+"[0-9a-f]{64}"/,
  );
  await expect(workflowYaml).toHaveValue(
    new RegExp(TEST_IDENTITIES.alice.pubkey),
  );
});

test("switches an empty workflow between form and YAML modes", async ({
  page,
}) => {
  await navigateToWorkflows(page);

  await page.getByRole("button", { name: "Create Workflow" }).click();
  const dialog = page.getByRole("dialog");

  await dialog.getByRole("tab", { name: "YAML" }).click();
  await expect(dialog.getByLabel("Workflow YAML")).toBeVisible();

  await dialog.getByRole("tab", { name: "Form" }).click();
  await expect(dialog.getByLabel("Workflow name")).toBeVisible();
});

test("confirms before discarding workflow changes", async ({ page }) => {
  await navigateToWorkflows(page);

  await page.getByRole("button", { name: "Create Workflow" }).click();
  const dialog = page.getByRole("dialog", { name: "Create workflow" });
  await dialog.getByLabel("Workflow name").fill("unfinished_workflow");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("Discard changes?");
  await confirmation.getByRole("button", { name: "Keep editing" }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(dialog.getByLabel("Workflow name")).toHaveValue(
    "unfinished_workflow",
  );

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await confirmation.getByRole("button", { name: "Discard changes" }).click();
  await expect(dialog).not.toBeVisible();
});

test("scrolls the channel list with the mouse wheel", async ({ page }) => {
  await navigateToWorkflows(page);

  await page.getByRole("button", { name: "Create Workflow" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Channel" }).click();

  const channelList = page.getByTestId("channel-combobox-list");
  await expect(channelList).toBeVisible();
  await channelList.hover();
  await page.mouse.wheel(0, 500);

  await expect
    .poll(() => channelList.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
});

test("omits destination controls for a channel workflow", async ({ page }) => {
  await navigateToWorkflows(page);

  await page.getByRole("button", { name: "Create Workflow" }).click();
  const dialog = page.getByRole("dialog");
  await selectFirstChannel(dialog);
  await dialog.getByRole("button", { name: /^Trigger:/ }).click();
  await dialog.getByLabel("Trigger event").click();
  await page.getByRole("menuitem", { name: "Webhook" }).click();
  await dialog.getByRole("button", { name: "Add step" }).click();
  await page.getByRole("menuitem", { name: "Send Message" }).click();

  await expect(
    dialog.getByRole("combobox", { name: "Channel override (optional)" }),
  ).toHaveCount(0);
  await expect(dialog.getByText("Posting channel")).toHaveCount(0);

  await dialog.getByRole("tab", { name: "YAML" }).click();
  await expect(dialog.getByLabel("Workflow YAML")).not.toHaveValue(
    /channel: [0-9a-f-]{36}/,
  );
});

test("opens node configuration in a contextual inspector", async ({ page }) => {
  await navigateToWorkflows(page);

  await page.getByRole("button", { name: "Create Workflow" }).click();
  const dialog = page.getByRole("dialog");
  const inspector = dialog.getByTestId("workflow-node-inspector");

  await expect(inspector).toBeVisible();
  await expect(inspector.getByLabel("Trigger event")).toHaveAttribute(
    "data-value",
    "message_posted",
  );
  await expect(
    inspector.getByRole("button", { name: "All messages" }),
  ).toHaveAttribute("aria-pressed", "true");
  const initialIngress = dialog.getByTestId("workflow-node-ingress");
  await expect(initialIngress).toHaveAttribute("data-terminal", "true");
  await expect(initialIngress.locator("svg.lucide-arrow-down")).toHaveCount(0);
  await expect(initialIngress.getByLabel("Add step")).toBeVisible();

  await dialog.getByRole("button", { name: "Add step" }).click();
  await page.getByRole("menuitem", { name: "Send Message" }).click();
  const triggerNode = dialog.getByRole("button", { name: /^Trigger:/ });
  const stepNode = dialog.getByRole("button", { name: /^Step 1:/ });
  await expect(inspector.getByLabel("Step ID")).toHaveValue("step_1");
  await expect(inspector.getByLabel("Action")).toHaveAttribute(
    "data-value",
    "send_message",
  );
  await expect(inspector.getByLabel("Message text")).toBeVisible();
  await expect(
    inspector.getByRole("heading", { name: "Step condition" }),
  ).toBeVisible();
  await expect(
    inspector.getByRole("button", { name: "Always run this step" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(inspector.getByText(/skips only this step/)).toBeVisible();
  await expect(inspector.getByRole("group", { name: "Condition" })).toHaveCount(
    1,
  );
  await expect(
    inspector.getByRole("heading", { name: "Step timeout" }),
  ).toBeVisible();
  const ingresses = page.getByTestId("workflow-node-ingress");
  await expect(ingresses).toHaveCount(2);
  const betweenIngress = ingresses.first();
  const terminalIngress = ingresses.last();
  const betweenAddButton = betweenIngress.getByLabel("Add step");
  const betweenArrow = betweenIngress.locator("svg.lucide-arrow-down");
  await expect(betweenIngress).toHaveAttribute("data-terminal", "false");
  await expect(terminalIngress).toHaveAttribute("data-terminal", "true");
  await expect(terminalIngress.getByLabel("Add after Step 1")).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(betweenArrow).toHaveCSS("opacity", "1");
  await expect(betweenAddButton).toHaveCSS("opacity", "0");
  await expect(betweenAddButton).toHaveCSS("scale", "1.25");
  await expect(betweenAddButton).toHaveCSS("translate", "none");
  await betweenIngress.hover();
  await expect(betweenArrow).toHaveCSS("opacity", "0.1");
  await expect(betweenAddButton).toHaveCSS("opacity", "1");
  await expect(betweenAddButton).toHaveCSS("scale", "1");
  await expect(betweenAddButton).toHaveCSS("translate", "none");
  await betweenAddButton.click();
  await expect(betweenIngress).toHaveAttribute("data-menu-open", "true");
  await expect(page.getByRole("menuitem", { name: "Delay" })).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(betweenArrow).toHaveCSS("opacity", "0.1");
  await expect(betweenAddButton).toHaveCSS("opacity", "1");
  await expect(betweenAddButton).toHaveCSS("scale", "1");
  await page.keyboard.press("Escape");
  await expect(betweenIngress).toHaveAttribute("data-menu-open", "false");
  await expect(dialog.getByText("End", { exact: true })).toHaveCount(0);
  await expect(triggerNode).toHaveAttribute("aria-pressed", "false");
  await expect(stepNode).toHaveAttribute("aria-pressed", "true");
  expect(
    await triggerNode.evaluate(
      (element) => getComputedStyle(element).outlineColor,
    ),
  ).not.toBe(
    await stepNode.evaluate(
      (element) => getComputedStyle(element).outlineColor,
    ),
  );
  await expect
    .poll(() =>
      inspector.evaluate((element) => getComputedStyle(element).padding),
    )
    .toBe("16px");

  await inspector.getByLabel("Action").click();
  await page.getByRole("menuitem", { name: "Send DM" }).click();
  await expect(inspector.getByLabel("Action")).toHaveAttribute(
    "data-value",
    "send_dm",
  );
  await expect(inspector.getByLabel("To (pubkey)")).toBeVisible();

  await inspector.getByLabel("Name (optional)").fill("Notify deployer");
  await expect(stepNode).toContainText("Notify deployer");
  await expect(stepNode).toContainText("Send DM");
  await expect(stepNode).toHaveAttribute("aria-pressed", "true");

  await stepNode.hover();
  const removeStep = dialog.getByRole("button", { name: "Remove Step 1" });
  await expect(removeStep).toBeVisible();
  await removeStep.click();
  await expect(stepNode).not.toBeVisible();
  await expect(inspector).toBeVisible();
  await expect(inspector.getByLabel("Trigger event")).toBeVisible();
  await expect(dialog.getByText("End", { exact: true })).toHaveCount(0);
});

test("switches between the form and YAML editors", async ({ page }) => {
  await navigateToWorkflows(page);

  await page.getByRole("button", { name: "Create Workflow" }).click();
  const dialog = page.getByRole("dialog");
  const nameInput = dialog.getByLabel("Workflow name");

  await nameInput.fill("yaml_round_trip");
  await dialog.getByRole("tab", { name: "YAML" }).click();
  await expect(dialog.getByLabel("Workflow YAML")).toHaveValue(
    /name: yaml_round_trip/,
  );

  await dialog.getByRole("tab", { name: "Form" }).click();
  await expect(nameInput).toHaveValue("yaml_round_trip");
});

test("captures disabled diff workflows in the list UI", async ({ page }) => {
  const workflowName = `diff_workflow_${Date.now()}`;
  const description = "Watches diff events for src/ changes";

  await navigateToWorkflows(page);
  await createWorkflow(page, workflowName, {
    description,
    enabled: false,
    trigger: "diff_posted",
    stepName: "Notify reviewers",
    triggerCondition: 'str_contains(trigger_text, "src/")',
    stepTimeoutSecs: "45",
  });

  const card = page
    .locator('[data-testid^="workflow-card-"]')
    .filter({ hasText: workflowName })
    .first();
  await expect(card).toContainText(workflowName);
  await expect(card).toContainText(
    "When a matching diff is posted, wait for a moment",
  );
  await expect(card).toContainText(description);
  await expect(card).toContainText("Diff posted");
  await expect(card).toContainText("disabled");
});

test("shows the webhook secret dialog after saving a webhook workflow", async ({
  page,
}) => {
  const workflowName = `webhook_workflow_${Date.now()}`;

  await navigateToWorkflows(page);
  await createWorkflow(page, workflowName, {
    trigger: "webhook",
  });

  await expect(page.getByText("Webhook Ready")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy URL" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy Secret" })).toBeVisible();

  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText("Webhook Ready")).not.toBeVisible();
});

test("edits an existing workflow", async ({ page }) => {
  const originalName = `edit_test_${Date.now()}`;
  const updatedName = `${originalName}_updated`;

  await navigateToWorkflows(page);
  await createWorkflow(page, originalName);

  // Verify it exists
  await expect(page.getByTestId("workflows-view")).toContainText(originalName);

  // Open the dropdown menu and click Edit
  await page.getByRole("button", { name: "Workflow actions" }).first().click();
  await page.getByRole("menuitem", { name: "Edit" }).click();

  // Dialog should open in edit mode
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Edit workflow")).toBeVisible();

  // Change the name
  const nameInput = page.getByLabel("Workflow name");
  await nameInput.clear();
  await nameInput.fill(updatedName);

  // Save
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();

  // Verify the updated name appears
  await expect(page.getByTestId("workflows-view")).toContainText(updatedName);
});

test("duplicates a workflow", async ({ page }) => {
  const originalName = `dup_test_${Date.now()}`;

  await navigateToWorkflows(page);
  await createWorkflow(page, originalName);

  // Open the dropdown menu and click Duplicate
  await page.getByRole("button", { name: "Workflow actions" }).first().click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();

  // Dialog should open in duplicate mode with "(copy)" suffix
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Duplicate workflow")).toBeVisible();

  // Submit the duplicate
  await selectFirstChannel(page.getByRole("dialog"));
  await page.getByRole("button", { name: "Create copy" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();

  // Both the original and copy should exist
  await expect(page.getByTestId("workflows-view")).toContainText(originalName);
});

test("deletes a workflow with confirmation", async ({ page }) => {
  const workflowName = `delete_test_${Date.now()}`;

  await navigateToWorkflows(page);
  await createWorkflow(page, workflowName);

  // Verify it exists
  await expect(page.getByTestId("workflows-view")).toContainText(workflowName);

  // Open the dropdown menu and click Delete
  await page.getByRole("button", { name: "Workflow actions" }).first().click();
  await page.getByRole("menuitem", { name: "Delete" }).click();

  // Confirmation dialog should appear with workflow name
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(page.getByRole("alertdialog")).toContainText(workflowName);

  // Confirm deletion
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog")).not.toBeVisible();

  // Verify workflow is gone — back to empty state
  await expect(page.getByText("No workflows yet")).toBeVisible();
});

test("opens a workflow in the edit modal from its card", async ({ page }) => {
  const workflowName = `open_edit_test_${Date.now()}`;

  await navigateToWorkflows(page);
  await createWorkflow(page, workflowName);

  await page.getByRole("button", { name: `Edit ${workflowName}` }).click();

  const dialog = page.getByRole("dialog", { name: "Edit workflow" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Workflow name")).toHaveValue(workflowName);
  await expect(page.getByTestId("workflow-detail-panel")).not.toBeVisible();
});
