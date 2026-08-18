import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { KIND_HUDDLE_STARTED } from "../../src/shared/constants/kinds";

const SHOTS = "test-results/message-feedback";

async function waitForMockLiveSubscription(
  page: import("@playwright/test").Page,
  channelName: string,
) {
  await expect
    .poll(async () => {
      return page.evaluate(
        ({ ch }) =>
          (
            window as Window & {
              __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
                channelName: string;
              }) => boolean;
            }
          ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({ channelName: ch }) ??
          false,
        { ch: channelName },
      );
    })
    .toBe(true);
}

async function seedMessageBubbles(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("buzz.appearance.messageStyle", "bubbles");
  });
}

async function seedRightAlignedOwnBubbles(
  page: import("@playwright/test").Page,
) {
  await page.addInitScript(() => {
    window.localStorage.setItem("buzz.appearance.messageStyle", "bubbles");
    window.localStorage.setItem("buzz.appearance.ownMessageAlignment", "right");
  });
}

test("pending continuation keeps Sending next to its timestamp", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");

  const sentMessage = `Message before pending state ${Date.now()}`;
  const pendingMessage = `Pending message status ${Date.now()}`;
  const createdAt = Math.floor(Date.now() / 1_000);
  await page.evaluate(
    ({ firstMessage, secondMessage, timestamp }) => {
      const emit = (
        window as Window & {
          __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
            channelName: string;
            content: string;
            createdAt: number;
            pending?: boolean;
          }) => unknown;
        }
      ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__;
      emit?.({
        channelName: "general",
        content: firstMessage,
        createdAt: timestamp - 1,
      });
      emit?.({
        channelName: "general",
        content: secondMessage,
        createdAt: timestamp,
        pending: true,
      });
    },
    {
      firstMessage: sentMessage,
      secondMessage: pendingMessage,
      timestamp: createdAt,
    },
  );

  const pendingRow = page
    .getByTestId("message-row")
    .filter({ hasText: pendingMessage });
  const status = pendingRow.getByTestId("message-send-status");
  await expect(status).toHaveText("Sending…");
  await expect(pendingRow.getByTestId("message-author")).toHaveCount(1);

  const timestamp = status.locator("xpath=../p[1]");
  const [timestampBox, statusBox] = await Promise.all([
    timestamp.boundingBox(),
    status.boundingBox(),
  ]);
  expect(timestampBox).not.toBeNull();
  expect(statusBox).not.toBeNull();
  if (!timestampBox || !statusBox) {
    throw new Error("Pending message metadata is missing its inline layout.");
  }
  expect(statusBox.x).toBeGreaterThan(timestampBox.x);
  expect(Math.abs(statusBox.y - timestampBox.y)).toBeLessThanOrEqual(1);

  await waitForAnimations(page);
  await pendingRow.screenshot({ path: `${SHOTS}/pending-message-inline.png` });
});

test("profile hover uses the channel hover surface", async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/");

  const profile = page.getByTestId("sidebar-profile-card");
  const channel = page.getByTestId("channel-random");
  await channel.hover();
  const channelHoverColor = await channel.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await profile.hover();
  await expect(profile).toHaveCSS("background-color", channelHoverColor);

  await waitForAnimations(page);
  await page
    .getByTestId("app-sidebar")
    .screenshot({ path: `${SHOTS}/profile-hover.png` });
});

