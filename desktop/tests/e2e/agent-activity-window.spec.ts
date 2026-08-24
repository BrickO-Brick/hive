import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const AGENT_PUBKEY = TEST_IDENTITIES.tyler.pubkey;
const REPOSITORY_OWNER_PUBKEY = TEST_IDENTITIES.alice.pubkey;
const AGENTS_CHANNEL_ID = "94a444a4-c0a3-5966-ab05-530c6ddc2301";
const GENERAL_CHANNEL_ID = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
const COMMUNITY_ID = "e2e-default-community";

test("keeps dedicated activity windows pinned to their original channel", async ({
  page,
}) => {
  await installMockBridge(page, {
    windowLabel: `agent-activity-${AGENT_PUBKEY}-${AGENTS_CHANNEL_ID}`,
    managedAgents: [
      {
        pubkey: AGENT_PUBKEY,
        name: "Observer Agent",
        status: "running",
        channelNames: ["agents"],
      },
    ],
  });

  await page.goto(
    `/#/channels/${AGENTS_CHANNEL_ID}?community=${COMMUNITY_ID}&agentSession=${AGENT_PUBKEY}&agentSessionChannel=${AGENTS_CHANNEL_ID}`,
  );
  const panel = page.getByTestId("agent-session-thread-panel");
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__ === "function",
  );
  await page.evaluate(
    ({ agentPubkey, channelId, generalChannelId, repositoryOwnerPubkey }) => {
      window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__?.({
        agentPubkey,
        events: [
          {
            seq: 1,
            timestamp: new Date().toISOString(),
            kind: "acp_read",
            agentIndex: 0,
            channelId,
            sessionId: "session-activity-window",
            turnId: "turn-activity-window",
            payload: {
              method: "session/update",
              params: {
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: {
                    type: "text",
                    text: `Continue in #general or open <buzz://repo?owner=${repositoryOwnerPubkey}&d=relay-tools>`,
                  },
                },
              },
            },
          },
          {
            seq: 2,
            timestamp: new Date().toISOString(),
            kind: "acp_read",
            agentIndex: 0,
            channelId,
            sessionId: "session-user-message",
            turnId: "turn-user-message",
            payload: {
              method: "session/update",
              params: {
                update: {
                  sessionUpdate: "user_message_chunk",
                  authorPubkey: repositoryOwnerPubkey,
                  content: { type: "text", text: "Please inspect the feed" },
                },
              },
            },
          },
          {
            seq: 3,
            timestamp: new Date().toISOString(),
            kind: "turn_started",
            agentIndex: 0,
            channelId,
            sessionId: "session-original-channel",
            turnId: "turn-original-channel",
            payload: { source: "channel", triggeringEventIds: [] },
          },
          {
            seq: 4,
            timestamp: new Date().toISOString(),
            kind: "acp_read",
            agentIndex: 0,
            channelId: generalChannelId,
            sessionId: "session-other-channel",
            turnId: "turn-other-channel",
            payload: {
              method: "session/update",
              params: {
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: {
                    type: "text",
                    text: "Other channel activity must stay hidden",
                  },
                },
              },
            },
          },
        ],
      });
    },
    {
      agentPubkey: AGENT_PUBKEY,
      channelId: AGENTS_CHANNEL_ID,
      generalChannelId: GENERAL_CHANNEL_ID,
      repositoryOwnerPubkey: REPOSITORY_OWNER_PUBKEY,
    },
  );

  await expect(panel).toContainText("Activity · #agents");
  await expect(panel).not.toContainText(
    "Other channel activity must stay hidden",
  );

  const channelReference = panel.locator("[data-channel-link]");
  await expect(channelReference).toContainText("general");
  await expect(
    panel.getByRole("button", { name: "Open channel general" }),
  ).toHaveCount(0);
  const activityWindowUrl = page.url();

  await expect(
    panel.getByRole("button", { name: "Open alice profile" }),
  ).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(page).toHaveURL(/agentSession=/);
  await expect(page).toHaveURL(/agentSessionChannel=/);

  await expect(panel).toContainText("relay-tools");
  await expect(
    panel.getByRole("button", { name: "Open repository relay-tools" }),
  ).toHaveCount(0);
  await expect(page).toHaveURL(activityWindowUrl);

  await page.getByTestId("agent-session-settings-menu-trigger").click();
  const rawFeedToggle = page.getByTestId("agent-session-toggle-raw-feed");
  await expect(rawFeedToggle).toHaveAttribute(
    "title",
    "Show raw JSON-RPC payloads for this channel.",
  );
  const stopTurn = page.getByTestId("agent-session-stop-turn");
  await expect(stopTurn).toBeEnabled();

  await page.evaluate(() => {
    const tauri = window.__TAURI_INTERNALS__;
    const invoke = tauri?.invoke;
    if (!tauri || !invoke)
      throw new Error("Mock invoke bridge is unavailable.");
    window.__BUZZ_E2E_ACTIVITY_CONTROL_REQUESTS__ = [];
    tauri.invoke = async (command, payload) => {
      if (command === "build_observer_control_event") {
        window.__BUZZ_E2E_ACTIVITY_CONTROL_REQUESTS__?.push(payload);
        throw new Error("Control request captured by the E2E test.");
      }
      return invoke(command, payload);
    };
  });
  await stopTurn.click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__BUZZ_E2E_ACTIVITY_CONTROL_REQUESTS__?.[0] ?? null,
      ),
    )
    .toMatchObject({
      agentPubkey: AGENT_PUBKEY,
      payload: { type: "cancel_turn", channelId: AGENTS_CHANNEL_ID },
    });
  await expect(page.locator("body")).not.toBeEmpty();
});
