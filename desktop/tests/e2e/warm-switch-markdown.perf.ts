import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

/**
 * Warm-channel-switch benchmark.
 *
 * Measures the felt cost of switching INTO a channel whose messages are
 * already in the React Query cache (the everyday alt-tab-between-channels
 * motion). The timeline subtree is keyed by channel id — required so TanStack
 * Router's scroll restoration never writes a stale scrollTop into a reused
 * scroll node. Warm entry therefore mounts a bounded route-correct slice first,
 * then releases the complete cached snapshot in one transition. This spec gates
 * that cost and proves the release cannot strand a partial timeline.
 *
 * TWO SCENARIOS, one per axis of the cost:
 *   plain-text  — `deep-history` (600 seeded one-line rows; the cached
 *                 channel window retains 50): isolates the remount floor.
 *   markdown    — `random` + 60 injected markdown-heavy rows (code fences,
 *                 tables, lists, mentions, links): exercises expensive visible
 *                 DOM creation and style recalculation.
 *
 * WHAT A "SWITCH" MEASURES: performance.now() immediately before an in-page
 * .click() on the sidebar link, until (chat title flipped) AND the target
 * channel's expected visible viewport row is painted at the restored bottom
 * offset with the complete cached snapshot admitted. The click and the
 * round-trip latency never pollutes the numbers. Longtask totals are captured
 * per switch as the "UI froze" axis (see cold-switch-longtask.perf.ts for the
 * rationale).
 *
 * WARM means every measured entry is a RE-entry: each scenario does one
 * untimed round-trip first so both channels' queries are cached and code
 * paths are jitted. 4x CPU throttle for the same reason as the cold spec —
 * absolute ms are not portable across machines, but before/after deltas on
 * the same machine are.
 *
 * Run it (from desktop/):
 *   pnpm build:e2e
 *   pnpm exec playwright test --config=playwright.perf.config.ts warm-switch-markdown.perf.ts
 *
 * NOTE: the perf web server reuses an existing server on :4173 — if one is
 * already running, kill it or make sure `dist/` is freshly built, otherwise
 * you measure stale code.
 */

const MEASURED_SWITCHES = 8;
const THROTTLE_RATE = 4;
const MARKDOWN_MESSAGE_COUNT = 60;
const PLAIN_MAX_LONGTASK_MS = 300;
const MARKDOWN_MAX_LONGTASK_MS = 300;
const PLAIN_MAX_CORRECT_PAINT_MS = 550;
const MARKDOWN_MAX_CORRECT_PAINT_MS = 325;

/** One representative agent-style message: fence, table, list, mention,
 * emphasis, inline code, and a link — the mix real Buzz channels carry. */
function markdownBody(index: number): string {
  return [
    `**Update ${index}** from the build agent — _step ${index} of ${MARKDOWN_MESSAGE_COUNT}_ :tada:`,
    "",
    "```rust",
    `fn step_${index}() -> Result<Status, Error> {`,
    '    let plan = load_plan("release")?;',
    `    plan.execute(${index})`,
    "}",
    "```",
    "",
    "| check | result | took |",
    "|-------|--------|------|",
    `| clippy | ok | ${index}ms |`,
    `| fmt | ok | ${index + 1}ms |`,
    "",
    `- [x] compile stage ${index}`,
    "- [ ] publish artifacts",
    `- see [pipeline](https://example.com/build/${index}) or ask @alice`,
    "",
    `Inline \`cargo build -p step-${index}\` finished.`,
  ].join("\n");
}

type SwitchSample = {
  ms: number;
  longtaskTotal: number;
  longtaskMax: number;
  longtaskCount: number;
  liveMessageCount: number;
  renderedMessageCount: number;
  visibleMessageIds: string[];
  distanceFromBottom: number;
  rowRenderCount: number;
  mountedRowCount: number;
};

type ScenarioResult = {
  samples: SwitchSample[];
  cachedMessageCount: number;
  expectedVisibleMessageIds: string[];
  windowFetches: number;
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

async function waitForMockLiveSubscription(
  page: import("@playwright/test").Page,
  channelName: string,
) {
  await expect
    .poll(() =>
      page.evaluate(
        (ch) =>
          window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
            channelName: ch,
          }) ?? false,
        channelName,
      ),
    )
    .toBe(true);
}

