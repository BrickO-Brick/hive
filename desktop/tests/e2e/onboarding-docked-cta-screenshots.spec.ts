import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";

const BLANK_TYLER_IDENTITY = {
  ...TEST_IDENTITIES.tyler,
  username: "",
};

const SHOT_DIR = "test-results/onboarding-docked-cta";
test.use({ viewport: { width: 1280, height: 800 } });

test("machine onboarding: embedded Mantap login and setup", async ({
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
  await expect(page.getByTestId("mantap-sign-in-form")).toBeVisible();
  await expect(
    page.getByText(
      "ENGLISH INTERFACE ONLY · Your conversations can use any language.",
    ),
  ).toBeVisible();
  await expect(page.getByText(/private key/i)).toHaveCount(0);
  await expect(page.getByText(/recover/i)).toHaveCount(0);
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/01-landing.png` });

  await page.getByLabel("OneBrick email").fill("brickster@onebrick.io");
  await page.getByLabel("Password").fill("test-password");
  await page.getByRole("button", { name: "Continue with OTP" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/01b-mantap-otp.png` });
  await page.getByLabel("4-digit OTP").fill("1234");
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Set up your agent harnesses" }),
  ).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/02-setup.png` });
});

test("embedded Mantap form remains usable in a short viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 620 });
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");

  const heading = page.getByRole("heading", { name: "Sign in to Hive" });
  const input = page.getByLabel("OneBrick email");
  const form = page.getByTestId("mantap-sign-in-form");
  await expect(heading).toBeVisible();
  await expect(input).toBeVisible();
  await expect(form).toBeVisible();

  const layout = await page.evaluate(() => {
    const form = document
      .querySelector('[data-testid="mantap-sign-in-form"]')
      ?.getBoundingClientRect();
    return {
      formBottom: form?.bottom ?? 0,
      formLeft: form?.left ?? 0,
      formRight: form?.right ?? 0,
      formTop: form?.top ?? 0,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  expect(layout.formTop).toBeGreaterThanOrEqual(0);
  expect(layout.formBottom).toBeGreaterThan(layout.formTop);
  expect(layout.formLeft).toBeGreaterThanOrEqual(0);
  expect(layout.formRight).toBeLessThanOrEqual(layout.clientWidth);
  expect(layout.scrollHeight).toBeGreaterThanOrEqual(620);
  expect(layout.scrollWidth).toBe(layout.clientWidth);
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
