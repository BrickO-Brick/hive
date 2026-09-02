import { hexToBytes } from "@noble/hashes/utils.js";
import { expect, test } from "@playwright/test";
import { nsecEncode } from "nostr-tools/nip19";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

async function signInWithMantap(page: import("@playwright/test").Page) {
  await page.getByLabel("OneBrick email").fill("brickster@onebrick.io");
  await page.getByLabel("Password").fill("test-password");
  await page.getByRole("button", { name: "Continue with OTP" }).click();
  await page.getByLabel("4-digit OTP").fill("1234");
  await page.getByRole("button", { name: "Verify and sign in" }).click();
}

test("normal first launch authenticates the persisted identity with Mantap", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");

  const gate = page.getByTestId("machine-onboarding-gate");
  await expect(gate).toBeVisible();
  await expect(gate).toHaveCSS("background-color", "rgb(255, 111, 82)");
  await expect(gate).toHaveCSS("background-image", /radial-gradient/);
  await expect(page.getByTestId("mantap-sign-in-form")).toBeVisible();
  await expect(page.getByText(/private key/i)).toHaveCount(0);
  await expect(page.getByText(/recover/i)).toHaveCount(0);

  await signInWithMantap(page);

  await expect(
    page.getByRole("heading", { name: "Set up your agent harnesses" }),
  ).toBeVisible();
  const commands = await page.evaluate(
    () =>
      (
        window as Window & {
          __BUZZ_E2E_COMMAND_PAYLOADS__?: Array<{ command: string }>;
        }
      ).__BUZZ_E2E_COMMAND_PAYLOADS__ ?? [],
  );
  expect(commands.some((entry) => entry.command === "request_mantap_otp")).toBe(
    true,
  );
  expect(commands.some((entry) => entry.command === "start_mantap_login")).toBe(
    true,
  );
  expect(
    commands.some((entry) => entry.command === "persist_current_identity"),
  ).toBe(false);
});

test("lost identity is replaced only after successful Mantap authentication", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await expect(page.getByTestId("mantap-sign-in-form")).toBeVisible();
  await expect(page.getByText(/private key/i)).toHaveCount(0);
  await expect(page.getByText(/recover/i)).toHaveCount(0);
  await signInWithMantap(page);

  await expect(
    page.getByRole("heading", { name: "Set up your agent harnesses" }),
  ).toBeVisible();
  const commands = await page.evaluate(
    () =>
      (
        window as Window & {
          __BUZZ_E2E_COMMAND_PAYLOADS__?: Array<{ command: string }>;
        }
      ).__BUZZ_E2E_COMMAND_PAYLOADS__ ?? [],
  );
  expect(
    commands.some((entry) => entry.command === "persist_current_identity"),
  ).toBe(true);
});

test("locked boot shows the keyring-locked screen without onboarding", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLocked: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await expect(page.getByTestId("keyring-locked")).toBeVisible();
  await expect(page.getByTestId("machine-onboarding-gate")).toHaveCount(0);
});

test("locked boot can re-import a key and requires relaunch", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLocked: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await expect(page.getByTestId("keyring-locked")).toBeVisible();
  page.on("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Re-import your key instead" })
    .click();

  const importedNsec = nsecEncode(hexToBytes(TEST_IDENTITIES.alice.privateKey));
  await page.getByTestId("nostr-import-nsec-input").fill(importedNsec);
  await expect(page.getByTestId("nostr-import-npub-preview")).toBeVisible();
  await page.getByTestId("nostr-import-submit").click();

  await expect(page.getByTestId("relaunch-required")).toBeVisible();
  await expect(page.getByTestId("keyring-locked")).toHaveCount(0);
});

test("locked screen relaunch button records the process-restart invoke", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLocked: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await expect(page.getByTestId("keyring-locked")).toBeVisible();
  await page.getByTestId("relaunch-app").click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __BUZZ_E2E_COMMAND_PAYLOADS__?: Array<{ command: string }>;
            }
          ).__BUZZ_E2E_COMMAND_PAYLOADS__?.some(
            (entry) => entry.command === "plugin:process|restart",
          ) ?? false,
      ),
    )
    .toBe(true);
});
