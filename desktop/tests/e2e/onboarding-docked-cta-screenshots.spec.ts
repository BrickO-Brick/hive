import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";

const BLANK_TYLER_IDENTITY = {
  ...TEST_IDENTITIES.tyler,
  username: "",
};

const SHOT_DIR = "test-results/onboarding-docked-cta";
const NCRYPTSEC =
  "ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p";

test.use({ viewport: { width: 1280, height: 800 } });

test("machine onboarding: landing, backup, setup docked CTAs", async ({
  page,
}) => {
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");

  const gate = page.getByTestId("machine-onboarding-gate");
  await expect(gate).toBeVisible();
  await expect(page.getByTestId("onboarding-team-hero")).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/01-landing.png` });

  await expect(
    page.getByRole("button", { name: /Recover an existing Hive identity/i }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Sign in with Mantap" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Mantap" })).toBeVisible();
  await page.getByLabel("OneBrick email").fill("brickster@onebrick.io");
  await page.getByLabel("Password").fill("test-password");
  await page.getByRole("button", { name: "Continue with OTP" }).click();
  await expect(page.getByRole("heading", { name: "Enter your OTP" })).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/01b-mantap-otp.png` });
  await page.getByLabel("4-digit OTP").fill("1234");
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Your unique identity key has been created",
    }),
  ).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/02-backup.png` });

  // The key stays masked behind an explicit reveal toggle.
  await expect(page.getByTestId("backup-key-value")).toBeVisible();

  // Reveal the key: box must not reflow (same-length monospace mask).
  await page.getByTestId("backup-key-reveal-toggle").click();
  await expect(page.getByTestId("backup-key-value")).toHaveClass(/select-text/);
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/02b-backup-revealed.png` });

  // Backup options leave the yellow flow for the dark security view without
  // adding a progress step or a generic Next action.
  await page.getByTestId("backup-options-link").click();
  await expect(
    page.getByTestId("onboarding-page-backup-options"),
  ).toBeVisible();
  await expect(page.getByTestId("onboarding-next")).toHaveCount(0);
  const optionPanels = page.getByTestId("backup-option-panel");
  await expect(optionPanels).toHaveCount(3);
  await expect(
    page.getByTestId("backup-options").locator(".buzz-card-textured"),
  ).toHaveCount(0);
  await expect(optionPanels.first()).toHaveCSS("padding-left", "24px");
  const titleTops = await optionPanels
    .locator("span.text-lg")
    .evaluateAll((titles) =>
      titles.map((title) => title.getBoundingClientRect().top),
    );
  expect(Math.max(...titleTops) - Math.min(...titleTops)).toBeLessThan(1);
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/02c-backup-options.png` });

  await page.getByTestId("backup-option-password").click();
  await expect(page.getByTestId("onboarding-page-download")).toBeVisible();
  const passwordPanel = page.getByTestId("backup-password-panel");
  await expect(passwordPanel).toBeVisible();
  await expect(passwordPanel).not.toHaveClass(/buzz-card-textured/);
  await expect(passwordPanel).toHaveCSS("padding-left", "24px");
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/02d-backup-password.png` });

  await page.getByTestId("backup-passphrase-generate").click();
  const generatorPopover = page.getByRole("dialog");
  await expect(generatorPopover).toBeVisible();
  await expect(generatorPopover).not.toHaveClass(/buzz-card-textured/);
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/02e-backup-generator.png` });
  await page.keyboard.press("Escape");

  await page.getByTestId("backup-return-to-onboarding").click();
  await expect(page.getByTestId("onboarding-page-backup")).toBeVisible();
  await page.getByTestId("onboarding-next").click();
  await expect(
    page.getByRole("heading", { name: "Set up your agent harnesses" }),
  ).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/03-setup.png` });
});

test("machine key import remains usable in a short viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 620 });
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Recover an existing Hive identity" })
    .click();

  const heading = page.getByRole("heading", { name: "Enter your private key" });
  const input = page.getByLabel("Private key", { exact: true });
  const footer = page.getByTestId("onboarding-footer-slot");
  await expect(heading).toBeVisible();
  await expect(input).toBeVisible();
  await expect(footer).toBeVisible();

  const layout = await page.evaluate(() => {
    const heading = document.querySelector("h1")?.getBoundingClientRect();
    const input = document
      .querySelector<HTMLInputElement>("#nostr-private-key")
      ?.getBoundingClientRect();
    const footer = document
      .querySelector('[data-testid="onboarding-footer-slot"]')
      ?.getBoundingClientRect();
    return {
      footerTop: footer?.top ?? 0,
      headingBottom: heading?.bottom ?? 0,
      inputBottom: input?.bottom ?? 0,
      inputTop: input?.top ?? 0,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  expect(layout.inputTop).toBeGreaterThan(layout.headingBottom);
  expect(layout.footerTop).toBeGreaterThan(layout.inputBottom);
  expect(layout.scrollHeight).toBeGreaterThanOrEqual(620);
  expect(layout.scrollWidth).toBe(layout.clientWidth);
});

test("backup options keep one-column geometry on narrow windows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 700 });
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in with Mantap" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Your unique identity key has been created",
    }),
  ).toBeVisible();
  await page.getByTestId("backup-options-link").click();

  const panels = page.getByTestId("backup-option-panel");
  await expect(panels).toHaveCount(3);
  await waitForAnimations(page);
  const geometry = await panels.evaluateAll((elements) => ({
    clientWidth: document.documentElement.clientWidth,
    lefts: elements.map((element) => element.getBoundingClientRect().left),
    rights: elements.map((element) => element.getBoundingClientRect().right),
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(new Set(geometry.lefts.map(Math.round)).size).toBe(1);
  expect(geometry.lefts.every((left) => left >= 0)).toBe(true);
  expect(geometry.rights.every((right) => right <= geometry.clientWidth)).toBe(
    true,
  );
  expect(geometry.scrollWidth).toBe(geometry.clientWidth);
});

test("relay onboarding: profile and avatar docked CTAs", async ({ page }) => {
  await seedActiveIdentity(page, BLANK_TYLER_IDENTITY);
  await installMockBridge(page, undefined, { skipOnboardingSeed: true });
  await page.goto("/");

  await expect(page.getByTestId("onboarding-page-1")).toBeVisible();
  await page.getByTestId("onboarding-display-name").fill("Ada Lovelace");
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/04-profile.png` });

  await page.getByTestId("onboarding-next").click();
  await expect(page.getByTestId("onboarding-page-avatar")).toBeVisible();
  await page
    .getByTestId("onboarding-avatar-url")
    .fill("https://example.com/onboarding-avatar.png");
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/05-avatar.png` });
});
