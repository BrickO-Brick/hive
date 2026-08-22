import { expect, test, type Page } from "@playwright/test";

import { KIND_TYPING_INDICATOR } from "../../src/shared/constants/kinds";
import { TEST_IDENTITIES, installMockBridge } from "../helpers/bridge";

const AGENT_PUBKEY = TEST_IDENTITIES.alice.pubkey;

/** Two panes fit, so the agent panel covers. */
const WIDE_VIEWPORT = { width: 1280, height: 800 };

/** Below the two-pane breakpoint, so today's presentation is unchanged. */
const NARROW_VIEWPORT = { width: 860, height: 800 };

async function waitForMockLiveSubscription(
  page: Page,
  channelName: string,
  kind?: number,
) {
  await expect
    .poll(() =>
      page.evaluate(
        ({ currentChannelName, currentKind }) =>
          (
            window as Window & {
              __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
                channelName: string;
                kind?: number;
              }) => boolean;
            }
          ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
            channelName: currentChannelName,
            kind: currentKind,
          }) ?? false,
        { currentChannelName: channelName, currentKind: kind },
      ),
    )
    .toBe(true);
}

async function seedThreadRoot(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => typeof window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__ === "function",
      ),
    )
    .toBe(true);
  return page.evaluate(() => {
    const root = window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName: "agents",
      content: "Cover drawer exclusivity thread",
      createdAt: 1_700_800_000,
    });
    if (!root) throw new Error("Failed to seed thread root");
    window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName: "agents",
      content: "A reply so the thread summary renders.",
      parentEventId: root.id,
      createdAt: 1_700_800_001,
    });
    return root.id;
  });
}

/**
 * Opens the agent activity panel from the composer activity bar — the ingress
 * that has no prior pane, so the header shows close and no back arrow.
 */
async function openActivityFromComposer(page: Page) {
  await page.getByTestId("channel-agents").click();
  await expect(page.getByTestId("chat-title")).toHaveText("agents");
  await waitForMockLiveSubscription(page, "agents", KIND_TYPING_INDICATOR);

  await page.evaluate((pubkey) => {
    window.__BUZZ_E2E_EMIT_MOCK_TYPING__?.({
      channelName: "agents",
      pubkey,
    });
  }, AGENT_PUBKEY);

  const trigger = page.getByTestId("bot-activity-composer-trigger");
  await expect(trigger).toBeVisible();
  await trigger.click();
  const item = page.getByTestId(`bot-activity-composer-item-${AGENT_PUBKEY}`);
  await expect(item).toBeVisible();
  await item.click({ force: true });
  await expect(page.getByTestId("agent-session-thread-panel")).toBeVisible();
}

/**
 * The default mock bridge already seeds alice as an agent in `#agents`, which
 * is what makes her eligible for the composer activity bar once she types.
 * Re-seeding her through `managedAgents` instead *replaces* that relay-agent
 * row with a managed one that is not in the channel's working-agent set, so the
 * trigger never renders — use the default seed.
 */
test.beforeEach(async ({ page }) => {
  await installMockBridge(page);
});