test("appearance previews right-aligned own-message bubbles", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("open-settings").click();
  await page.getByTestId("profile-popover-settings").click();
  await page.getByTestId("settings-nav-appearance").click();

  const displaySettings = page.getByTestId("conversation-display-group");
  await expect(displaySettings).toBeVisible();
  await expect(
    displaySettings.getByTestId("own-message-alignment-row"),
  ).toHaveCount(0);

  await displaySettings.getByTestId("message-style-bubbles").click();
  const alignmentRow = displaySettings.getByTestId("own-message-alignment-row");
  await expect(alignmentRow).toBeVisible();
  await alignmentRow.getByTestId("own-message-alignment-right").click();

  const preview = displaySettings.getByTestId("conversation-preview");
  const otherMessage = preview
    .getByTestId("conversation-preview-message-surface")
    .first();
  const ownMessage = preview.locator('[data-own-message="true"]');
  const [otherBox, ownBox] = await Promise.all([
    otherMessage.boundingBox(),
    ownMessage.boundingBox(),
  ]);
  if (!otherBox || !ownBox) {
    throw new Error("Expected both settings preview messages.");
  }
  expect(ownBox.x).toBeGreaterThan(otherBox.x);
  await expect(
    preview.getByTestId("conversation-preview-message-header"),
  ).toHaveCount(1);
  await expect(
    otherMessage.getByTestId("conversation-preview-message-header"),
  ).toHaveCount(0);
  await expect(
    ownMessage.getByTestId("conversation-preview-message-header"),
  ).toHaveCount(0);
  const otherPreviewSurfaceWrapper = otherMessage.locator("..");
  const otherPreviewTimestamp = otherPreviewSurfaceWrapper.getByTestId(
    "conversation-preview-hover-timestamp",
  );
  const ownPreviewSurfaceWrapper = ownMessage.locator("..");
  const ownPreviewTimestamp = ownPreviewSurfaceWrapper.getByTestId(
    "conversation-preview-hover-timestamp",
  );
  await expect(otherPreviewTimestamp).toHaveCSS("opacity", "0");
  await expect(ownPreviewTimestamp).toHaveCSS("opacity", "0");
  await otherPreviewSurfaceWrapper.hover();
  await expect(otherPreviewTimestamp).toHaveCSS("opacity", "1");
  await ownPreviewSurfaceWrapper.hover();
  await expect(ownPreviewTimestamp).toHaveCSS("opacity", "1");
  await expect(
    alignmentRow.getByText("Show your messages on the right."),
  ).toBeVisible();

  await waitForAnimations(page);
  await displaySettings.screenshot({
    path: `${SHOTS}/right-aligned-own-bubbles-setting.png`,
  });
});

