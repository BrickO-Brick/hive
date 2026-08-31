import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import {
  AGENT_A,
  AGENT_B,
  KEEP_MENTIONED_AGENTS_PINNED_STORAGE_KEY,
  RANDOM_CHANNEL_ID,
  addMention,
  automaticallyMention,
  channelComposer,
  emitMockMessage,
  expectComposerCaretAtEnd,
  focusComposerEnd,
  installAudienceFixtures,
  keepMentionedAgentsPinned,
  openGeneral,
  openThread,
  pressPrimaryShiftM,
  readComposerCaret,
  readOutgoingMentionPubkeys,
  readPersistedDraft,
  seedTheme,
  threadComposer,
} from "../helpers/persistentAgentAudience";

const SHOTS = "test-results/persistent-agent-audience";

test.beforeEach(async ({ page }) => {
  await page.addInitScript((storageKey) => {
    window.localStorage.removeItem(storageKey);
  }, KEEP_MENTIONED_AGENTS_PINNED_STORAGE_KEY);
});

test("keeps a queued-attachment send locked through upload and send settlement", async ({
  page,
}) => {
  await installAudienceFixtures(page, {
    deferredComposerUploads: true,
    uploadDelayMs: 2_000,
    sendMessageDelayMs: 2_000,
    uploadDescriptors: [
      {
        filename: "delayed-video.mp4",
        sha256: "d".repeat(64),
        size: 16,
        type: "video/mp4",
        uploaded: 1,
        url: `https://mock.relay/media/${"d".repeat(64)}.mp4`,
      },
    ],
  });
  await openGeneral(page);

  const composer = channelComposer(page);
  const composerForm = composer.getByTestId("message-composer");
  const input = composer.getByTestId("message-input");
  await input.fill("delayed upload");

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    composer.getByRole("button", { name: "Attach file" }).click(),
  ]);
  await chooser.setFiles({
    buffer: Buffer.from("delayed video"),
    mimeType: "video/mp4",
    name: "delayed-video.mp4",
  });

  const sendAttempts = () =>
    page.evaluate(
      () =>
        window.__BUZZ_E2E_COMMAND_LOG__?.filter(
          (entry) => entry.command === "send_channel_message",
        ).length ?? 0,
    );
  const sendAttemptsBefore = await sendAttempts();
  await input.press("Enter");
  await expect(composer.getByTestId("composer-upload-progress")).toBeVisible();

  // Observe the synchronous lock itself after upload has started. The exact
  // premature-release mutation (`void uploadSettled; await Promise.resolve()`)
  // has already cleared this attribute by this boundary, before any retryable
  // downstream command or restored-audience timing can obscure the defect.
  await expect(composerForm).toHaveAttribute("data-submit-locked", "true");
  await input.press("Enter");
  await input.press("Enter");
  await expect(composerForm).toHaveAttribute("data-submit-locked", "true");

  await expect.poll(sendAttempts).toBe(sendAttemptsBefore + 1);

  // Command entry marks the independently delayed finishSend() window. Keep
  // the synchronous lock held and fence repeated submits until it settles.
  await expect(composer.getByTestId("composer-upload-progress")).toBeVisible();
  await expect(composerForm).toHaveAttribute("data-submit-locked", "true");
  await input.press("Enter");
  await input.press("Enter");
  await expect(composerForm).toHaveAttribute("data-submit-locked", "true");

  await expect(
    page
      .getByTestId("message-row")
      .filter({ hasText: "delayed upload" })
      .last(),
  ).toBeVisible({ timeout: 5_000 });
  await expect(composerForm).toHaveAttribute("data-submit-locked", "false");
});

for (const surface of ["channel", "thread"] as const) {
  for (const automatic of [false, true]) {
    for (const mode of ["toolbar", "typed"] as const) {
      test(`${surface}: ${mode} mentions respect auto=${automatic} and second-avatar removal`, async ({
        page,
      }) => {
        if (automatic) await keepMentionedAgentsPinned(page);
        await installAudienceFixtures(page);
        await (surface === "channel" ? openGeneral(page) : openThread(page));
        const composer =
          surface === "channel" ? channelComposer(page) : threadComposer(page);
        const input = composer.getByTestId("message-input");
        await addMention(composer, "Morgarita", mode);
        await addMention(composer, "Vogue", mode);
        await input.pressSequentially("review ");
        await addMention(composer, "Vogue", mode);
        await input.pressSequentially("now");
        const rawDraft = (await input.textContent()) ?? "";
        // Chromium may preserve the authored trailing separator as NBSP when
        // focus moves to the toolbar. Preserve it; do not normalize sent text.
        expect(rawDraft).toMatch(
          /^@Morgarita @Vogue review[ \u00a0]@Vogue now$/,
        );
        const expectedMessage = rawDraft.replaceAll("@Vogue ", "");
        await expect(
          composer.getByTestId("composer-address-lock-avatar"),
        ).toHaveCount(2);
        await expect(
          composer.getByTestId(`composer-address-lock-${AGENT_A}`),
        ).toBeVisible();
        await expect(
          composer.getByTestId(`composer-address-lock-${AGENT_B}`),
        ).toBeVisible();
        expect(
          await page.evaluate(
            (key) => localStorage.getItem(key) === "true",
            KEEP_MENTIONED_AGENTS_PINNED_STORAGE_KEY,
          ),
        ).toBe(automatic);
        await composer
          .getByRole("button", {
            name: "Remove Vogue from this and future messages",
            exact: true,
          })
          .click();
        expect(await input.textContent()).toBe(expectedMessage);
        await expect(
          composer.getByTestId("composer-address-lock-avatar"),
        ).toHaveCount(1);
        await expect(
          composer.getByTestId(`composer-address-lock-${AGENT_B}`),
        ).toHaveCount(0);
        await input.press("Enter");
        await expect
          .poll(() => readOutgoingMentionPubkeys(page, expectedMessage))
          .toEqual([AGENT_A]);
        await expect(composer.getByTestId("message-composer")).toHaveAttribute(
          "data-submit-locked",
          "false",
        );
        await expect(input).toHaveText(automatic ? "@Morgarita " : "");
        await expect(
          composer.getByTestId("composer-address-lock-avatar"),
        ).toHaveCount(automatic ? 1 : 0);
        await input.pressSequentially("follow-up");
        await input.press("Enter");
        await expect
          .poll(() =>
            readOutgoingMentionPubkeys(
              page,
              automatic ? "@Morgarita follow-up" : "follow-up",
            ),
          )
          .toEqual(automatic ? [AGENT_A] : []);
        await expect(
          composer.getByTestId(`composer-address-lock-${AGENT_B}`),
        ).toHaveCount(0);
      });
    }
  }
}