test("agent activity covers the channel at wide viewports", async ({
  page,
}) => {
  await page.setViewportSize(WIDE_VIEWPORT);
  await page.goto("/");
  await openActivityFromComposer(page);

  const channel = page.getByTestId("channel-drop-zone");
  const drawer = page.getByTestId("agent-activity-drawer");
  const panel = page.getByTestId("agent-session-thread-panel");

  // Covering, not splitting: the panel lives inside the drawer, the channel is
  // inert behind it, and there is no split pane to resize.
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId("agent-session-thread-panel")).toBeVisible();
  await expect(channel).toHaveAttribute("inert", "");
  await expect(
    page.getByTestId("right-auxiliary-pane-resize-handle"),
  ).toHaveCount(0);

  // Activity never offers the thread's focus/split switch.
  await expect(page.getByTestId("thread-view-mode-toggle")).toHaveCount(0);

  // The drawer owns the entrance, so the panel must not slide too — a second
  // animation inside a moving container compounds into a double slide.
  await expect(panel).not.toHaveClass(/buzz-side-panel-enter/);

  // Wide enough to read a transcript: the drawer takes the channel content
  // area less the sliver, so it is far wider than the split pane it replaces.
  const drawerWidth = (await drawer.boundingBox())?.width ?? 0;
  expect(drawerWidth).toBeGreaterThan(700);

  // The drawer captures focus, and the panel keeps its close affordance.
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          document
            .querySelector('[data-testid="agent-activity-drawer"]')
            ?.contains(document.activeElement),
        ),
      ),
    )
    .toBe(true);
  await expect(page.getByTestId("agent-session-back")).toHaveCount(0);
  await expect(page.getByTestId("auxiliary-panel-close")).toBeVisible();

  // Escape leaves — and the settings menu still gets its own press first.
  await page.getByTestId("agent-session-settings-menu-trigger").click();
  await expect(page.getByTestId("agent-session-stop-turn")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("agent-session-stop-turn")).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("agent-activity-drawer-overlay")).toHaveCount(
    0,
  );
  await expect(panel).toHaveCount(0);
  await expect(channel).not.toHaveAttribute("inert", "");

  // The scrim is the click target back to the channel.
  await openActivityFromComposer(page);
  await expect(drawer).toBeVisible();
  await page
    .getByTestId("agent-activity-drawer-scrim")
    .click({ position: { x: 24, y: 300 } });
  await expect(page.getByTestId("agent-activity-drawer-overlay")).toHaveCount(
    0,
  );
  await expect(channel).not.toHaveAttribute("inert", "");
});

test("only one cover drawer is ever open", async ({ page }) => {
  await page.setViewportSize(WIDE_VIEWPORT);
  await page.addInitScript(() => {
    localStorage.setItem("buzz.channels.threadViewMode", "focus");
  });
  await page.goto("/");
  const rootId = await seedThreadRoot(page);
  await openActivityFromComposer(page);

  const agentDrawer = page.getByTestId("agent-activity-drawer");
  const threadDrawer = page.getByTestId("focus-thread-drawer");
  await expect(agentDrawer).toBeVisible();

  // Opening a thread from the covered channel is not possible while it is
  // inert, so drive the same handler the timeline uses: leave activity, then
  // open the thread. The thread drawer takes the covered slot alone.
  await page.getByTestId("auxiliary-panel-close").click();
  await expect(agentDrawer).toHaveCount(0);

  const summary = page.locator(
    `[data-testid="message-thread-summary"][data-thread-head-id="${rootId}"]`,
  );
  await expect(summary).toBeVisible();
  await summary.click();
  await expect(threadDrawer).toBeVisible();
  await expect(agentDrawer).toHaveCount(0);

  // Now open activity with the thread still in the URL: the agent surface wins
  // nothing — the thread owns the slot — and crucially there is never more
  // than one drawer overlay in the DOM.
  await expect(page.getByTestId("focus-thread-drawer-overlay")).toHaveCount(1);
  await expect(page.getByTestId("agent-activity-drawer-overlay")).toHaveCount(
    0,
  );

  // Escape returns the channel, then activity may cover again.
  await page.keyboard.press("Escape");
  await expect(threadDrawer).toHaveCount(0);
  await openActivityFromComposer(page);
  await expect(agentDrawer).toBeVisible();
  await expect(page.getByTestId("focus-thread-drawer-overlay")).toHaveCount(0);
});

test("narrow viewports keep the existing activity presentation", async ({
  page,
}) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto("/");
  await openActivityFromComposer(page);

  await expect(page.getByTestId("agent-session-thread-panel")).toBeVisible();
  await expect(page.getByTestId("agent-activity-drawer")).toHaveCount(0);
  await expect(page.getByTestId("agent-activity-drawer-overlay")).toHaveCount(
    0,
  );
  await expect(page.getByTestId("agent-activity-drawer-scrim")).toHaveCount(0);
  // Below the breakpoint the channel is replaced rather than covered, so the
  // pane it would be made inert behind is not rendered at all — and nothing
  // else on the page is inert either.
  await expect(page.getByTestId("channel-drop-zone")).toHaveCount(0);
  expect(await page.locator("[inert]").count()).toBe(0);
});
