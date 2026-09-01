import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

const SHOTS = "test-results/market-prototype";
const scenarios = [
  ["finite", "01-fixed-finite.png"],
  ["unlimited", "02-fixed-unlimited.png"],
  ["auction", "03-auction.png"],
  ["tender", "04-sealed-tender.png"],
  ["awarded", "05-awarded-edge.png"],
] as const;

test.describe("market channel prototype", () => {
  for (const [scenario, fileName] of scenarios) {
    test(`${scenario} market state`, async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 1100 });
      await installMockBridge(page);
      await page.goto(`/#/market?scenario=${scenario}`, {
        waitUntil: "domcontentloaded",
      });

      const market = page.getByTestId("market-screen");
      await expect(market).toBeVisible();
      const detachedSurface = await market.evaluate((element) => {
        const contentSurface = element.closest("[data-buzz-content-surface]");
        if (!(contentSurface instanceof HTMLElement)) return null;
        const style = window.getComputedStyle(contentSurface);
        return {
          backgroundColor: style.backgroundColor,
          borderTopLeftRadius: style.borderTopLeftRadius,
        };
      });
      expect(detachedSurface).toEqual({
        backgroundColor: "rgba(0, 0, 0, 0)",
        borderTopLeftRadius: "0px",
      });
      await expect(page.getByTestId("chat-title")).toHaveText(
        scenario === "finite"
          ? "Incident pattern report"
          : scenario === "unlimited"
            ? "Repository dependency map"
            : scenario === "auction"
              ? "Translate support strings"
              : "Design a relay abuse-response playbook",
      );
      await expect(market.getByTestId("market-offer-card")).toBeVisible();
      await expect(market.getByText("Agent market channel")).toBeVisible();
      await expect(market.getByTestId("market-agent-avatar")).toHaveCount(
        scenario === "unlimited" ? 3 : 4,
      );
      await expect(page.getByTestId("open-market-view")).toHaveAttribute(
        "data-active",
        "true",
      );
      await expect(
        market.getByRole("button", {
          name: "Observe only",
        }),
      ).toBeDisabled();

      await waitForAnimations(page);
      await page.screenshot({ fullPage: true, path: `${SHOTS}/${fileName}` });
    });
  }
});

test("create market modal", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await installMockBridge(page);
  await page.goto("/#/market?scenario=finite", {
    waitUntil: "domcontentloaded",
  });

  await page.getByRole("button", { name: "Create one like this" }).click();
  const dialog = page.getByTestId("create-market-dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("Agent representing you", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Forensic Finch", { exact: true }),
  ).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({
    fullPage: true,
    path: `${SHOTS}/06-create-market-modal.png`,
  });
});
