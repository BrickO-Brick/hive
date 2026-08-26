import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

const BESTIE_PUBKEY =
  "be571e0000000000000000000000000000000000000000000000000000000000";
const BESTIE_AVATAR =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='18' fill='%23252b33'/%3E%3Ccircle cx='22' cy='27' r='8' fill='%23ffd54a'/%3E%3Ccircle cx='42' cy='27' r='8' fill='%23ffd54a'/%3E%3Cpath d='M18 42c7 7 21 7 28 0' fill='none' stroke='%23ffd54a' stroke-width='5' stroke-linecap='round'/%3E%3C/svg%3E";

test.beforeEach(async ({ page }) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: BESTIE_PUBKEY,
        name: "Bestie",
        personaId: "builtin:bestie",
        status: "running",
        avatarUrl: BESTIE_AVATAR,
      },
    ],
  });
});

test("Bestie sidebar shortcut always opens its direct message", async ({
  page,
}) => {
  await page.goto("/");

  const shortcut = page.getByTestId("open-bestie-dm");
  await expect(shortcut).toBeVisible();
  await expect(shortcut).toContainText("Bestie");
  if (process.env.BUZZ_BESTIE_NAV_SCREENSHOT) {
    await page.screenshot({
      animations: "disabled",
      path: process.env.BUZZ_BESTIE_NAV_SCREENSHOT,
    });
  }
  await shortcut.click();

  await expect(page.getByTestId("chat-title")).toHaveText("Bestie");
});

test("message action sends a message link and optional note to Bestie", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__ === "function",
  );

  const messageId = "b3571e".padEnd(64, "0");
  await page.evaluate((id) => {
    window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName: "general",
      content: "Please fold this launch decision into tomorrow's priorities.",
      id,
    });
  }, messageId);

  const row = page.locator(`[data-message-id="${messageId}"]`);
  await expect(row).toContainText("launch decision");
  await row.hover();
  await row.getByTestId(`send-to-bestie-${messageId}`).click();

  const popover = page.getByTestId(`bestie-popover-${messageId}`);
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("Please fold this launch decision");
  if (process.env.BUZZ_BESTIE_POPOVER_SCREENSHOT) {
    await page.screenshot({
      animations: "disabled",
      path: process.env.BUZZ_BESTIE_POPOVER_SCREENSHOT,
    });
  }
  await popover
    .getByRole("textbox", { name: "Note for Bestie" })
    .fill("Make sure product and engineering agree on the owner.");
  await popover.getByRole("button", { name: "Send" }).click();

  await expect(popover).toBeHidden();
  await page.getByTestId("open-bestie-dm").click();
  await expect(page.getByTestId("chat-title")).toHaveText("Bestie");
  await expect(page.getByTestId("message-row").last()).toContainText(
    "Make sure product and engineering agree on the owner.",
  );
  await expect(page.getByTestId("message-row").last()).toContainText(
    "Open original message",
  );
});
