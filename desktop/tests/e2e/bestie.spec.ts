import { expect, type Locator, test } from "@playwright/test";

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

test("Bestie top chrome avatar and command shortcut open the floating conversation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const trigger = page.getByTestId("open-bestie-panel");
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAccessibleName("Open Bestie chat");

  const [triggerBox, topChromeBox, chatHeaderBox] = await Promise.all([
    trigger.boundingBox(),
    page.getByTestId("app-top-chrome").boundingBox(),
    page.getByTestId("chat-header").boundingBox(),
  ]);
  expect(triggerBox).not.toBeNull();
  expect(topChromeBox).not.toBeNull();
  expect(chatHeaderBox).not.toBeNull();
  if (triggerBox && topChromeBox && chatHeaderBox) {
    expect(
      Math.abs(
        triggerBox.x +
          triggerBox.width -
          (topChromeBox.x + topChromeBox.width - 12),
      ),
    ).toBeLessThanOrEqual(1);
    expect(triggerBox.y).toBeGreaterThanOrEqual(topChromeBox.y);
    expect(triggerBox.y + triggerBox.height).toBeLessThanOrEqual(
      chatHeaderBox.y,
    );
  }

  const popover = page.getByTestId("bestie-chat-popover");
  await page.keyboard.press("Meta+1");
  await expect(popover).toBeVisible();
  await page.keyboard.press("Meta+1");
  await expect(popover).toBeHidden();
  await trigger.click();
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("Bestie");
  const composer = popover.getByTestId("message-composer");
  await expect(composer).toBeVisible();
  await expect(composer.getByRole("button", { name: "Send" })).toBeDisabled();
  const editor = composer.locator('[contenteditable="true"]');
  await expect(editor).toBeEditable();
  for (let index = 0; index < 7; index += 1) {
    const content = `History note ${index + 1}: This is a longer Bestie conversation entry for the scrollable floating panel.`;
    await editor.fill(content);
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(popover.getByTestId("bestie-chat-transcript")).toContainText(
      content,
    );
  }
  const scroll = popover.getByTestId("bestie-chat-scroll");
  await expect
    .poll(() =>
      scroll.evaluate((element) => element.scrollHeight > element.clientHeight),
    )
    .toBe(true);
  await scroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollTop))
    .toBe(0);
  if (process.env.BUZZ_BESTIE_CHAT_SCREENSHOT) {
    await page.screenshot({
      animations: "disabled",
      path: process.env.BUZZ_BESTIE_CHAT_SCREENSHOT,
    });
  }
  await editor.fill("Can you help me prioritize this?");
  await expect(composer.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.getByRole("button", { name: "Send" }).click();

  await expect(popover.getByTestId("bestie-chat-transcript")).toContainText(
    "Can you help me prioritize this?",
  );
  await expect(page.getByTestId("chat-title")).toHaveText("general");
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
  const actionBar = row.getByTestId(`message-action-bar-${messageId}`);
  const bloomContainer = row.getByTestId(
    `message-action-bloom-container-${messageId}`,
  );
  await expect(actionBar).toHaveAttribute("data-bloom-surface", "toolbar");
  await bloomContainer.evaluate((element) => {
    element.setAttribute("data-persistent-node", "original");
  });
  const toolbarBox = await bloomContainer.boundingBox();
  expect(toolbarBox).not.toBeNull();
  const expectSurfaceRadius = async (radius: number) => {
    await expect
      .poll(() =>
        bloomContainer.evaluate((element) =>
          Number.parseFloat(window.getComputedStyle(element).borderRadius),
        ),
      )
      .toBeCloseTo(radius, 0);
  };
  await expectSurfaceRadius(32);

  const expectPersistentSurfaceSettled = async (destination: Locator) => {
    await expect
      .poll(async () => {
        const [surfaceBox, destinationBox] = await Promise.all([
          bloomContainer.boundingBox(),
          destination.boundingBox(),
        ]);
        if (!surfaceBox || !destinationBox) return false;
        return (
          Math.abs(surfaceBox.width - destinationBox.width) <= 1 &&
          Math.abs(surfaceBox.height - destinationBox.height) <= 1
        );
      })
      .toBe(true);
    await expect(bloomContainer).toHaveAttribute(
      "data-persistent-node",
      "original",
    );
    const currentBox = await bloomContainer.boundingBox();
    expect(currentBox).not.toBeNull();
    if (toolbarBox && currentBox) {
      expect(
        Math.abs(
          currentBox.x + currentBox.width - (toolbarBox.x + toolbarBox.width),
        ),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(
          currentBox.y + currentBox.height - (toolbarBox.y + toolbarBox.height),
        ),
      ).toBeLessThanOrEqual(1);
    }
  };

  await row.getByTestId(`react-message-${messageId}`).click();
  await expect(actionBar).toHaveAttribute("data-bloom-surface", "reactions");
  await expect(
    page.getByTestId(`reaction-bloom-panel-${messageId}`),
  ).toBeVisible();
  const reactionPanel = page.getByTestId(`reaction-bloom-panel-${messageId}`);
  await expectPersistentSurfaceSettled(reactionPanel);
  await expectSurfaceRadius(24);
  await expect
    .poll(() =>
      reactionPanel.evaluate((element) =>
        Number.parseFloat(window.getComputedStyle(element).opacity),
      ),
    )
    .toBeGreaterThan(0.99);
  await page.keyboard.press("Escape");
  await expect(actionBar).toHaveAttribute("data-bloom-surface", "toolbar");
  await expectPersistentSurfaceSettled(
    actionBar.getByTestId(`message-action-bloom-surface-${messageId}`),
  );
  await expectSurfaceRadius(32);

  await row.getByTestId(`more-actions-${messageId}`).click();
  await expect(actionBar).toHaveAttribute("data-bloom-surface", "more");
  await expect(
    page.getByTestId(`more-actions-panel-${messageId}`),
  ).toBeVisible();
  const morePanel = page.getByTestId(`more-actions-panel-${messageId}`);
  await expectPersistentSurfaceSettled(morePanel);
  await expectSurfaceRadius(24);
  await expect
    .poll(() =>
      morePanel.evaluate((element) =>
        Number.parseFloat(window.getComputedStyle(element).opacity),
      ),
    )
    .toBeGreaterThan(0.99);
  await page.keyboard.press("Escape");
  await expect(actionBar).toHaveAttribute("data-bloom-surface", "toolbar");
  await expectPersistentSurfaceSettled(
    actionBar.getByTestId(`message-action-bloom-surface-${messageId}`),
  );
  await expectSurfaceRadius(32);

  await row.getByTestId(`send-to-bestie-${messageId}`).click();

  const popover = page.getByTestId(`bestie-popover-${messageId}`);
  await expect(popover).toBeVisible();
  await expect(actionBar).toHaveAttribute("data-bloom-surface", "bestie");
  const dormantToolbar = actionBar.getByTestId(
    `message-action-bloom-surface-${messageId}`,
  );
  await expect(dormantToolbar).toHaveCount(1);
  await expect
    .poll(() =>
      dormantToolbar.evaluate((element) =>
        Number.parseFloat(window.getComputedStyle(element).opacity),
      ),
    )
    .toBeLessThan(0.01);
  await expectPersistentSurfaceSettled(popover);
  await expectSurfaceRadius(24);
  await expect
    .poll(() =>
      popover.evaluate((element) =>
        Number.parseFloat(window.getComputedStyle(element).opacity),
      ),
    )
    .toBeGreaterThan(0.99);
  await expect
    .poll(
      async () =>
        (await popover.boundingBox())?.width ?? Number.POSITIVE_INFINITY,
    )
    .toBeLessThanOrEqual(328);
  await expect(popover).toContainText("Bestie");
  await expect(popover).not.toContainText("Share this message with Bestie");
  await expect(popover).toContainText("Please fold this launch decision");
  const snapshot = popover.getByTestId(`bestie-message-snapshot-${messageId}`);
  const snapshotBody = popover.getByTestId(
    `bestie-message-snapshot-body-${messageId}`,
  );
  await expect(snapshot).toBeVisible();
  const [popoverBox, snapshotBox, snapshotBodyBox] = await Promise.all([
    popover.boundingBox(),
    snapshot.boundingBox(),
    snapshotBody.boundingBox(),
  ]);
  expect(popoverBox).not.toBeNull();
  expect(snapshotBox).not.toBeNull();
  expect(snapshotBodyBox).not.toBeNull();
  if (popoverBox && snapshotBox && snapshotBodyBox) {
    expect(popoverBox.width).toBeLessThanOrEqual(328);
    expect(snapshotBox.width / (popoverBox.width - 32)).toBeCloseTo(0.75, 1);
    expect(Math.abs(snapshotBox.x - (popoverBox.x + 16))).toBeLessThanOrEqual(
      1,
    );
    expect(snapshotBox.height).toBeLessThan(64);
    expect(snapshotBodyBox.height).toBeLessThanOrEqual(14);
  }
  const composer = popover.getByTestId("message-composer");
  await expect(composer).toBeVisible();
  await expect(composer.getByRole("button", { name: "Send" })).toBeEnabled();
  if (process.env.BUZZ_BESTIE_POPOVER_SCREENSHOT) {
    await page.screenshot({
      animations: "allow",
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