test("an upload finishing cannot restore an agent removed from the next draft", async ({
  page,
}) => {
  await keepMentionedAgentsPinned(page);
  await installAudienceFixtures(page, {
    deferredComposerUploads: true,
    uploadDelayMs: 3_500,
    uploadDescriptors: [
      {
        filename: "audience.mp4",
        sha256: "c".repeat(64),
        size: 16,
        type: "video/mp4",
        uploaded: 1,
        url: `https://mock.relay/media/${"c".repeat(64)}.mp4`,
      },
    ],
  });
  await openThread(page);
  const composer = threadComposer(page);
  const input = composer.getByTestId("message-input");
  await addMention(composer, "Morgarita", "typed");
  await addMention(composer, "Vogue", "typed");
  await input.pressSequentially("queued review");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    composer.getByRole("button", { name: "Attach file" }).click(),
  ]);
  await chooser.setFiles({
    buffer: Buffer.from("queued video"),
    mimeType: "video/mp4",
    name: "audience.mp4",
  });
  await input.press("Enter");
  await expect(composer.getByTestId("composer-upload-progress")).toBeVisible();
  await expect(input).toHaveText("@Morgarita @Vogue ");
  // Remove the leading mention so this catches stale restoration independently
  // of the second-avatar removal bug covered by the matrix above.
  await composer.getByTestId(`composer-address-lock-remove-${AGENT_A}`).click();
  await expect(input).toHaveText("@Vogue ");
  await expect(composer.getByTestId("message-composer")).toHaveAttribute(
    "data-submit-locked",
    "true",
  );
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toHaveCount(0);
  await expect(composer.getByTestId("message-composer")).toHaveAttribute(
    "data-submit-locked",
    "false",
    { timeout: 10_000 },
  );
  await expect(
    page.getByTestId("message-row").filter({ hasText: "queued review" }).last(),
  ).toBeVisible();
  await expect(input).toHaveText("@Vogue ");
  await focusComposerEnd(input);
  await input.pressSequentially("follow-up after upload");
  await expect(input).toHaveText("@Vogue follow-up after upload");
  await input.press("Enter");
  await expect
    .poll(() =>
      readOutgoingMentionPubkeys(page, "@Vogue follow-up after upload"),
    )
    .toEqual([AGENT_B]);
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toHaveCount(0);
});

test("keyboard users can inspect and remove an overflow recipient", async ({
  page,
}) => {
  const agentC = "c".repeat(64);
  const agentD = "d".repeat(64);
  await keepMentionedAgentsPinned(page);
  await installAudienceFixtures(page, {
    additionalAgents: [
      { pubkey: agentC, name: "Orchid" },
      { pubkey: agentD, name: "Zinnia" },
    ],
  });
  await openGeneral(page);
  const composer = channelComposer(page);
  const input = composer.getByTestId("message-input");
  for (const name of ["Morgarita", "Vogue", "Orchid", "Zinnia"]) {
    await addMention(composer, name, "typed");
  }
  await expect(input).toHaveText("@Morgarita @Vogue @Orchid @Zinnia ");
  await expect(
    composer.getByTestId("composer-address-lock-avatar"),
  ).toHaveCount(3);
  const overflow = composer.getByRole("button", {
    name: "Show 1 more mentioned agents",
    exact: true,
  });
  await expect(overflow).toHaveText("+1");
  await composer.getByRole("button", { name: "Mention someone" }).focus();
  for (let index = 0; index < 4; index += 1) await page.keyboard.press("Tab");
  await expect(overflow).toBeFocused();
  await page.keyboard.press("Enter");
  const removeHidden = page.getByRole("button", {
    name: "Remove Zinnia from this and future messages",
    exact: true,
  });
  await expect(removeHidden).toBeVisible();
  await expect(removeHidden).toContainText("Zinnia");
  await expect(removeHidden).toBeFocused();
  await page.keyboard.press("Space");
  await expect(removeHidden).toHaveCount(0);
  await expect(overflow).toHaveCount(0);
  await expect(input).toHaveText("@Morgarita @Vogue @Orchid ");
  for (const pubkey of [AGENT_A, AGENT_B, agentC]) {
    await expect(
      composer.getByTestId(`composer-address-lock-${pubkey}`),
    ).toBeVisible();
  }
  await focusComposerEnd(input);
  await input.pressSequentially("overflow review");
  await input.press("Enter");
  await expect
    .poll(() =>
      readOutgoingMentionPubkeys(
        page,
        "@Morgarita @Vogue @Orchid overflow review",
      ),
    )
    .toEqual([AGENT_A, AGENT_B, agentC]);
  await expect(composer.getByTestId("message-composer")).toHaveAttribute(
    "data-submit-locked",
    "false",
  );
  await expect(input).toHaveText("@Morgarita @Vogue @Orchid ");
  await expect(overflow).toHaveCount(0);
});