/** Click the sidebar link and poll — all in-page — until the target channel's
 * correct visible viewport is committed and a frame paints. Returns wall-clock
 * ms plus the longtasks observed in the window. */
async function measureSwitch(
  page: import("@playwright/test").Page,
  input: { targetTestId: string; targetTitle: string; rowSelector: string },
): Promise<SwitchSample> {
  return page.evaluate(async (args) => {
    const store = window as unknown as {
      __LONGTASKS__: number[];
      __TIMELINE_ROW_RENDER_COUNT__?: number;
    };
    store.__LONGTASKS__ = [];
    store.__TIMELINE_ROW_RENDER_COUNT__ = 0;
    const link = document.querySelector<HTMLElement>(
      `[data-testid="${args.targetTestId}"]`,
    );
    if (!link) throw new Error(`missing sidebar link ${args.targetTestId}`);

    const start = performance.now();
    link.click();

    await new Promise<void>((resolve, reject) => {
      const deadline = start + 30_000;
      const check = () => {
        const title = document.querySelector(
          '[data-testid="chat-title"]',
        )?.textContent;
        const timeline = document.querySelector<HTMLDivElement>(
          '[data-testid="message-timeline"]',
        );
        const counts = document.querySelector<HTMLElement>(
          "[data-rendered-message-count]",
        );
        const snapshotsMatch =
          Number(counts?.dataset.liveMessageCount ?? "0") > 0 &&
          counts?.dataset.renderedMessageCount ===
            counts?.dataset.liveMessageCount;
        const atBottom = timeline
          ? timeline.scrollHeight -
              timeline.clientHeight -
              timeline.scrollTop <=
            2
          : false;
        const ready =
          title === args.targetTitle &&
          document.querySelector(args.rowSelector) !== null &&
          snapshotsMatch &&
          atBottom;
        if (ready) {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          return;
        }
        if (performance.now() > deadline) {
          reject(new Error(`switch to ${args.targetTitle} timed out`));
          return;
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });

    const elapsed = performance.now() - start;
    const tasks = store.__LONGTASKS__ ?? [];
    const snapshot = document.querySelector<HTMLElement>(
      "[data-rendered-message-count]",
    );
    const timeline = document.querySelector<HTMLDivElement>(
      '[data-testid="message-timeline"]',
    );
    const timelineRect = timeline?.getBoundingClientRect();
    const visibleMessageIds =
      timeline && timelineRect
        ? Array.from(
            timeline.querySelectorAll<HTMLElement>("[data-message-id]"),
          )
            .filter((row) => {
              const rect = row.getBoundingClientRect();
              return (
                rect.bottom > timelineRect.top && rect.top < timelineRect.bottom
              );
            })
            .map((row) => row.dataset.messageId ?? "")
            .filter(Boolean)
        : [];
    const distanceFromBottom = timeline
      ? timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop
      : Number.POSITIVE_INFINITY;
    const liveMessageCount = Number(snapshot?.dataset.liveMessageCount ?? "0");
    const renderedMessageCount = Number(
      snapshot?.dataset.renderedMessageCount ?? "0",
    );
    return {
      ms: elapsed,
      longtaskTotal: tasks.reduce((sum, duration) => sum + duration, 0),
      longtaskMax: tasks.length ? Math.max(...tasks) : 0,
      longtaskCount: tasks.length,
      liveMessageCount,
      renderedMessageCount,
      visibleMessageIds,
      distanceFromBottom,
      rowRenderCount: store.__TIMELINE_ROW_RENDER_COUNT__ ?? 0,
      mountedRowCount:
        timeline?.querySelectorAll("[data-message-id]").length ?? 0,
    };
  }, input);
}

async function runScenario(
  page: import("@playwright/test").Page,
  input: {
    label: string;
    targetTestId: string;
    targetTitle: string;
    rowSelector: string;
  },
): Promise<ScenarioResult> {
  const back = {
    targetTestId: "channel-general",
    targetTitle: "general",
    rowSelector: "[data-message-id]",
  };

  // Untimed warmup round-trip: caches both channels' queries. Its settled
  // message count is the complete cached window every measured re-entry must
  // release after the bounded first paint.
  const warmup = await measureSwitch(page, input);
  const cachedMessageCount = warmup.liveMessageCount;
  const expectedVisibleMessageIds = warmup.visibleMessageIds;
  await measureSwitch(page, back);

  await page.evaluate(() => {
    (
      window as unknown as { __CHANNEL_WINDOW_FETCH_COUNT__?: number }
    ).__CHANNEL_WINDOW_FETCH_COUNT__ = 0;
  });

  const samples: SwitchSample[] = [];
  for (let run = 0; run < MEASURED_SWITCHES; run += 1) {
    samples.push(await measureSwitch(page, input));
    await measureSwitch(page, back);
  }

  const times = samples.map((sample) => sample.ms);
  const longtaskTotals = samples.map((sample) => sample.longtaskTotal);
  /* eslint-disable no-console */
  console.log(`\n=== WARM SWITCH: ${input.label} ===`);
  console.log(`CPU throttle:            ${THROTTLE_RATE}x`);
  console.log(
    `per-switch wall ms:      [${times.map((v) => v.toFixed(1)).join(", ")}]`,
  );
  console.log(
    `per-switch longtask ms:  [${longtaskTotals.map((v) => v.toFixed(1)).join(", ")}]`,
  );
  console.log(
    `row renders / mounted:    [${samples
      .map((sample) => `${sample.rowRenderCount}/${sample.mountedRowCount}`)
      .join(", ")}]`,
  );
  console.log(`MEDIAN wall ms:          ${median(times).toFixed(1)}`);
  console.log(
    `MEDIAN longtask total:   ${median(longtaskTotals).toFixed(1)}ms`,
  );
  console.log(
    `worst single longtask:   ${Math.max(...samples.map((sample) => sample.longtaskMax)).toFixed(1)}ms`,
  );
  /* eslint-enable no-console */
  const windowFetches = await page.evaluate(
    () =>
      (window as unknown as { __CHANNEL_WINDOW_FETCH_COUNT__?: number })
        .__CHANNEL_WINDOW_FETCH_COUNT__ ?? 0,
  );
  return {
    samples,
    cachedMessageCount,
    expectedVisibleMessageIds,
    windowFetches,
  };
}

async function fetchOneOlderWindow(
  page: import("@playwright/test").Page,
): Promise<number> {
  return page.evaluate(async () => {
    const timeline = document.querySelector<HTMLDivElement>(
      '[data-testid="message-timeline"]',
    );
    if (!timeline) throw new Error("missing message timeline");
    const probe = window as unknown as {
      __CHANNEL_WINDOW_FETCH_COUNT__?: number;
    };
    probe.__CHANNEL_WINDOW_FETCH_COUNT__ = 0;

    for (let step = 0; step < 400; step += 1) {
      timeline.scrollBy(0, -300);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => window.setTimeout(resolve, 25)),
      );
      if ((probe.__CHANNEL_WINDOW_FETCH_COUNT__ ?? 0) > 0) break;
    }

    const deadline = performance.now() + 5_000;
    while (document.querySelector('[data-render-pending="true"]') !== null) {
      if (performance.now() > deadline) {
        throw new Error("older window did not finish rendering");
      }
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    }
    // Give a faulty re-armed observer time to issue a duplicate request.
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    return probe.__CHANNEL_WINDOW_FETCH_COUNT__ ?? 0;
  });
}

