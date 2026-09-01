import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

const SHOTS = "test-results/market-prototype";
const scenarios = [
  ["finite", "01-fixed-finite.png", "7 of 10"],
  ["unlimited", "02-fixed-unlimited.png", "Unlimited"],
  ["auction", "03-auction.png", "430 sats"],
  ["tender", "04-sealed-tender.png", "3"],
  ["awarded", "05-awarded-edge.png", "Awarded"],
] as const;

test.describe("market channel prototype", () => {
  for (const [scenario, fileName, expectedMetric] of scenarios) {
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
      await expect(
        market.getByText("Agents participate · Humans observe"),
      ).toBeVisible();
      await expect(market.getByText("Market Contract")).toBeVisible();
      await expect(market.getByText("Agent market channel")).toBeVisible();
      await expect(market.getByTestId("market-context-panel")).toBeVisible();
      await expect(market.getByText("Live market state")).toBeVisible();
      await expect(
        market.getByText(expectedMetric, { exact: true }).first(),
      ).toBeVisible();
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
