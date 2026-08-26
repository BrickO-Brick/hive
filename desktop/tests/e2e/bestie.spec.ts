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

test("Bestie header avatar opens an inline conversation and sends messages", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const trigger = page.getByTestId("open-bestie-panel");
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAccessibleName("Open Bestie chat");
  await trigger.click();

  const popover = page.getByTestId("bestie-chat-popover");
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
  await expect(actionBar).toHaveAttribute("data-bloom-surface", "toolbar");

  await row.getByTestId(`react-message-${messageId}`).click();
  await expect(actionBar).toHaveAttribute("data-bloom-surface", "reactions");
  await expect(
    page.getByTestId(`reaction-bloom-panel-${messageId}`),
  ).toBeVisible();
  const reactionPanel = page.getByTestId(`reaction-bloom-panel-${messageId}`);
  await expect
    .poll(() =>
      reactionPanel.evaluate(
        (element) => window.getComputedStyle(element).transform,
      ),
    )
    .toBe("none");
  const [reactionBox, reactionAnchorBox] = await Promise.all([
    reactionPanel.boundingBox(),
    actionBar.boundingBox(),
  ]);
  expect(reactionBox).not.toBeNull();
  expect(reactionAnchorBox).not.toBeNull();
  if (reactionBox && reactionAnchorBox) {
    expect(
      Math.abs(
        reactionBox.x +
          reactionBox.width -
          (reactionAnchorBox.x + reactionAnchorBox.width),
      ),
    ).toBeLessThanOrEqual(10);
  }
  await page.keyboard.press("Escape");
  await expect(actionBar).toHaveAttribute("data-bloom-surface", "toolbar");

  await row.getByTestId(`more-actions-${messageId}`).click();
  await expect(actionBar).toHaveAttribute("data-bloom-surface", "more");
  await expect(
    page.getByTestId(`more-actions-panel-${messageId}`),
  ).toBeVisible();
  const morePanel = page.getByTestId(`more-actions-panel-${messageId}`);
  await expect
    .poll(() =>
      morePanel.evaluate(
        (element) => window.getComputedStyle(element).transform,
      ),
    )
    .toBe("none");
  const [moreBox, moreAnchorBox] = await Promise.all([
    morePanel.boundingBox(),
    actionBar.boundingBox(),
  ]);
  expect(moreBox).not.toBeNull();
  expect(moreAnchorBox).not.toBeNull();
  if (moreBox && moreAnchorBox) {
    expect(
      Math.abs(
        moreBox.x + moreBox.width - (moreAnchorBox.x + moreAnchorBox.width),
      ),
    ).toBeLessThanOrEqual(10);
  }
  await page.keyboard.press("Escape");
  await expect(actionBar).toHaveAttribute("data-bloom-surface", "toolbar");

  await row.getByTestId(`send-to-bestie-${messageId}`).click();

  const popover = page.getByTestId(`bestie-popover-${messageId}`);
  await expect(popover).toBeVisible();
  await expect(actionBar).toHaveAttribute("data-bloom-surface", "bestie");
  await expect(
    actionBar.getByTestId(`message-action-bloom-surface-${messageId}`),
  ).toHaveCount(0);
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
  await expect
    .poll(() =>
      popover.evaluate((element) => window.getComputedStyle(element).transform),
    )
    .toBe("none");
  await expect
    .poll(() =>
      popover.evaluate((element) =>
        Number.parseFloat(
          window.getComputedStyle(element.firstElementChild as Element).opacity,
        ),
      ),
    )
    .toBeGreaterThan(0.99);
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
    const actionBarBox = await actionBar.boundingBox();
    expect(actionBarBox).not.toBeNull();
    if (actionBarBox) {
      expect(
        Math.abs(
          popoverBox.x +
            popoverBox.width -
            (actionBarBox.x + actionBarBox.width),
        ),
      ).toBeLessThanOrEqual(10);
    }
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