test("automatically mentions multiple agents from the mention picker", async ({
  page,
}) => {
  await installAudienceFixtures(page);
  await openGeneral(page);

  const composer = channelComposer(page);
  await automaticallyMention(composer, "Morgarita");
  await automaticallyMention(composer, "Vogue");

  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toBeVisible();
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_B}`),
  ).toBeVisible();
  await expect(
    composer.getByRole("button", { name: "Mention someone" }),
  ).toBeVisible();
});

test("keeps the composer and global automatic mention settings synchronized", async ({
  page,
}) => {
  await installAudienceFixtures(page);
  await openGeneral(page);

  const composer = channelComposer(page);
  await composer.getByTestId("message-insert-mention").click();
  const optionsTrigger = composer.getByTestId("mention-options-trigger");
  await expect(optionsTrigger).toHaveAttribute("aria-expanded", "false");
  await composer
    .getByTestId("mention-autocomplete")
    .getByRole("button", { name: "Automatically mention Morgarita" })
    .click();
  await expect(optionsTrigger).toHaveAttribute("aria-expanded", "true");
  const composerToggle = composer.getByTestId(
    "mention-keep-agents-pinned-toggle",
  );
  await expect(composerToggle).toHaveAttribute("data-state", "unchecked");
  await expect(composerToggle).toHaveAttribute("data-state", "checked", {
    timeout: 1_500,
  });

  await page
    .getByTestId("composer-auto-pin-confirmation")
    .getByRole("button", { name: "Turn off" })
    .click();
  await expect(composer.getByTestId("mention-autocomplete")).toBeVisible();
  await expect(optionsTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(composerToggle).toHaveAttribute("data-state", "checked");
  await expect(composerToggle).toHaveAttribute("data-state", "unchecked", {
    timeout: 1_500,
  });

  await page.getByTestId("open-settings").click();
  await page.getByTestId("profile-popover-settings").click();
  await expect(page.getByTestId("settings-view")).toBeVisible();
  await page.getByTestId("settings-nav-agents").click();
  const settingsToggle = page
    .getByTestId("settings-automatic-agent-mentions")
    .getByRole("switch", { name: "Automatically mention agents" });
  await expect(settingsToggle).toHaveAttribute("data-state", "unchecked");

  await page.getByTestId("settings-back-to-app").click();
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toHaveCount(0);
  await composer.getByTestId("message-insert-mention").click();
  await composer.getByTestId("mention-options-trigger").click();
  await expect(
    composer.getByTestId("mention-keep-agents-pinned-toggle"),
  ).toHaveAttribute("data-state", "unchecked");
  await expect(
    composer.getByRole("button", {
      name: "Automatically mention Morgarita",
    }),
  ).toHaveAttribute("aria-pressed", "false");
});

test("hides automatic mention state while disabled without clearing the draft", async ({
  page,
}) => {
  await installAudienceFixtures(page);
  await openGeneral(page);

  const composer = channelComposer(page);
  const input = composer.getByTestId("message-input");
  await automaticallyMention(composer, "Morgarita");
  await input.type("draft text");
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toBeVisible();

  await page.getByTestId("channel-management-trigger").click();
  await expect(page.getByTestId("channel-management-sheet")).toBeVisible();
  await page.getByTestId("channel-management-archive").click();
  await expect(page.getByTestId("channel-management-unarchive")).toBeVisible();
  await page.getByTestId("auxiliary-panel-close").click();

  await expect(input).toHaveAttribute("contenteditable", "false");
  await expect(input).toHaveText("@Morgarita draft text");
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toHaveCount(0);

  await page.getByTestId("channel-management-trigger").click();
  await expect(page.getByTestId("channel-management-sheet")).toBeVisible();
  await page.getByTestId("channel-management-unarchive").click();
  await expect(page.getByTestId("channel-management-archive")).toBeVisible();
  await page.getByTestId("auxiliary-panel-close").click();

  await expect(input).toHaveAttribute("contenteditable", "true");
  await expect(input).toHaveText("@Morgarita draft text");
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toBeVisible();
});

test("Tab inserts a one-time agent mention by default", async ({ page }) => {
  await installAudienceFixtures(page);
  await openGeneral(page);

  const composer = channelComposer(page);
  const input = composer.getByTestId("message-input");
  await input.fill("@Mor");
  await expect(composer.getByTestId("mention-autocomplete")).toBeVisible();

  await input.press("Tab");

  await expect(input).toHaveText("@Morgarita ");
  await expect(composer.getByTestId("mention-autocomplete")).toHaveCount(0);
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toBeVisible();
  const selectAllShortcut = await page.evaluate(() =>
    /mac|iphone|ipad|ipod/i.test(navigator.platform) ? "Meta+A" : "Control+A",
  );
  await input.press(selectAllShortcut);
  await input.press("Backspace");
  await expect(input).toHaveText("");
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toHaveCount(0);
});

test("disabling automatic mentions leaves the composer empty after send", async ({
  page,
}) => {
  await keepMentionedAgentsPinned(page);
  await installAudienceFixtures(page);
  await openGeneral(page);

  const composer = channelComposer(page);
  const input = composer.getByTestId("message-input");
  await composer.getByTestId("message-insert-mention").click();
  await composer.getByTestId("mention-options-trigger").click();
  const preference = composer.getByTestId("mention-keep-agents-pinned-toggle");
  await expect(preference).toHaveAttribute("data-state", "checked");
  await preference.click();
  await expect(preference).toHaveAttribute("data-state", "unchecked");
  await input.press("Escape");

  await input.fill("@Mor");
  await expect(composer.getByTestId("mention-autocomplete")).toBeVisible();
  await input.press("Tab");
  await input.type("test");
  await expect(input).toHaveText("@Morgarita test");
  await input.press("Enter");

  await expect(input).toHaveText("");
  await expect(input.locator(".agent-mention-highlight")).toHaveCount(0);
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toHaveCount(0);
  await expect
    .poll(() => readOutgoingMentionPubkeys(page, "@Morgarita test"))
    .toContain(AGENT_A);
});

test("primary+Shift+M addresses the default agent, then toggles the highlighted agent in place", async ({
  page,
}) => {
  await keepMentionedAgentsPinned(page);
  await installAudienceFixtures(page);
  await openGeneral(page);

  const composer = channelComposer(page);
  const input = composer.getByTestId("message-input");
  await input.fill("draft text");
  await pressPrimaryShiftM(page);

  await expect(input).toHaveText("@alice draft text");
  await expect(input.locator(".agent-mention-highlight")).toHaveText("alice");
  await expect(
    page.getByTestId("composer-auto-pin-confirmation"),
  ).toContainText("alice will be mentioned automatically");
  await pressPrimaryShiftM(page);
  await expect(input).toHaveText("draft text");
  await pressPrimaryShiftM(page);
  await expect(input).toHaveText("@alice draft text");
  await expect(
    composer.getByTestId("composer-address-locks").getByRole("button", {
      name: /^Remove .+ from this and future messages$/,
    }),
  ).toHaveCount(1);

  await input.fill("@Vog");
  const menu = composer.getByTestId("mention-autocomplete");
  await expect(menu.getByTestId(`mention-suggestion-${AGENT_B}`)).toHaveClass(
    /(?:^|\s)bg-accent(?:\s|$)/,
  );
  await pressPrimaryShiftM(page);

  await expect(menu).toBeVisible();
  await expect(input).toHaveText("@Vogue ");
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_B}`),
  ).toBeVisible();
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toHaveCount(0);
  await expect(
    composer.getByTestId("composer-address-locks").getByRole("button", {
      name: /^Remove .+ from this and future messages$/,
    }),
  ).toHaveCount(1);
});

