import { expect, test, type Page } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

test.use({ video: "on" });

const CHANNEL_ID = "7b4d3d2e-3c15-4e88-9a11-1c0f7d2b6e55";
const ROOT_EVENT_ID = "c3".repeat(32);
const TARGET_EVENT_ID = "d4".repeat(32);
const AGENT_PUBKEY = "6".repeat(64);
const MESSAGE_LINK = `buzz://message?channel=${CHANNEL_ID}&id=${TARGET_EVENT_ID}&thread=${ROOT_EVENT_ID}`;
const CANVAS = `# Board context references demo

\`\`\`buzz-workstream-card
${JSON.stringify({
  version: 1,
  synopsis: "Discuss immutable Board context with humans and orchestrators.",
  orchestrator: { pubkey: AGENT_PUBKEY, name: "Board Orchestrator" },
  assignees: [{ pubkey: "7".repeat(64), name: "Field Agent" }],
  pullRequests: ["https://github.com/block/buzz/pull/6357"],
  waitingOn: [
    {
      key: "decision-thread",
      actor: { kind: "person", name: "Logan", pubkey: "8".repeat(64) },
      reason: "Decide the rollout in the cited thread",
      since: "2026-08-19T21:00:00.000Z",
      message: MESSAGE_LINK,
    },
  ],
})}
\`\`\``;

type BoardReference = {
  kind: "thread-blocker";
  identity: string;
  snapshot: { label: string; detail?: string };
  placement: {
    workstreamId: string;
    workstreamLabel: string;
    sectionId: string;
    sectionLabel: string;
  };
  destination: {
    channelId: string;
    messageId: string;
    threadRootId?: string;
  };
};

async function invoke(
  page: Page,
  command: string,
  payload: Record<string, unknown>,
) {
  return page.evaluate(
    async ({ command: target, payload: args }) => {
      const fn = window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__;
      if (!fn) throw new Error("Mock invoke bridge is unavailable.");
      return fn(target, args);
    },
    { command, payload },
  );
}

test("human and orchestrator references replay live and removed Board context", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await installMockBridge(page, {
    workstreamBoardFixture: {
      channelId: CHANNEL_ID,
      channelName: "loganj-ws-board-context",
      canvas: CANVAS,
      rootEventId: ROOT_EVENT_ID,
      targetEventId: TARGET_EVENT_ID,
    },
    managedAgents: [
      {
        pubkey: AGENT_PUBKEY,
        name: "Board Orchestrator",
        channelIds: [CHANNEL_ID],
      },
    ],
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("app-sidebar")).toBeVisible();
  await page.getByTestId("open-workstream-board-view").click();
  const board = page.getByTestId("workstream-board-view");
  await expect(board).toBeVisible();
  await board.getByRole("button", { name: "Discuss Board" }).click();

  const options = page.getByTestId(`board-reference-options-${CHANNEL_ID}`);
  await expect(options).toBeVisible();
  await options.getByRole("button", { name: /workstream:/ }).click();
  await options.getByRole("button", { name: /thread-blocker:/ }).click();
  await expect(page.getByText("Reference tray (2)")).toBeVisible();
  await page
    .getByLabel("Discussion message")
    .fill("Human: use this workstream and blocker context.");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const humanMessage = page.getByRole("button", {
    name: /Human: use this workstream and blocker context\./,
  });
  await expect(humanMessage).toBeVisible();
  await humanMessage.click();
  await expect(page.getByTestId("board-discussion")).toContainText(
    "Replay 1/2: 2 live",
  );
  await expect(page.getByTestId(`workstream-card-${CHANNEL_ID}`)).toHaveClass(
    /ring-2/,
  );
  await page.screenshot({
    path: testInfo.outputPath("human-live-replay.png"),
    fullPage: true,
  });
  await page.waitForTimeout(1_500);

  const removedReference: BoardReference = {
    kind: "thread-blocker",
    identity: "removed-deployment-gate",
    snapshot: {
      label: "Removed deployment approval",
      detail: "Release captain",
    },
    placement: {
      workstreamId: CHANNEL_ID,
      workstreamLabel: "loganj-ws-board-context",
      sectionId: "blockers",
      sectionLabel: "Blockers",
    },
    destination: {
      channelId: CHANNEL_ID,
      messageId: TARGET_EVENT_ID,
      threadRootId: ROOT_EVENT_ID,
    },
  };
  await invoke(page, "send_managed_agent_channel_message", {
    agentPubkey: AGENT_PUBKEY,
    channelId: CHANNEL_ID,
    content:
      "Orchestrator: this points to the approval removed after state advanced.",
    marker: "board-context-orchestrator",
    boardReferences: [removedReference],
  });

  // Open the workstream conversation, where the orchestrator-authored live
  // event renders its machine-readable reference chip. Clicking the chip
  // carries immutable replay state back to the Board.
  await options.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/channels/${CHANNEL_ID}`));
  const orchestratorRow = page.getByText(
    "Orchestrator: this points to the approval removed after state advanced.",
  );
  await expect(orchestratorRow).toBeVisible();
  const orchestratorMessage = orchestratorRow.locator(
    "xpath=ancestor::*[@data-testid='message-row']",
  );
  await orchestratorMessage.getByTestId("message-board-references").click();
  await expect(page).toHaveURL(/\/workstreams$/);
  await expect(page.getByTestId("workstream-board-view")).toBeVisible();
  await expect(page.getByTestId("board-discussion")).toContainText(
    "Replay 1/1: 0 live · 0 changed · 1 historical",
  );
  await expect(page.getByText("Historical references")).toBeVisible();
  await expect(
    page.getByText(/Removed deployment approval · formerly/),
  ).toContainText("loganj-ws-board-context / Blockers");
  await page.screenshot({
    path: testInfo.outputPath("orchestrator-removed-replay.png"),
    fullPage: true,
  });
  await page.waitForTimeout(2_500);
});
