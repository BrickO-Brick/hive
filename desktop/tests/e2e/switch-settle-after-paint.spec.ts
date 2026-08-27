import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

/**
 * The switch trace must settle AFTER the deferred timeline has committed and
 * painted. During the skeleton→loaded transition the message-list branches
 * (which used to own the `data-render-pending` marker) are not mounted, so a
 * tracer polling only that marker would read "not pending" and record a
 * settle while the heavy deferred list was still uncommitted — underreporting
 * exactly the switches the tracer exists to measure. The marker now lives on
 * the timeline's always-mounted wrapper; this spec pins the contract on a
 * real empty→loaded cold switch into a deep channel.
 */

const SWITCH_MEASURE = "buzz:channel-switch:click-to-settled";

test("cold-switch settle measure lands only after rows are painted", async ({
  page,
}) => {
  await installMockBridge(page, { deepHistoryMessageCount: 600 });
  await page.goto("/");
  await expect(page.getByTestId("app-sidebar")).toBeVisible();

  // Cold first entry: skeleton → deferred list commit → settled paint.
  await page.getByTestId("channel-deep-history").click();

  // Poll for the settle measure inside the page and — in the same synchronous
  // evaluation turn — snapshot what the DOM shows at that moment. Reading the
  // DOM from the test process after the fact would race further renders. Only
  // CLEAN measures count: a truncated one means the tracer honestly hit its
  // render-wait deadline (harness timing), which must fail with that reason
  // rather than masquerading as a tracer regression.
  const atSettle = await page.evaluate(async (measureName) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const entries = performance.getEntriesByName(measureName);
      const clean = entries.filter(
        (entry) => !(entry as PerformanceMeasure).detail?.settleWaitTruncated,
      );
      if (clean.length > 0) {
        return {
          renderPending:
            document.querySelector('[data-render-pending="true"]') !== null,
          rowCount: document.querySelectorAll(
            '[data-message-id^="mock-deep-history-"]',
          ).length,
          settled: true,
          truncatedOnly: false,
        };
      }
      if (entries.length > 0) {
        return {
          renderPending: true,
          rowCount: 0,
          settled: false,
          truncatedOnly: true,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    return {
      renderPending: true,
      rowCount: 0,
      settled: false,
      truncatedOnly: false,
    };
  }, SWITCH_MEASURE);

  expect(
    atSettle.truncatedOnly,
    "tracer truncated at its render-wait deadline — harness timing exhausted, not a tracer bug; rerun",
  ).toBe(false);
  expect(atSettle.settled, "switch trace must settle").toBe(true);
  expect(
    atSettle.rowCount,
    "settle must not be recorded before the deferred list painted",
  ).toBeGreaterThan(0);
  expect(
    atSettle.renderPending,
    "settle must not be recorded while a deferred commit is still pending",
  ).toBe(false);
});

/**
 * While the lazy ChannelPane chunk is still suspended, the timeline (and its
 * render-pending marker) is not mounted — only the Suspense fallback is. The
 * fallback must therefore read as pending itself, or the tracer would record
 * a settle with zero rows while the loading skeleton was still visible. This
 * spec holds the chunk to pin that contract.
 */
test("settle waits for a delayed lazy channel-pane chunk", async ({ page }) => {
  let releaseChunk = () => {};
  const chunkHold = new Promise<void>((resolve) => {
    releaseChunk = resolve;
  });
  let chunkRequested = false;
  await page.route(/\/assets\/ChannelPane-[^/]+\.js(\?.*)?$/, async (route) => {
    chunkRequested = true;
    await chunkHold;
    await route.continue();
  });

  await installMockBridge(page, { deepHistoryMessageCount: 600 });
  await page.goto("/");
  await expect(page.getByTestId("app-sidebar")).toBeVisible();

  await page.getByTestId("channel-deep-history").click();
  await expect
    .poll(() => chunkRequested, {
      message: "the ChannelPane chunk must load lazily on first channel entry",
    })
    .toBe(true);

  // While the pane chunk is held there are no rows on screen, so any measure
  // emitted here must carry the truncation flag. A CLEAN measure would be the
  // regression: a settled paint reported for a screen showing a fallback.
  await page.waitForTimeout(1_000);
  const cleanWhileSuspended = await page.evaluate(
    (name) =>
      performance
        .getEntriesByName(name)
        .filter(
          (entry) => !(entry as PerformanceMeasure).detail?.settleWaitTruncated,
        ).length,
    SWITCH_MEASURE,
  );
  expect(
    cleanWhileSuspended,
    "no clean settle may be recorded while the pane chunk is suspended",
  ).toBe(0);

  releaseChunk();

  // After release the pane mounts and paints rows. The tracer's own record
  // may already have landed (truncated, by design) — what matters is that the
  // channel actually painted, which is what a clean settle would have claimed.
  await expect
    .poll(
      () =>
        page
          .locator('[data-message-id^="mock-deep-history-"]')
          .count()
          .then((count) => count > 0),
      { message: "the released pane must paint rows", timeout: 15_000 },
    )
    .toBe(true);
});