test("primary+Shift+M favors the most recently mentioned eligible agent", async ({
  page,
}) => {
  await installAudienceFixtures(page);
  await openGeneral(page);
  await emitMockMessage(page, "Please ask Vogue", [AGENT_B]);

  const input = channelComposer(page).getByTestId("message-input");
  await input.fill("draft text");
  await input.press("ArrowLeft");
  await input.press("ArrowLeft");
  await expect.poll(() => readComposerCaret(input)).toBe(8);
  await pressPrimaryShiftM(page);

  await expect(input).toHaveText("@Vogue draft text");
  await expect.poll(() => readComposerCaret(input)).toBe(15);
  await pressPrimaryShiftM(page);
  await expect(input).toHaveText("draft text");
  await pressPrimaryShiftM(page);
  await expect(input).toHaveText("@Vogue draft text");
});

test("the mention button opens settings and can undo an address", async ({
  page,
}) => {
  await keepMentionedAgentsPinned(page);
  await installAudienceFixtures(page);
  await openGeneral(page);

  const composer = channelComposer(page);
  await automaticallyMention(composer, "Morgarita");
  const input = composer.getByTestId("message-input");
  const ingress = composer.getByRole("button", {
    name: "Mention someone",
  });

  await input.type("draft text");
  await ingress.click();
  const menu = composer.getByTestId("mention-autocomplete");
  await expect(menu).toBeVisible();
  await expect(input).toHaveText("@Morgarita draft text");
  await page.getByTestId("mention-options-trigger").click();
  const preference = page.getByTestId("mention-keep-agents-pinned-toggle");
  await expect(preference).toHaveAttribute("data-state", "checked");
  const layerBox = await composer
    .getByTestId("mention-autocomplete-layer")
    .boundingBox();
  const optionsBox = await page
    .getByTestId("mention-options-trigger")
    .boundingBox();
  expect(layerBox).not.toBeNull();
  expect(optionsBox).not.toBeNull();
  if (!layerBox || !optionsBox) throw new Error("Mention tray is not laid out");
  await page.mouse.click(layerBox.x + 4, optionsBox.y + optionsBox.height / 2);
  await expect(menu).toHaveCount(0);
  await expect(input).toHaveText("@Morgarita draft text");
  await ingress.click();
  await expect(menu).toBeVisible();
  await expect(page.getByTestId("mention-options-trigger")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(
    page.getByTestId("mention-keep-agents-pinned-toggle"),
  ).toHaveCount(0);
  await ingress.click();
  await expect(menu).toHaveCount(0);
  await expect(input).toHaveText("@Morgarita draft text");
  await ingress.click();
  await expect(menu).toBeVisible();
  await expect(page.getByTestId("user-profile-panel")).toHaveCount(0);
  await expect(
    menu.getByRole("button", {
      name: "Don't automatically mention Morgarita in this conversation",
    }),
  ).toHaveAttribute("aria-pressed", "true");

  await menu
    .getByRole("button", {
      name: "Don't automatically mention Morgarita in this conversation",
    })
    .click();
  await expect(input).toHaveText("draft text");
  await page.getByTestId("mention-options-trigger").click();
  await expect(preference).toHaveAttribute("data-state", "checked");
  await preference.click();
  await expect(preference).toHaveAttribute("data-state", "unchecked");
  await expect(
    composer.getByRole("button", { name: "Mention someone" }),
  ).toBeVisible();
  await input.fill("");

  await menu
    .getByRole("button", { name: "Mention Morgarita", exact: true })
    .click();
  await expect(input).toHaveText("@Morgarita ");
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toBeVisible();

  await input.type("later");
  await input.press("Enter");
  await expect
    .poll(() => readOutgoingMentionPubkeys(page, "@Morgarita later"))
    .toEqual([AGENT_A]);
  await expect(input).toHaveText("");
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key) === "true",
      KEEP_MENTIONED_AGENTS_PINNED_STORAGE_KEY,
    ),
  ).toBe(false);
});

