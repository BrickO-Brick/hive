import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const AGENT_PUBKEY = TEST_IDENTITIES.tyler.pubkey;
const AGENTS_CHANNEL_ID = "94a444a4-c0a3-5966-ab05-530c6ddc2301";
const GENERAL_CHANNEL_ID = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
const COMMUNITY_ID = "e2e-default-community";

test("keeps dedicated activity windows connected when opening a channel reference", async ({
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
    `/#/channels/${AGENTS_CHANNEL_ID}?community=${COMMUNITY_ID}&agentSession=${AGENT_PUBKEY}`,
  );
  const panel = page.getByTestId("agent-session-thread-panel");
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__ === "function",
  );
  await page.evaluate(
    ({ agentPubkey, channelId }) => {
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
                  content: { type: "text", text: "Continue in #general" },
                },
              },
            },
          },
        ],
      });
    },
    { agentPubkey: AGENT_PUBKEY, channelId: AGENTS_CHANNEL_ID },
  );

  const channelReference = panel.getByRole("button", {
    name: "Open channel general",
  });
  await expect(channelReference).toBeVisible();
  await channelReference.click();

  await expect(page).toHaveURL(
    new RegExp(
      `#/channels/${GENERAL_CHANNEL_ID}\\?.*community=${COMMUNITY_ID}`,
    ),
  );
  await expect(panel).toBeVisible();
  await expect(page.locator("body")).not.toBeEmpty();
});
