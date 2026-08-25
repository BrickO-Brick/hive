import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

const LIVE_MENTION = "Please review the release checklist.";
const LIVE_REMINDER = "Reminder: update the launch plan before lunch.";
const MEDIA_SUMMARY = "The design reference is ready for review.";

test("Bestie Feed projects only events returned by the Home feed", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_PUSH_MOCK_FEED_ITEM__ === "function",
  );
  await page.evaluate(() => {
    window.__BUZZ_E2E_PUSH_MOCK_FEED_ITEM__?.({
      id: "bestie-media-evidence",
      kind: 9,
      pubkey: "a".repeat(64),
      content:
        "The design reference is ready for review. This additional implementation detail should remain supporting evidence rather than becoming the headline.\n\n![Reference image](/app-icon@2x.png)",
      created_at: Math.floor(Date.now() / 1_000) + 1,
      channel_id: "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50",
      channel_name: "general",
      channel_type: "stream",
      tags: [
        ["h", "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50"],
        ["p", "deadbeef".repeat(8)],
      ],
      category: "mention",
    });
  });

  await page.getByTestId("open-bestie-feed").click();
  await expect(page).toHaveURL(/#\/\?view=bestie$/);
  await expect(
    page.getByRole("heading", { name: /what’s happening in your Buzz/i }),
  ).toBeVisible();
  await expect(page.getByText("Live from your Home feed")).toBeVisible();
  await expect(
    page.getByText(LIVE_MENTION, { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText(LIVE_REMINDER, { exact: true }).first(),
  ).toBeVisible();
  const mediaCard = page
    .getByRole("heading", { name: MEDIA_SUMMARY, exact: true })
    .locator("xpath=ancestor::article");
  await expect(mediaCard).toBeVisible();
  await expect(
    mediaCard.getByRole("button", {
      name: "Zoom image: Reference image",
    }),
  ).toBeVisible();
  await expect(page.getByText(/Simon asked for the latest/)).toHaveCount(0);
  await expect(page.getByText(/Cmd\+K is ready/)).toHaveCount(0);

  await page.getByTestId("bestie-filter-messages").click();
  await expect(
    page.getByText(LIVE_MENTION, { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText(LIVE_REMINDER, { exact: true })).toHaveCount(0);
  await page.getByTestId("bestie-filter-all").click();

  const mentionCard = page
    .getByText(LIVE_MENTION, { exact: true })
    .first()
    .locator("xpath=ancestor::article");
  await expect(
    mentionCard.getByRole("heading", { name: LIVE_MENTION, exact: true }),
  ).toBeVisible();
  await expect(mentionCard.getByText("Alice", { exact: true })).toHaveCount(0);
  await expect(mentionCard.getByText("general", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    mentionCard.locator(
      '[data-testid^="bestie-avatar-"][data-testid$="-fallback"]',
    ),
  ).toBeVisible();
  const snoozeTrigger = mentionCard.getByRole("button", {
    name: `Snooze ${LIVE_MENTION}`,
  });
  await snoozeTrigger.click();
  await expect(page.getByText(LIVE_MENTION, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(
    page.getByText(LIVE_MENTION, { exact: true }).first(),
  ).toBeVisible();

  const replyTrigger = page
    .getByText(LIVE_MENTION, { exact: true })
    .first()
    .locator("xpath=ancestor::article")
    .getByRole("button", { name: `Reply about ${LIVE_MENTION}` });
  await replyTrigger.click();
  const replyPanel = page.getByTestId("bestie-reply-panel");
  await expect(replyPanel).toContainText(LIVE_MENTION);
  await expect(replyPanel).toContainText("real source conversation from Buzz");
  await page.keyboard.press("Escape");
  await expect(replyTrigger).toBeFocused();

  const chatTrigger = page
    .getByText(LIVE_MENTION, { exact: true })
    .first()
    .locator("xpath=ancestor::article")
    .getByRole("button", { name: "Chat with Bestie" });
  await chatTrigger.click();
  const chatPanel = page.getByTestId("bestie-chat-panel");
  await expect(chatPanel).toContainText(LIVE_MENTION);
  await expect(chatPanel).toContainText("no agent response");
  await page.getByTestId("bestie-panel-input").fill("What should I do?");
  await page.getByRole("button", { name: "Add question" }).click();
  await expect(chatPanel.locator('[data-author="you"]')).toContainText(
    "What should I do?",
  );
  await expect(chatPanel.locator('[data-author="bestie"]')).toHaveCount(0);

  await page.keyboard.press("Escape");
  await page.getByTestId("bestie-open-inbox").click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByTestId("home-inbox")).toBeVisible();
});

test("captures the live-data Bestie Feed projection", async ({ page }) => {
  await page.setViewportSize({ height: 1100, width: 1440 });
  await installMockBridge(page);
  await page.goto("/#/?view=bestie");
  await expect(
    page.getByText(LIVE_MENTION, { exact: true }).first(),
  ).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/bestie-feed/01-live-ranked-cards.png",
  });

  const card = page
    .getByText(LIVE_MENTION, { exact: true })
    .first()
    .locator("xpath=ancestor::article");
  await card.getByRole("button", { name: "Chat with Bestie" }).click();
  await expect(page.getByTestId("bestie-chat-panel")).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/bestie-feed/02-live-item-chat.png",
  });
});