test("always-mentioned agents remain selected without replaying their animation while Enter-send resolves", async ({
  page,
}) => {
  await installAudienceFixtures(page, {
    sendMessageDelayMs: 1_500,
    usersBatchDelayMs: 1_500,
  });
  await openThread(page);

  const composer = threadComposer(page);
  await automaticallyMention(composer, "Morgarita");
  const input = composer.getByTestId("message-input");
  await input.evaluate((element) => {
    const snapshots = [element.textContent ?? ""];
    new MutationObserver(() =>
      snapshots.push(element.textContent ?? ""),
    ).observe(element, { childList: true, characterData: true, subtree: true });
    (
      window as typeof window & { __BUZZ_COMPOSER_TEXT_SNAPSHOTS__?: string[] }
    ).__BUZZ_COMPOSER_TEXT_SNAPSHOTS__ = snapshots;
  });
  const avatar = composer.getByTestId(`composer-address-lock-${AGENT_A}`);
  const initialPulseVersion = Number(
    await avatar.getAttribute("data-pulse-version"),
  );
  await input.type("hello");
  await input.evaluate((element) => {
    const snapshots = (
      window as typeof window & { __BUZZ_COMPOSER_TEXT_SNAPSHOTS__?: string[] }
    ).__BUZZ_COMPOSER_TEXT_SNAPSHOTS__;
    snapshots?.splice(0, snapshots.length, element.textContent ?? "");
  });
  await input.press("Enter");

  await expect(input).toHaveText("@Morgarita ", { timeout: 500 });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __BUZZ_COMPOSER_TEXT_SNAPSHOTS__?: string[];
            }
          ).__BUZZ_COMPOSER_TEXT_SNAPSHOTS__ ?? [],
      ),
    )
    .not.toContain("");
  await expect(avatar).toHaveAttribute(
    "data-pulse-version",
    String(initialPulseVersion),
    { timeout: 500 },
  );
  await expect(
    composer.getByRole("button", { name: "Mention someone" }),
  ).toBeVisible();
  await expect(input).toBeFocused();
  await expect(composer.getByTestId("mention-autocomplete")).toHaveCount(0);

  await expect
    .poll(() => readOutgoingMentionPubkeys(page, "@Morgarita hello"))
    .toContain(AGENT_A);
  await expect(input).toHaveText("@Morgarita ");

  const sentRow = page
    .getByTestId("message-row")
    .filter({ hasText: "hello" })
    .last();
  const addressPrefix = sentRow.locator(
    "[data-mention].agent-mention-highlight",
    { hasText: "Morgarita" },
  );
  await expect(addressPrefix).toBeVisible();
  await expect(addressPrefix).toHaveText("Morgarita");

  await input.type("follow up");
  await input.press("Enter");
  const inlineMentionRow = page
    .getByTestId("message-row")
    .filter({ hasText: "follow up" })
    .last();
  await expect(
    inlineMentionRow.locator("[data-mention].agent-mention-highlight", {
      hasText: "Morgarita",
    }),
  ).toHaveCount(1);
});

test("a failed always-mentioned send shakes the composer avatar without replaying its selection animation", async ({
  page,
}) => {
  await installAudienceFixtures(page, {
    sendMessageDelayMs: 500,
    sendMessageErrors: ["simulated send failure"],
  });
  await openThread(page);

  const composer = threadComposer(page);
  await automaticallyMention(composer, "Morgarita");
  const input = composer.getByTestId("message-input");
  const avatar = composer.getByTestId(`composer-address-lock-${AGENT_A}`);
  const initialPulseVersion = Number(
    await avatar.getAttribute("data-pulse-version"),
  );
  await expect(avatar).toHaveAttribute("data-shake-version", "0");

  await input.type("please retry");
  await input.press("Enter");

  await expect(avatar).toHaveAttribute(
    "data-pulse-version",
    String(initialPulseVersion),
    { timeout: 500 },
  );
  await expect(input).toHaveText("@Morgarita please retry");
  await expect(avatar).toHaveAttribute("data-shake-version", "1");
});

test("a manual mention persists when automatic mentions are enabled", async ({
  page,
}) => {
  await keepMentionedAgentsPinned(page);
  await installAudienceFixtures(page, { sendMessageDelayMs: 1_500 });
  await openGeneral(page);

  const composer = channelComposer(page);
  const input = composer.getByTestId("message-input");
  await input.fill("@Mor");
  await expect(composer.getByTestId("mention-autocomplete")).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveText("@Morgarita ");
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toBeVisible();

  const autoPinConfirmation = page.getByTestId(
    "composer-auto-pin-confirmation",
  );
  await expect(autoPinConfirmation).toContainText(
    "Morgarita will be mentioned automatically",
  );
  await expect(autoPinConfirmation).not.toContainText(
    "Future messages in this channel will include this agent.",
  );
  await expect(autoPinConfirmation).toHaveAttribute("data-side", "right");
  await expect(autoPinConfirmation.locator("span")).toHaveCSS(
    "white-space",
    "nowrap",
  );
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Morgarita will be mentioned automatically" }),
  ).toHaveCount(0);
  const addressControlBox = await composer
    .getByTestId("composer-address-locks")
    .locator("..")
    .boundingBox();
  const confirmationBox = await autoPinConfirmation.boundingBox();
  expect(addressControlBox).not.toBeNull();
  expect(confirmationBox).not.toBeNull();
  if (!addressControlBox || !confirmationBox) {
    throw new Error("Automatic mention confirmation is not laid out");
  }
  expect(confirmationBox.x).toBeGreaterThan(
    addressControlBox.x + addressControlBox.width,
  );
  const turnOffAction = autoPinConfirmation.getByRole("button", {
    name: "Turn off",
  });
  await expect(turnOffAction).toHaveRole("button");
  await expect(turnOffAction).toHaveText("Turn off");

  await input.press("Escape");
  await expect(autoPinConfirmation).toHaveCount(0);

  await input.type("hello");
  await input.press("Enter");

  await expect(input).toHaveText("@Morgarita ", { timeout: 2_500 });
  await expect(input.locator("[data-placeholder]")).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toBeVisible({ timeout: 2_500 });
  await expect(autoPinConfirmation).toHaveCount(0);
  await expect
    .poll(() => readOutgoingMentionPubkeys(page, "@Morgarita hello"))
    .toContain(AGENT_A);

  await input.fill("follow up");
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toHaveCount(0);
  await input.press("Enter");
  await expect
    .poll(() => readOutgoingMentionPubkeys(page, "follow up"))
    .not.toContain(AGENT_A);
});