test("open messages use the compact ellipsis actions menu", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "buzz.quick-reaction-emojis.v1:e2e-default-community",
      JSON.stringify([{ count: 2, emoji: "🔥", lastUsedAt: Date.now() }]),
    );
  });
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const row = page
    .getByTestId("message-row")
    .filter({ hasText: "React to me with a custom emoji" })
    .last();
  await expect(row).toBeVisible();
  await row.hover();

  const actionBar = row.locator('[data-testid^="message-action-bar-"]');
  await expect(actionBar).toHaveAttribute("data-presentation", "menu");
  await expect(
    actionBar.getByRole("button", { name: "More actions" }),
  ).toBeVisible();
  await expect(
    actionBar.getByRole("button", { name: "Open reactions" }),
  ).toHaveCount(0);
  await expect(actionBar.getByRole("button", { name: "Reply" })).toHaveCount(0);

  const [rowBox, actionBarBox] = await Promise.all([
    row.boundingBox(),
    actionBar.boundingBox(),
  ]);
  if (!rowBox || !actionBarBox) {
    throw new Error("Expected open message action geometry.");
  }
  expect(actionBarBox.y).toBeGreaterThanOrEqual(rowBox.y);
  expect(actionBarBox.x + actionBarBox.width).toBeLessThanOrEqual(
    rowBox.x + rowBox.width + 1,
  );

  await actionBar.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  const quickReactions = page.locator(
    '[data-testid^="message-quick-reactions-"]',
  );
  await expect(quickReactions).toBeVisible();
  await expect(
    quickReactions.getByRole("button", { name: /^React with / }),
  ).toHaveCount(5);
  await expect(
    page.getByRole("menuitem", { name: "Reply", exact: true }),
  ).toBeVisible();

  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/open-message-actions.png` });
});

test("left-aligned continuation bubbles join on the left edge", async ({
  page,
}) => {
  await seedMessageBubbles(page);
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");

  const suffix = Date.now();
  const messages = {
    before: `Different author before ${suffix}`,
    first: `First grouped bubble for @bob ${suffix}`,
    middle: `Middle grouped bubble ${suffix}`,
    last: `Last grouped bubble ${suffix}`,
    isolated: `Isolated bubble ${suffix}`,
  };
  const createdAt = Math.floor(Date.now() / 1_000);
  await page.evaluate(
    ({ alicePubkey, bobPubkey, content, timestamp }) => {
      const emit = (
        window as Window & {
          __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
            channelName: string;
            content: string;
            createdAt: number;
            extraTags?: string[][];
            pubkey: string;
          }) => unknown;
        }
      ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__;
      [
        { content: content.before, extraTags: [], pubkey: bobPubkey },
        {
          content: content.first,
          extraTags: [["p", bobPubkey]],
          pubkey: alicePubkey,
        },
        { content: content.middle, extraTags: [], pubkey: alicePubkey },
        { content: content.last, extraTags: [], pubkey: alicePubkey },
        { content: content.isolated, extraTags: [], pubkey: bobPubkey },
      ].forEach((message, index) => {
        emit?.({
          channelName: "general",
          content: message.content,
          createdAt: timestamp + index,
          extraTags: message.extraTags,
          pubkey: message.pubkey,
        });
      });
    },
    {
      alicePubkey: TEST_IDENTITIES.alice.pubkey,
      bobPubkey: TEST_IDENTITIES.bob.pubkey,
      content: messages,
      timestamp: createdAt,
    },
  );

  const rowFor = (content: string) =>
    page.getByTestId("message-row").filter({ hasText: content });
  const firstRow = rowFor(messages.first);
  const middleRow = rowFor(messages.middle);
  const lastRow = rowFor(messages.last);
  const isolatedRow = rowFor(messages.isolated);
  await expect(isolatedRow).toBeVisible();

  const firstBubble = firstRow.getByTestId("message-body-surface");
  const lastBubble = lastRow.getByTestId("message-body-surface");
  await expect(firstRow.getByTestId("message-author")).toHaveCount(1);
  await expect(firstBubble.getByTestId("message-author")).toHaveCount(0);
  await expect(middleRow.getByTestId("message-author")).toHaveCount(0);
  await expect(lastRow.getByTestId("message-author")).toHaveCount(0);
  await expect(
    firstRow.locator('[data-testid^="message-avatar-"]'),
  ).toHaveCount(0);
  await expect(
    middleRow.locator('[data-testid^="message-avatar-"]'),
  ).toHaveCount(0);
  await expect(
    lastRow.getByTestId("message-bubble-avatar-anchor"),
  ).toBeVisible();

  const hoverTimestamp = lastRow.getByTestId("message-hover-timestamp");
  await expect(hoverTimestamp).toHaveCSS("opacity", "0");

  const dayGroup = page.getByTestId("message-timeline-day-group").first();
  await expect(dayGroup).toBeVisible();
  expect(
    await dayGroup.evaluate(
      (element) => getComputedStyle(element, "::before").content,
    ),
  ).toBe("none");

  const radii = async (content: string) =>
    rowFor(content)
      .getByTestId("message-body-surface")
      .evaluate((bubble) => {
        const style = getComputedStyle(bubble);
        return {
          bottomLeft: Number.parseFloat(style.borderBottomLeftRadius),
          bottomRight: Number.parseFloat(style.borderBottomRightRadius),
          topLeft: Number.parseFloat(style.borderTopLeftRadius),
          topRight: Number.parseFloat(style.borderTopRightRadius),
        };
      });

  const [first, middle, last, isolated] = await Promise.all([
    radii(messages.first),
    radii(messages.middle),
    radii(messages.last),
    radii(messages.isolated),
  ]);
  expect(first.topLeft).toBe(first.topRight);
  expect(first.bottomLeft).toBeLessThan(first.bottomRight);
  expect(middle.topLeft).toBeLessThan(middle.topRight);
  expect(middle.bottomLeft).toBeLessThan(middle.bottomRight);
  expect(last.topLeft).toBeLessThan(last.topRight);
  expect(last.bottomLeft).toBe(last.bottomRight);
  expect(new Set(Object.values(isolated)).size).toBe(1);

  const isolatedPadding = await isolatedRow
    .getByTestId("message-body-surface")
    .evaluate((bubble) => {
      const style = getComputedStyle(bubble);
      return {
        bottom: Number.parseFloat(style.paddingBottom),
        left: Number.parseFloat(style.paddingLeft),
        right: Number.parseFloat(style.paddingRight),
        top: Number.parseFloat(style.paddingTop),
      };
    });
  expect(isolatedPadding.left).toBeGreaterThan(12);
  expect(isolatedPadding.top).toBeGreaterThan(8);
  expect(isolatedPadding.right).toBe(isolatedPadding.left);
  expect(isolatedPadding.bottom).toBe(isolatedPadding.top);

  const mentionStyle = await firstRow
    .locator("[data-mention]")
    .evaluate((mention) => {
      const style = getComputedStyle(mention);
      return {
        backgroundColor: style.backgroundColor,
        fontWeight: Number(style.fontWeight),
        paddingLeft: Number.parseFloat(style.paddingLeft),
        paddingRight: Number.parseFloat(style.paddingRight),
      };
    });
  expect(mentionStyle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(mentionStyle.fontWeight).toBeGreaterThanOrEqual(600);
  expect(mentionStyle.paddingLeft).toBe(0);
  expect(mentionStyle.paddingRight).toBe(0);

  await lastRow.hover();
  await expect(hoverTimestamp).toHaveCSS("opacity", "1");
  const actionBar = lastRow.locator('[data-testid^="message-action-bar-"]');
  await expect(actionBar).toBeVisible();
  await expect(actionBar).toHaveAttribute("data-presentation", "inline");
  await expect(
    actionBar.getByRole("button", { name: "Open reactions" }),
  ).toBeVisible();
  await expect(actionBar.getByRole("button", { name: "Reply" })).toBeVisible();
  await expect(
    actionBar.getByRole("button", { name: "More actions" }),
  ).toBeVisible();
  await expect(actionBar.locator('[aria-label^="React with"]')).toHaveCount(0);
  const actionButtons = actionBar.getByRole("button");
  const [firstActionBox, secondActionBox] = await Promise.all([
    actionButtons.nth(0).boundingBox(),
    actionButtons.nth(1).boundingBox(),
  ]);
  if (!firstActionBox || !secondActionBox) {
    throw new Error("Expected spaced inline action buttons.");
  }
  expect(firstActionBox.width).toBeGreaterThanOrEqual(28);
  expect(secondActionBox.x - (firstActionBox.x + firstActionBox.width)).toBe(4);
  const [hoverBubble, actionBarBox] = await Promise.all([
    lastBubble.boundingBox(),
    actionBar.boundingBox(),
  ]);
  if (!hoverBubble || !actionBarBox) {
    throw new Error("Expected bubble and inline action geometry.");
  }
  expect(actionBarBox.x).toBeGreaterThanOrEqual(
    hoverBubble.x + hoverBubble.width + 7,
  );
  expect(
    Math.abs(
      actionBarBox.y +
        actionBarBox.height / 2 -
        (hoverBubble.y + hoverBubble.height / 2),
    ),
  ).toBeLessThanOrEqual(1);

  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/inline-message-actions.png` });
  await actionBar.getByRole("button", { name: "Open reactions" }).click();
  const picker = page.locator("em-emoji-picker");
  await expect(picker).toBeVisible();
  await picker.locator("input[type='search']").fill("thumbs up");
  await picker.locator("button[aria-label='👍']").first().click();
  const reactionBar = lastRow.getByTestId("message-reactions");
  await expect(reactionBar).toBeVisible();
  await expect
    .poll(async () => {
      const [bubble, reactions, firstPill] = await Promise.all([
        lastBubble.boundingBox(),
        reactionBar.boundingBox(),
        reactionBar.getByRole("button").first().boundingBox(),
      ]);
      if (!bubble || !reactions || !firstPill) return false;
      return (
        reactions.y < bubble.y + bubble.height &&
        Math.abs(firstPill.x - bubble.x - 12) <= 1
      );
    })
    .toBe(true);
  const reactionPillStyle = await reactionBar
    .getByRole("button")
    .first()
    .evaluate((pill) => {
      const style = getComputedStyle(pill);
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        opacity: Number(style.opacity),
      };
    });
  expect(reactionPillStyle.opacity).toBe(1);
  expect(reactionPillStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(reactionPillStyle.color).not.toContain("/");

  const [avatarBox, lastBubbleBox, reactionBarBox] = await Promise.all([
    lastRow.locator('[data-testid^="message-avatar-"]').boundingBox(),
    lastBubble.boundingBox(),
    reactionBar.boundingBox(),
  ]);
  if (!avatarBox || !lastBubbleBox || !reactionBarBox) {
    throw new Error("Expected final avatar, bubble, and reaction geometry.");
  }
  expect(
    Math.abs(
      avatarBox.y + avatarBox.height - (lastBubbleBox.y + lastBubbleBox.height),
    ),
  ).toBeLessThanOrEqual(1);
  expect(reactionBarBox.y + reactionBarBox.height).toBeGreaterThan(
    avatarBox.y + avatarBox.height,
  );

  await actionBar.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(
    page.locator('[data-testid^="message-quick-reactions-"]'),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Reply", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.waitForTimeout(1_200);
  await page.mouse.move(0, 0);
  await waitForAnimations(page);
  const [top, bottom] = await Promise.all([
    firstRow.boundingBox(),
    isolatedRow.boundingBox(),
  ]);
  if (!top || !bottom) throw new Error("Expected grouped bubble geometry.");
  await page.screenshot({
    path: `${SHOTS}/left-aligned-continuation-bubbles.png`,
    clip: {
      x: Math.max(0, top.x - 12),
      y: Math.max(0, top.y - 12),
      width: Math.min(720, page.viewportSize()?.width ?? 720),
      height: bottom.y + bottom.height - top.y + 24,
    },
  });
});

