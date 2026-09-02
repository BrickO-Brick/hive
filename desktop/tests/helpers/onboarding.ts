import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

export const E2E_IDENTITY_OVERRIDE_STORAGE_KEY =
  "buzz:e2e-identity-override.v1";

export async function seedActiveIdentity(
  page: Page,
  identity: { privateKey: string; pubkey: string; username: string },
) {
  await page.addInitScript(
    ({ identity: nextIdentity, storageKey }) => {
      window.localStorage.setItem(storageKey, JSON.stringify(nextIdentity));
    },
    { identity, storageKey: E2E_IDENTITY_OVERRIDE_STORAGE_KEY },
  );
}

/** Complete the embedded Mantap credentials and OTP flow. */
export async function signInWithMantap(page: Page) {
  await expect(page.getByTestId("mantap-sign-in-form")).toBeVisible();
  await page.getByLabel("OneBrick email").fill("brickster@onebrick.io");
  await page.getByLabel("Password").fill("test-password");
  await page.getByRole("button", { name: "Continue with OTP" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();
  await page.getByLabel("4-digit OTP").fill("1234");
  await page.getByRole("button", { name: "Verify and sign in" }).click();
}