test("the auto-pin popover can turn off automatic agent mentions", async ({
  page,
}) => {
  await keepMentionedAgentsPinned(page);
  await installAudienceFixtures(page);
  await openGeneral(page);

  const composer = channelComposer(page);
  const input = composer.getByTestId("message-input");
  await input.fill("@Mor");
  await expect(composer.getByTestId("mention-autocomplete")).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveText("@Morgarita ");

  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toBeVisible();
  const autoPinConfirmation = page.getByTestId(
    "composer-auto-pin-confirmation",
  );
  await expect(autoPinConfirmation).toContainText(
    "Morgarita will be mentioned automatically",
  );
  await autoPinConfirmation.getByRole("button", { name: "Turn off" }).click();

  await expect(composer.getByTestId("mention-autocomplete")).toBeVisible();
  await expect(composer.getByTestId("mention-options-trigger")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(
    composer.getByTestId("mention-keep-agents-pinned-toggle"),
  ).toHaveAttribute("data-state", "unchecked");
  await expect(input).toHaveText("@Morgarita ");
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toBeVisible();
  await expect(autoPinConfirmation).toHaveCount(0);

  await input.press("Escape");
  await expect(composer.getByTestId("mention-autocomplete")).toHaveCount(0);
});

test("the auto-pin popover remains open while hovered", async ({ page }) => {
  await keepMentionedAgentsPinned(page);
  await installAudienceFixtures(page);
  await openGeneral(page);

  const composer = channelComposer(page);
  const input = composer.getByTestId("message-input");
  await input.fill("@Mor");
  await expect(composer.getByTestId("mention-autocomplete")).toBeVisible();
  await input.press("Tab");

  const autoPinConfirmation = page.getByTestId(
    "composer-auto-pin-confirmation",
  );
  await autoPinConfirmation.hover();
  await page.waitForTimeout(4_250);
  await expect(autoPinConfirmation).toBeVisible();

  await input.press("Escape");
  await expect(autoPinConfirmation).toHaveCount(0);
});

test("removing the mention chip dismisses the auto-pin popover", async ({
  page,
}) => {
  await keepMentionedAgentsPinned(page);
  await installAudienceFixtures(page);
  await openGeneral(page);

  const composer = channelComposer(page);
  const input = composer.getByTestId("message-input");
  await input.fill("@Mor");
  await expect(composer.getByTestId("mention-autocomplete")).toBeVisible();
  await input.press("Tab");

  const autoPinConfirmation = page.getByTestId(
    "composer-auto-pin-confirmation",
  );
  await expect(autoPinConfirmation).toBeVisible();

  const selectAllShortcut = await page.evaluate(() =>
    /mac|iphone|ipad|ipod/i.test(navigator.platform) ? "Meta+A" : "Control+A",
  );
  await input.press(selectAllShortcut);
  await input.press("Backspace");

  await expect(input).toHaveText("");
  await expect(autoPinConfirmation).toHaveCount(0);
});

test("automatic mentions are scoped to their channel or thread composer", async ({
  page,
}) => {
  await installAudienceFixtures(page);
  await openGeneral(page);
  await automaticallyMention(channelComposer(page), "Morgarita");
  await expect(
    channelComposer(page).getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toBeVisible();

  await openThread(page);
  await expect(
    threadComposer(page).getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toHaveCount(0);

  await automaticallyMention(threadComposer(page), "Vogue");
  await openGeneral(page);
  await expect(
    channelComposer(page).getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toBeVisible();
  await expect(
    channelComposer(page).getByTestId(`composer-address-lock-${AGENT_B}`),
  ).toHaveCount(0);

  await openThread(page);
  await expect(
    threadComposer(page).getByTestId(`composer-address-lock-${AGENT_B}`),
  ).toBeVisible();

  await openThread(page, "mock-general-alice");
  await expect(
    threadComposer(page).getByTestId(`composer-address-lock-${AGENT_B}`),
  ).toHaveCount(0);
});

test("a thread does not restore a removed root agent; explicit re-add follows automation", async ({
  page,
}) => {
  await keepMentionedAgentsPinned(page);
  await installAudienceFixtures(page, { agentAName: "claude code" });
  await openGeneral(page);

  const rootComposer = channelComposer(page);
  const rootInput = rootComposer.getByTestId("message-input");
  await automaticallyMention(rootComposer, "claude code");
  await expect(
    rootComposer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toBeVisible();
  await rootComposer
    .getByTestId(`composer-address-lock-remove-${AGENT_A}`)
    .click();
  await expect(rootInput).toHaveText("");
  await expect(
    rootComposer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toHaveCount(0);

  await openThread(page);
  const activeThreadComposer = threadComposer(page);
  const threadInput = activeThreadComposer.getByTestId("message-input");
  await threadInput.fill("@cla");
  await expect(
    activeThreadComposer.getByTestId("mention-autocomplete"),
  ).toBeVisible();
  await threadInput.press("Tab");
  await expect(
    activeThreadComposer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toBeVisible();
  await threadInput.type("thread message");
  await threadInput.press("Enter");

  await openGeneral(page);
  await expect(
    channelComposer(page).getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toHaveCount(0);

  const restoredRootInput = channelComposer(page).getByTestId("message-input");
  await restoredRootInput.fill("@cla");
  await expect(
    channelComposer(page).getByTestId("mention-autocomplete"),
  ).toBeVisible();
  await restoredRootInput.press("Tab");
  await expect(
    channelComposer(page).getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toBeVisible();
  await restoredRootInput.type("explicit re-add");
  await restoredRootInput.press("Enter");

  await expect
    .poll(() =>
      readOutgoingMentionPubkeys(page, "@claude code explicit re-add"),
    )
    .toEqual([AGENT_A]);
  await expect(restoredRootInput).toHaveText("@claude code ");
  await expect(
    channelComposer(page).getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toBeVisible();
});

for (const mode of ["toolbar", "typed"] as const) {
  test(`explicit ${mode} re-add after X follows the enabled automatic setting`, async ({
    page,
  }) => {
    await keepMentionedAgentsPinned(page);
    await installAudienceFixtures(page);
    await openGeneral(page);
    const composer = channelComposer(page);
    const input = composer.getByTestId("message-input");
    await automaticallyMention(composer, "Morgarita");
    await composer
      .getByTestId(`composer-address-lock-remove-${AGENT_A}`)
      .click();
    await expect(input).toHaveText("");
    await addMention(composer, "Morgarita", mode);
    await input.pressSequentially("re-added");
    await input.press("Enter");
    await expect
      .poll(() => readOutgoingMentionPubkeys(page, "@Morgarita re-added"))
      .toEqual([AGENT_A]);
    await expect(input).toHaveText("@Morgarita ");
    await expect(
      composer.getByTestId(`composer-address-lock-${AGENT_A}`),
    ).toBeVisible();
  });
}

test("re-adding a deleted automatic mention restores its automatic mention state immediately", async ({
  page,
}) => {
  await keepMentionedAgentsPinned(page);
  await installAudienceFixtures(page);
  await openGeneral(page);

  const composer = channelComposer(page);
  const input = composer.getByTestId("message-input");
  await automaticallyMention(composer, "Morgarita");

  const selectAllShortcut = await page.evaluate(() =>
    /mac|iphone|ipad|ipod/i.test(navigator.platform) ? "Meta+A" : "Control+A",
  );
  await input.press(selectAllShortcut);
  await input.press("Backspace");

  await expect(input).toHaveText("");
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toHaveCount(0);

  await input.fill("@Mor");
  await expect(composer.getByTestId("mention-autocomplete")).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveText("@Morgarita ");
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toBeVisible();

  await input.type("re-added");
  await input.press("Enter");

  await expect(input).toHaveText("@Morgarita ");
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toBeVisible();
});

test("implicit automatic mentions stay out of persisted drafts", async ({
  page,
}) => {
  await installAudienceFixtures(page);
  await openGeneral(page);
  await automaticallyMention(channelComposer(page), "Morgarita");
  const input = channelComposer(page).getByTestId("message-input");
  await input.type("draft text");

  await openThread(page);
  await openGeneral(page);

  await expect(input).toHaveText("@Morgarita draft text");
  await expect(input.locator(".agent-mention-highlight")).toHaveCount(1);
  await input.pressSequentially(" continues");
  await expect(input).toHaveText("@Morgarita draft text continues");
  await expect(input.locator(".agent-mention-highlight")).toHaveCount(1);

  await page.goto(`/#/channels/${RANDOM_CHANNEL_ID}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("chat-title")).toHaveText("random");

  await expect
    .poll(() => readPersistedDraft(page))
    .toBe("draft text continues");
});

test("an authored duplicate leading mention survives draft restoration", async ({
  page,
}) => {
  await installAudienceFixtures(page);
  await openGeneral(page);
  await automaticallyMention(channelComposer(page), "Morgarita");
  const input = channelComposer(page).getByTestId("message-input");
  await input.pressSequentially("@Morgarita authored duplicate");

  await openThread(page);
  await openGeneral(page);

  await expect(input).toHaveText("@Morgarita @Morgarita authored duplicate");
  // Exact typed mentions now resolve on Space, so both the automatic prefix and
  // the authored duplicate retain mention identity after restoration.
  await expect(input.locator(".agent-mention-highlight")).toHaveCount(2);

  await page.goto(`/#/channels/${RANDOM_CHANNEL_ID}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("chat-title")).toHaveText("random");
  await expect
    .poll(() => readPersistedDraft(page))
    .toBe("@Morgarita authored duplicate");
});

test("typed deletion preserves an identical authored mention in drafts", async ({
  page,
}) => {
  await installAudienceFixtures(page);
  await openGeneral(page);
  const composer = channelComposer(page);
  const input = composer.getByTestId("message-input");
  await automaticallyMention(composer, "Morgarita");

  const selectAllShortcut = await page.evaluate(() =>
    /mac|iphone|ipad|ipod/i.test(navigator.platform) ? "Meta+A" : "Control+A",
  );
  await input.press(selectAllShortcut);
  await input.press("Backspace");
  await expect(input).toHaveText("");
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toHaveCount(0);

  await input.pressSequentially("@Morgarita manual after typed deletion");
  await page.goto(`/#/channels/${RANDOM_CHANNEL_ID}`, {
    waitUntil: "domcontentloaded",
  });
  await expect
    .poll(() => readPersistedDraft(page))
    .toBe("@Morgarita manual after typed deletion");
});

test("removing an automatic mention preserves an identical authored mention in drafts", async ({
  page,
}) => {
  await installAudienceFixtures(page);
  await openGeneral(page);
  const composer = channelComposer(page);
  const input = composer.getByTestId("message-input");

  await automaticallyMention(composer, "Morgarita");
  await composer.getByTestId(`composer-address-lock-remove-${AGENT_A}`).click();
  await input.pressSequentially("@Morgarita manual after removal");
  await page.goto(`/#/channels/${RANDOM_CHANNEL_ID}`, {
    waitUntil: "domcontentloaded",
  });

  await expect
    .poll(() => readPersistedDraft(page))
    .toBe("@Morgarita manual after removal");
});

test("multiple automatic mentions stay out of persisted drafts", async ({
  page,
}) => {
  await installAudienceFixtures(page);
  await openGeneral(page);
  const composer = channelComposer(page);
  const input = composer.getByTestId("message-input");
  await automaticallyMention(composer, "Morgarita");
  await automaticallyMention(composer, "Vogue");
  await input.pressSequentially("draft text");

  await openThread(page);
  await openGeneral(page);
  await expect(input).toHaveText("@Vogue @Morgarita draft text");
  await expect(input.locator(".agent-mention-highlight")).toHaveCount(2);
  await page.goto(`/#/channels/${RANDOM_CHANNEL_ID}`, {
    waitUntil: "domcontentloaded",
  });
  await expect.poll(() => readPersistedDraft(page)).toBe("draft text");
});

test("re-enabling an automatic mention preserves an authored duplicate after draft restoration", async ({
  page,
}) => {
  await installAudienceFixtures(page);
  await openGeneral(page);
  const composer = channelComposer(page);
  const input = composer.getByTestId("message-input");

  await automaticallyMention(composer, "Morgarita");
  await composer.getByTestId(`composer-address-lock-remove-${AGENT_A}`).click();
  await expect(input).toHaveText("");

  await automaticallyMention(composer, "Morgarita");
  await input.pressSequentially("@Morgarita authored duplicate");
  await openThread(page);
  await openGeneral(page);

  await expect(input).toHaveText("@Morgarita @Morgarita authored duplicate");
  await expect(input.locator(".agent-mention-highlight")).toHaveCount(2);

  await page.goto(`/#/channels/${RANDOM_CHANNEL_ID}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("chat-title")).toHaveText("random");
  await expect
    .poll(() => readPersistedDraft(page))
    .toBe("@Morgarita authored duplicate");
});

test("a restored multi-word automatic mention remains a chip with the caret after its space", async ({
  page,
}) => {
  await installAudienceFixtures(page, { agentAName: "claude code" });
  await openGeneral(page);
  const originalComposer = channelComposer(page);
  await automaticallyMention(originalComposer, "claude code");
  const originalInput = originalComposer.getByTestId("message-input");
  await expectComposerCaretAtEnd(originalInput);
  expect(await originalInput.textContent()).toBe("@claude code ");
  await originalInput.pressSequentially("hello");
  expect(await originalInput.textContent()).toBe("@claude code hello");
  await originalInput.press("Enter");
  await expect
    .poll(() => readOutgoingMentionPubkeys(page, "@claude code hello"))
    .toContain(AGENT_A);
  await expect(originalInput).toHaveText("@claude code ");

  await page.goto(`/#/channels/${RANDOM_CHANNEL_ID}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("chat-title")).toHaveText("random");
  await openGeneral(page);

  const composer = channelComposer(page);
  const input = composer.getByTestId("message-input");
  const expectedContent = "@claude code ";
  await expect(input).toHaveText(expectedContent);
  await expect(input.locator(".agent-mention-highlight")).toHaveCount(1);
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toBeVisible();
  await expect(
    composer.getByRole("button", { name: "Mention someone" }),
  ).toBeVisible();
  await page.waitForTimeout(500);
  await expect(input.locator(".agent-mention-highlight")).toHaveCount(1);
  await expect(input).toBeFocused();
  await expect
    .poll(() => readComposerCaret(input))
    .toBe(expectedContent.length);

  await input.pressSequentially("follow-up");
  await expect(input).toHaveText("@claude code follow-up");
  await expect(input.locator(".agent-mention-highlight")).toHaveCount(1);
  await expect(
    composer.getByTestId(`composer-address-lock-${AGENT_A}`),
  ).toBeVisible();
});

test("reduced motion removes addressed agents without spatial animation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await keepMentionedAgentsPinned(page);
  await installAudienceFixtures(page);
  await openGeneral(page);

  const composer = channelComposer(page);
  const input = composer.getByTestId("message-input");
  await input.fill("@Mor");
  await expect(composer.getByTestId("mention-autocomplete")).toBeVisible();
  await input.press("Tab");
  const removeButton = composer.getByTestId(
    `composer-address-lock-remove-${AGENT_A}`,
  );
  await expect(removeButton).toBeVisible();
  await expect(removeButton).toHaveAttribute("style", /opacity: 1/);
  await expect(removeButton).toHaveCSS("transform", "none");

  await removeButton.click();
  await expect(input).toHaveText("");
  await expect(removeButton).toHaveCount(0);
});

for (const theme of ["buzz", "buzz-dark"]) {
  test(`captures the mention-button placement in ${theme}`, async ({
    page,
  }) => {
    await seedTheme(page, theme);
    await installAudienceFixtures(page);
    await openThread(page);
    const overlay = threadComposer(page);
    const composer = overlay.getByTestId("message-composer");
    await automaticallyMention(overlay, "Morgarita");
    await automaticallyMention(overlay, "Vogue");
    await overlay.getByTestId("message-input").focus();
    await waitForAnimations(page);
    await composer.screenshot({ path: `${SHOTS}/${theme}-mention-button.png` });
  });
}

test("the mention-button placement fits the narrow composer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 700, height: 760 });
  await installAudienceFixtures(page);
  await openThread(page);
  const overlay = threadComposer(page);
  const composer = overlay.getByTestId("message-composer");
  await automaticallyMention(overlay, "Morgarita");
  await automaticallyMention(overlay, "Vogue");
  await expect(overlay.getByTestId("composer-address-locks")).toBeVisible();
  await expect(
    overlay.getByRole("button", { name: "Mention someone" }),
  ).toBeVisible();
  await waitForAnimations(page);
  await composer.screenshot({ path: `${SHOTS}/narrow-mention-button.png` });
});

test("captures the lightweight auto-pin popover", async ({ page }) => {
  await seedTheme(page, "buzz-dark");
  await installAudienceFixtures(page);
  await openGeneral(page);

  const composer = channelComposer(page);
  const input = composer.getByTestId("message-input");
  await input.fill("draft text");
  await pressPrimaryShiftM(page);
  await expect(input).toHaveText("@alice draft text");

  const addressControl = composer
    .getByTestId("composer-address-locks")
    .locator("..");
  const confirmation = page.getByTestId("composer-auto-pin-confirmation");
  await expect(confirmation).toContainText(
    "alice will be mentioned automatically",
  );
  await waitForAnimations(page);

  const addressBox = await addressControl.boundingBox();
  const confirmationBox = await confirmation.boundingBox();
  expect(addressBox).not.toBeNull();
  expect(confirmationBox).not.toBeNull();
  if (!addressBox || !confirmationBox) {
    throw new Error("Popover is not laid out");
  }

  const left = addressBox.x - 14;
  const top = Math.min(addressBox.y, confirmationBox.y) - 14;
  const right = confirmationBox.x + confirmationBox.width + 14;
  const bottom =
    Math.max(
      addressBox.y + addressBox.height,
      confirmationBox.y + confirmationBox.height,
    ) + 14;
  await page.screenshot({
    path: `${SHOTS}/auto-pin-popover-dark.png`,
    clip: { x: left, y: top, width: right - left, height: bottom - top },
  });
});