test("direct messages use the same grouped message bubbles", async ({
  page,
}) => {
  await seedMessageBubbles(page);
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("channel-alice-tyler").click();
  await expect(page.getByTestId("chat-title")).toHaveText("alice-tyler");
  await waitForMockLiveSubscription(page, "alice-tyler");

  const suffix = Date.now();
  const first = `DM grouped bubble one ${suffix}`;
  const second = `DM grouped bubble two ${suffix}`;
  await page.evaluate(
    ({ alicePubkey, firstContent, secondContent, timestamp, tylerPubkey }) => {
      const emit = window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__;
      emit?.({
        channelName: "alice-tyler",
        content: `DM group barrier ${timestamp}`,
        createdAt: timestamp,
        pubkey: tylerPubkey,
      });
      emit?.({
        channelName: "alice-tyler",
        content: firstContent,
        createdAt: timestamp + 1,
        pubkey: alicePubkey,
      });
      emit?.({
        channelName: "alice-tyler",
        content: secondContent,
        createdAt: timestamp + 2,
        pubkey: alicePubkey,
      });
    },
    {
      alicePubkey: TEST_IDENTITIES.alice.pubkey,
      firstContent: first,
      secondContent: second,
      timestamp: Math.floor(Date.now() / 1_000),
      tylerPubkey: TEST_IDENTITIES.tyler.pubkey,
    },
  );

  const rowFor = (content: string) =>
    page.getByTestId("message-row").filter({ hasText: content });
  const firstBubble = rowFor(first).getByTestId("message-body-surface");
  const secondBubble = rowFor(second).getByTestId("message-body-surface");
  await expect(secondBubble).toBeVisible();
  const [firstRadii, secondRadii] = await Promise.all([
    firstBubble.evaluate((bubble) => {
      const style = getComputedStyle(bubble);
      return {
        bottomLeft: Number.parseFloat(style.borderBottomLeftRadius),
        bottomRight: Number.parseFloat(style.borderBottomRightRadius),
      };
    }),
    secondBubble.evaluate((bubble) => {
      const style = getComputedStyle(bubble);
      return {
        topLeft: Number.parseFloat(style.borderTopLeftRadius),
        topRight: Number.parseFloat(style.borderTopRightRadius),
      };
    }),
  ]);
  expect(firstRadii.bottomLeft).toBeLessThan(firstRadii.bottomRight);
  expect(secondRadii.topLeft).toBeLessThan(secondRadii.topRight);

  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/direct-message-bubbles.png` });
});

test("own-message bubbles align right and use the primary token", async ({
  page,
}) => {
  await seedRightAlignedOwnBubbles(page);
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");

  const suffix = Date.now();
  const otherContent = `Left-aligned message ${suffix}. ${"This longer message should use the wider conversation canvas without becoming difficult to scan. ".repeat(18)}`;
  const ownFirstContent = `My first right-aligned message ${suffix}`;
  const ownSecondContent = `My continued right-aligned message ${suffix}`;
  await page.evaluate(
    ({ alicePubkey, other, ownFirst, ownSecond, timestamp }) => {
      const emit = window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__;
      emit?.({
        channelName: "general",
        content: other,
        createdAt: timestamp,
        pubkey: alicePubkey,
      });
      const ownRoot = emit?.({
        channelName: "general",
        content: ownFirst,
        createdAt: timestamp + 1,
      });
      if (ownRoot) {
        emit?.({
          channelName: "general",
          content: `A reply to ${ownFirst}`,
          createdAt: timestamp + 2,
          parentEventId: ownRoot.id,
          pubkey: alicePubkey,
        });
      }
      emit?.({
        channelName: "general",
        content: ownSecond,
        createdAt: timestamp + 3,
      });
    },
    {
      alicePubkey: TEST_IDENTITIES.alice.pubkey,
      other: otherContent,
      ownFirst: ownFirstContent,
      ownSecond: ownSecondContent,
      timestamp: Math.floor(Date.now() / 1_000),
    },
  );

  const rowFor = (content: string) =>
    page.getByTestId("message-row").filter({ hasText: content });
  const otherRow = rowFor(otherContent);
  const ownFirstRow = rowFor(ownFirstContent);
  const ownSecondRow = rowFor(ownSecondContent);
  await expect(ownSecondRow).toBeVisible();
  await expect(ownFirstRow).toHaveClass(/own-message-row/);
  await expect(otherRow).not.toHaveClass(/own-message-row/);

  const [otherBubbleBox, ownBubbleBox] = await Promise.all([
    otherRow.getByTestId("message-body-surface").boundingBox(),
    ownFirstRow.getByTestId("message-body-surface").boundingBox(),
  ]);
  if (!otherBubbleBox || !ownBubbleBox) {
    throw new Error("Expected own-message bubble geometry.");
  }
  expect(ownBubbleBox.x).toBeGreaterThan(otherBubbleBox.x);
  await expect(
    ownFirstRow.locator('[data-testid^="message-avatar-"]'),
  ).toHaveCount(0);
  const ownHoverTimestamp = ownFirstRow.getByTestId("message-hover-timestamp");
  await expect(ownHoverTimestamp).toHaveCSS("opacity", "0");
  await ownFirstRow.getByTestId("message-body-surface").hover();
  await expect(ownHoverTimestamp).toHaveCSS("opacity", "1");
  const ownActions = ownFirstRow.locator(
    '[data-testid^="message-action-bar-"]',
  );
  await expect(ownActions).toHaveAttribute("data-presentation", "inline");
  await expect
    .poll(() =>
      ownActions.evaluate((actions) =>
        Number.parseFloat(getComputedStyle(actions).opacity),
      ),
    )
    .toBeGreaterThan(0.8);
  const [timestampTransition, actionTransition] = await Promise.all([
    ownHoverTimestamp.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        delay: style.transitionDelay,
        duration: style.transitionDuration,
      };
    }),
    ownActions.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        delay: style.transitionDelay,
        duration: style.transitionDuration,
      };
    }),
  ]);
  expect(timestampTransition).toEqual(actionTransition);
  expect(timestampTransition.delay).toBe("0s");
  await expect(
    ownActions.getByRole("button", { name: "Open reactions" }),
  ).toBeVisible();
  await expect(ownActions.getByRole("button", { name: "Reply" })).toBeVisible();
  await expect(
    ownActions.getByRole("button", { name: "More actions" }),
  ).toBeVisible();
  const ownActionsBox = await ownActions.boundingBox();
  if (!ownActionsBox) {
    throw new Error("Expected own-message inline action geometry.");
  }
  expect(ownActionsBox.x + ownActionsBox.width).toBeLessThanOrEqual(
    ownBubbleBox.x - 7,
  );
  expect(
    Math.abs(
      ownActionsBox.y +
        ownActionsBox.height / 2 -
        (ownBubbleBox.y + ownBubbleBox.height / 2),
    ),
  ).toBeLessThanOrEqual(2);

  const ownBubbleStyle = await ownFirstRow
    .getByTestId("message-body-surface")
    .evaluate((bubble) => {
      const style = getComputedStyle(bubble);
      const reference = document.createElement("div");
      reference.className = "bg-primary text-primary-foreground";
      document.body.append(reference);
      const referenceStyle = getComputedStyle(reference);
      const result = {
        backgroundColor: style.backgroundColor,
        color: style.color,
        primaryBackgroundColor: referenceStyle.backgroundColor,
        primaryForegroundColor: referenceStyle.color,
      };
      reference.remove();
      return result;
    });
  expect(ownBubbleStyle.backgroundColor).toBe(
    ownBubbleStyle.primaryBackgroundColor,
  );
  expect(ownBubbleStyle.color).toBe(ownBubbleStyle.primaryForegroundColor);
  const ownActionColor = await ownActions
    .getByRole("button", { name: "Open reactions" })
    .evaluate((button) => getComputedStyle(button).color);
  expect(ownActionColor).not.toBe(ownBubbleStyle.primaryForegroundColor);
  await expect(ownFirstRow.locator(".message-markdown")).toHaveCSS(
    "text-align",
    "left",
  );
  await expect(ownFirstRow.getByTestId("message-author")).toHaveCount(0);
  const otherBubble = otherRow.getByTestId("message-body-surface");
  await expect(otherBubble.getByTestId("message-author")).toHaveCount(0);
  await expect(
    ownSecondRow.locator('[data-testid^="message-avatar-"]'),
  ).toHaveCount(0);
  await expect(otherRow.getByTestId("message-author")).toHaveCount(1);
  await expect(
    otherBubble.getByTestId("message-bubble-avatar-anchor"),
  ).toBeVisible();

  const otherHoverTimestamp = otherRow.getByTestId("message-hover-timestamp");
  await expect(
    otherHoverTimestamp.getByTestId("message-timestamp"),
  ).toHaveCount(1);
  await expect(otherHoverTimestamp).toHaveCSS("opacity", "0");
  await otherBubble.hover();
  await expect(otherHoverTimestamp).toHaveCSS("opacity", "1");

  const [otherAvatarBox, otherAlignedBubbleBox] = await Promise.all([
    otherRow.locator('[data-testid^="message-avatar-"]').boundingBox(),
    otherBubble.boundingBox(),
  ]);
  if (!otherAvatarBox || !otherAlignedBubbleBox) {
    throw new Error("Expected incoming avatar and bubble geometry.");
  }
  expect(
    Math.abs(
      otherAvatarBox.y +
        otherAvatarBox.height -
        (otherAlignedBubbleBox.y + otherAlignedBubbleBox.height),
    ),
  ).toBeLessThanOrEqual(1);

  const threadSummary = ownFirstRow.getByTestId("message-thread-summary");
  await expect(threadSummary).toBeVisible();
  const bubbleForeground = ownBubbleStyle.primaryForegroundColor;
  await threadSummary.hover();
  await expect(threadSummary).toHaveCSS("color", bubbleForeground);
  await expect(
    threadSummary.getByTestId("message-thread-summary-reply-count"),
  ).toHaveCSS("color", bubbleForeground);
  await expect(
    threadSummary.getByTestId("message-thread-summary-hover-action"),
  ).toHaveCSS("color", bubbleForeground);
  await expect(
    threadSummary.getByTestId("message-thread-summary-surface"),
  ).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  const contentColumnBox = await otherRow
    .getByTestId("message-content-column")
    .boundingBox();
  if (!contentColumnBox) {
    throw new Error("Expected own-message content-column geometry.");
  }
  expect(otherAlignedBubbleBox.width).toBeGreaterThan(
    contentColumnBox.width * (2 / 3),
  );
  expect(otherAlignedBubbleBox.width).toBeLessThanOrEqual(
    contentColumnBox.width * 0.72 + 1,
  );

  const [firstRadii, secondRadii] = await Promise.all([
    ownFirstRow.getByTestId("message-body-surface").evaluate((bubble) => {
      const style = getComputedStyle(bubble);
      return {
        bottomLeft: Number.parseFloat(style.borderBottomLeftRadius),
        bottomRight: Number.parseFloat(style.borderBottomRightRadius),
      };
    }),
    ownSecondRow.getByTestId("message-body-surface").evaluate((bubble) => {
      const style = getComputedStyle(bubble);
      return {
        topLeft: Number.parseFloat(style.borderTopLeftRadius),
        topRight: Number.parseFloat(style.borderTopRightRadius),
      };
    }),
  ]);
  expect(firstRadii.bottomRight).toBeLessThan(firstRadii.bottomLeft);
  expect(secondRadii.topRight).toBeLessThan(secondRadii.topLeft);

  await ownFirstRow.getByTestId("message-body-surface").hover();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/right-aligned-own-bubbles.png` });
});

test("standalone huddle cards do not get a second message container", async ({
  page,
}) => {
  await seedMessageBubbles(page);
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");

  await page.evaluate((kind) => {
    window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName: "general",
      content: JSON.stringify({
        ephemeral_channel_id: "10000000-0000-4000-8000-000000000009",
      }),
      createdAt: Math.floor(Date.now() / 1_000),
      id: "f".repeat(64),
      kind,
    });
  }, KIND_HUDDLE_STARTED);

  const attachment = page.getByTestId("huddle-attachment");
  const row = attachment.locator(
    "xpath=ancestor::*[@data-testid='message-row']",
  );
  await expect(attachment).toBeVisible();
  await expect(row.getByTestId("message-body-surface")).toHaveCount(0);
  await expect(
    row.getByTestId("message-standalone-card-content"),
  ).toBeVisible();

  await waitForAnimations(page);
  await row.screenshot({ path: `${SHOTS}/standalone-huddle-card.png` });
});
