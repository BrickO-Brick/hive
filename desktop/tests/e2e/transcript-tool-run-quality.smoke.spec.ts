import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const AGENT_PUBKEY = TEST_IDENTITIES.tyler.pubkey;
const CHANNEL_ID = "94a444a4-c0a3-5966-ab05-530c6ddc2301";
const NOW = new Date("2025-06-15T12:00:00Z").toISOString();

const MANAGED_AGENTS = [
  {
    pubkey: AGENT_PUBKEY,
    name: "Observer Agent",
    status: "running" as const,
    channelNames: ["agents"],
  },
];

async function openFeed(page: import("@playwright/test").Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__ === "function",
  );
  await page.getByTestId("channel-agents").click();
  const row = page
    .getByTestId("message-row")
    .filter({ has: page.getByText("Observer Agent", { exact: false }) })
    .first();
  await row.getByRole("button").first().click();
  await page.getByTestId(`user-profile-view-activity-${AGENT_PUBKEY}`).click();
  return page.getByTestId("agent-session-thread-panel");
}

function event(
  seq: number,
  toolCallId: string,
  update: Record<string, unknown>,
) {
  return {
    seq,
    timestamp: NOW,
    kind: "acp_read",
    agentIndex: 0,
    channelId: CHANNEL_ID,
    sessionId: "session-quality",
    turnId: "turn-quality",
    payload: {
      method: "session/update",
      params: {
        sessionId: "session-quality",
        update: { toolCallId, ...update },
      },
    },
  };
}

async function seed(
  page: import("@playwright/test").Page,
  events: ReturnType<typeof event>[],
) {
  await page.evaluate(
    ({ pubkey, events }) =>
      window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__?.({
        agentPubkey: pubkey,
        events,
      }),
    { pubkey: AGENT_PUBKEY, events },
  );
}

test("tool-run group stays readable through live completion and user expansion", async ({
  page,
}) => {
  await installMockBridge(page, { managedAgents: MANAGED_AGENTS });
  const panel = await openFeed(page);

  await seed(page, [
    event(1, "read-a", {
      sessionUpdate: "tool_call",
      status: "executing",
      title: "read_file",
      kind: "read_file",
      rawInput: { path: "src/a.ts" },
    }),
    event(2, "read-b", {
      sessionUpdate: "tool_call",
      status: "executing",
      title: "read_file",
      kind: "read_file",
      rawInput: { path: "src/b.ts" },
    }),
    event(3, "read-c", {
      sessionUpdate: "tool_call",
      status: "executing",
      title: "read_file",
      kind: "read_file",
      rawInput: { path: "src/c.ts" },
    }),
  ]);

  const group = panel.getByTestId("transcript-same-kind-summary");
  await expect(group).toHaveAttribute("open", "");
  await expect(
    group.getByTestId("tool-run-group-status-running"),
  ).toBeVisible();

  await group.locator("summary").first().click();
  await expect(group).not.toHaveAttribute("open", "");
  await group.locator("summary").first().click();
  await expect(group).toHaveAttribute("open", "");

  await seed(page, [
    event(4, "read-a", {
      sessionUpdate: "tool_call_update",
      status: "completed",
      title: "read_file",
      kind: "read_file",
      rawInput: { path: "src/a.ts" },
      rawOutput: "a",
    }),
    event(5, "read-b", {
      sessionUpdate: "tool_call_update",
      status: "completed",
      title: "read_file",
      kind: "read_file",
      rawInput: { path: "src/b.ts" },
      rawOutput: "b",
    }),
    event(6, "read-c", {
      sessionUpdate: "tool_call_update",
      status: "completed",
      title: "read_file",
      kind: "read_file",
      rawInput: { path: "src/c.ts" },
      rawOutput: "c",
    }),
  ]);

  await expect(group).toHaveAttribute("open", "");
  const child = group
    .getByTestId("transcript-tool-item")
    .first()
    .locator("details");
  await child.locator("summary").click();
  await expect(child).toHaveAttribute("open", "");
  await group.locator("summary").first().click();
  await group.locator("summary").first().click();
  await expect(child).toHaveAttribute("open", "");
});
