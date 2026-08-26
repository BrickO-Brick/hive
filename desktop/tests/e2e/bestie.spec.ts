import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

const BESTIE_PUBKEY =
  "be571e0000000000000000000000000000000000000000000000000000000000";
const BESTIE_AVATAR =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22512%22%20height%3D%22512%22%20viewBox%3D%220%200%20512%20512%22%3E%3Crect%20width%3D%22512%22%20height%3D%22512%22%20rx%3D%22256%22%20fill%3D%22%23D66BFF%22%2F%3E%3Ctext%20x%3D%2250%25%22%20y%3D%2256%25%22%20dominant-baseline%3D%22middle%22%20text-anchor%3D%22middle%22%20font-size%3D%22258%22%3E%F0%9F%90%99%3C%2Ftext%3E%3C%2Fsvg%3E";

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
      content:
        "Please fold this launch decision into tomorrow's priorities. Product and engineering need one owner, a clear deadline, and a short note explaining the tradeoff before the review begins.",
      id,
    });
  }, messageId);

  const row = page.locator(`[data-message-id="${messageId}"]`);
  await expect(row).toContainText("launch decision");
  await row.hover();
  await row.getByTestId(`send-to-bestie-${messageId}`).click();

  const popover = page.getByTestId(`bestie-popover-${messageId}`);
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("Bestie");
  await expect(popover).not.toContainText("Share this message with Bestie");
  await expect(popover).toContainText("Please fold this launch decision");
  const snapshot = popover.getByTestId(`bestie-message-snapshot-${messageId}`);
  await expect(snapshot).toBeVisible();
  const [popoverBox, snapshotBox] = await Promise.all([
    popover.boundingBox(),
    snapshot.boundingBox(),
  ]);
  expect(popoverBox).not.toBeNull();
  expect(snapshotBox).not.toBeNull();
  if (popoverBox && snapshotBox) {
    expect(popoverBox.width).toBeLessThanOrEqual(328);
    expect(snapshotBox.width / snapshotBox.height).toBeCloseTo(4 / 3, 1);
    expect(snapshotBox.width / (popoverBox.width - 32)).toBeCloseTo(0.8, 1);
  }
  const composer = popover.getByTestId("message-composer");
  await expect(composer).toBeVisible();
  await expect(composer.getByRole("button", { name: "Send" })).toBeEnabled();
  if (process.env.BUZZ_BESTIE_POPOVER_SCREENSHOT) {
    await page.screenshot({
      animations: "disabled",
      path: process.env.BUZZ_BESTIE_POPOVER_SCREENSHOT,
    });
  }
  await composer
    .locator('[contenteditable="true"]')
    .fill("Make sure product and engineering agree on the owner.");
  await composer.getByRole("button", { name: "Send" }).click();

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