test("MEASURE: warm channel-switch cost (plain 300-row + markdown-heavy)", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await installMockBridge(page);
  await page.goto("/");
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__ === "function",
  );

  // Arm the longtask observer; addInitScript applies on next navigation.
  await page.addInitScript(() => {
    const store = window as unknown as { __LONGTASKS__?: number[] };
    store.__LONGTASKS__ = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        store.__LONGTASKS__?.push(entry.duration);
      }
    }).observe({ type: "longtask", buffered: true });
  });
  await page.reload();
  await page.waitForFunction(
    () =>
      typeof window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__ === "function" &&
      Array.isArray(
        (window as unknown as { __LONGTASKS__?: number[] }).__LONGTASKS__,
      ),
  );

  // Seed `random` with markdown-heavy rows. Live emits need an active
  // subscription, so enter the channel first; the mock store keeps the rows
  // for every later re-entry via get_channel_window.
  await page.getByTestId("channel-random").click();
  await expect(page.getByTestId("chat-title")).toHaveText("random");
  await waitForMockLiveSubscription(page, "random");
  await page.evaluate(
    ({ count, bodies }) => {
      const base = Math.floor(Date.now() / 1000) - count - 10;
      for (let index = 0; index < count; index += 1) {
        window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
          channelName: "random",
          content: bodies[index],
          createdAt: base + index,
        });
      }
    },
    {
      count: MARKDOWN_MESSAGE_COUNT,
      bodies: Array.from({ length: MARKDOWN_MESSAGE_COUNT }, (_, index) =>
        markdownBody(index),
      ),
    },
  );
  // All injected rows committed before anything is timed.
  await expect(
    page.locator(`text=Update ${MARKDOWN_MESSAGE_COUNT - 1}`).first(),
  ).toBeVisible();

  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE_RATE });

  const plain = await runScenario(page, {
    label: "plain-text ~50-row window (deep-history)",
    targetTestId: "channel-deep-history",
    targetTitle: "deep-history",
    rowSelector: '[data-message-id^="mock-deep-history-"]',
  });
  const markdown = await runScenario(page, {
    label: `markdown-heavy x${MARKDOWN_MESSAGE_COUNT} (random)`,
    targetTestId: "channel-random",
    targetTitle: "random",
    rowSelector: "[data-message-id]",
  });

  await client.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  expect(plain.samples).toHaveLength(MEASURED_SWITCHES);
  expect(markdown.samples).toHaveLength(MEASURED_SWITCHES);
  expect(plain.cachedMessageCount).toBeGreaterThan(6);
  expect(markdown.cachedMessageCount).toBeGreaterThan(6);
  expect(plain.expectedVisibleMessageIds.length).toBeGreaterThan(0);
  expect(markdown.expectedVisibleMessageIds.length).toBeGreaterThan(0);
  expect(
    plain.samples.every(
      (sample) =>
        sample.liveMessageCount === plain.cachedMessageCount &&
        sample.visibleMessageIds.some((id) =>
          plain.expectedVisibleMessageIds.includes(id),
        ) &&
        sample.distanceFromBottom <= 2,
    ),
  ).toBe(true);
  expect(
    markdown.samples.every(
      (sample) =>
        sample.liveMessageCount === markdown.cachedMessageCount &&
        sample.visibleMessageIds.some((id) =>
          markdown.expectedVisibleMessageIds.includes(id),
        ) &&
        sample.distanceFromBottom <= 2,
    ),
  ).toBe(true);

  expect(plain.windowFetches).toBe(0);
  expect(markdown.windowFetches).toBe(0);
  expect(
    Math.max(...plain.samples.map((sample) => sample.longtaskMax)),
  ).toBeLessThanOrEqual(PLAIN_MAX_LONGTASK_MS);
  expect(
    Math.max(...markdown.samples.map((sample) => sample.longtaskMax)),
  ).toBeLessThanOrEqual(MARKDOWN_MAX_LONGTASK_MS);
  expect(
    Math.max(...plain.samples.map((sample) => sample.ms)),
  ).toBeLessThanOrEqual(PLAIN_MAX_CORRECT_PAINT_MS);
  expect(
    Math.max(...markdown.samples.map((sample) => sample.ms)),
  ).toBeLessThanOrEqual(MARKDOWN_MAX_CORRECT_PAINT_MS);

  // A genuine older-history reach remains network-backed and bounded to one
  // channel-window request. The warm-navigation assertions above prove the
  // same counter stays at zero when no continuation is needed.
  await measureSwitch(page, {
    targetTestId: "channel-deep-history",
    targetTitle: "deep-history",
    rowSelector: '[data-message-id^="mock-deep-history-"]',
  });
  expect(await fetchOneOlderWindow(page)).toBe(1);
});
