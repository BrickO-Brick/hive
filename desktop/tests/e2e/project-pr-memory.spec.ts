import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

const ENGINEERING_CHANNEL_ID = "1c7e1c02-87bb-5e88-b2da-5a7a9432d0c9";
const RELAY_REVIEW_AGENT_PUBKEY =
  "554cef57437abac34522ac2c9f0490d685b72c80478cf9f7ed6f9570ee8624ea";
const SHOTS = "test-results/project-pr-memory";

async function openBuzzProject(page: import("@playwright/test").Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-projects-view").click();
  await page.getByTestId("projects-section-projects").click();
  const projectEntry = page
    .locator(
      '[data-testid="project-card-buzz"], [data-testid="project-row-buzz"]',
    )
    .first();
  await expect(projectEntry).toBeVisible({ timeout: 10_000 });
  await projectEntry.click();
  await page.getByTestId("project-home-context-repo-buzz").click();
}

async function openAliceReview(page: import("@playwright/test").Page) {
  await page.getByRole("tab", { name: "Review" }).click();
  const aliceReview = page
    .getByTestId("project-pull-request-row")
    .filter({
      has: page.getByRole("button", { name: "alice", exact: true }),
    })
    .first();
  await expect(aliceReview).toBeVisible({ timeout: 10_000 });
  await aliceReview.getByRole("button", { name: /^#/ }).click();
}

function requestIdFromPrompt(content: string | undefined): string {
  const requestId = content?.match(/"request_id":"([^"]+)"/)?.[1];
  expect(requestId).toBeTruthy();
  return requestId ?? "";
}

async function openerEventId(
  page: import("@playwright/test").Page,
  requestId: string,
) {
  const findOpener = () =>
    page.evaluate((expectedRequestId) => {
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (!key?.startsWith("buzz.projects.review-context.v1:")) continue;
        try {
          const run = JSON.parse(
            window.localStorage.getItem(key) ?? "null",
          ) as { requestId?: string; opener?: { eventId?: string } } | null;
          if (run?.requestId === expectedRequestId && run.opener?.eventId) {
            return run.opener.eventId;
          }
        } catch {
          // Ignore unrelated or partially written local state.
        }
      }
      return null;
    }, requestId);
  await expect.poll(findOpener).not.toBeNull();
  return (await findOpener()) ?? "";
}

async function waitForDmSubscription(page: import("@playwright/test").Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
            channelName: "DM",
          }) ?? false,
      ),
    )
    .toBe(true);
}

test("review context is discovered by an agent and restored as sourced evidence", async ({
  page,
}) => {
  await installMockBridge(page, undefined, { seedPreviewFeatures: true });
  await openBuzzProject(page);
  await openAliceReview(page);
  await page
    .getByRole("button", { name: "Prior art and future vision", exact: true })
    .click();

  const memory = page.getByTestId("project-review-memory");
  await expect(memory).toContainText("An agent finds the previous reviews");
  await expect(memory.getByRole("button", { name: "Add context" })).toHaveCount(
    0,
  );
  await expect(
    memory.getByRole("button", { name: "Record outcome" }),
  ).toHaveCount(0);
  await expect(
    memory.getByRole("combobox", { name: "Context agent" }),
  ).toHaveCount(0);
  await page.getByTestId("project-review-debug-harness-trigger").click();
  await page
    .getByTestId("project-review-debug-agent-select")
    .selectOption(RELAY_REVIEW_AGENT_PUBKEY);
  await memory
    .getByRole("button", { name: "Find context", exact: true })
    .click();
  await expect(memory).toContainText("Searching");

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__BUZZ_E2E_COMMAND_PAYLOADS__?.some(
          (entry) =>
            entry.command === "send_channel_message" &&
            typeof (entry.payload as { content?: unknown })?.content ===
              "string" &&
            (entry.payload as { content: string }).content.includes(
              "BUZZ_REVIEW_CONTEXT_RESULT_V1",
            ),
        ),
      ),
    )
    .toBe(true);
  const sentRequest = await page.evaluate(() => {
    const entry = window.__BUZZ_E2E_COMMAND_PAYLOADS__?.findLast(
      (candidate) => candidate.command === "send_channel_message",
    );
    return entry?.payload as
      | { content?: string; mentionPubkeys?: string[] }
      | undefined;
  });
  expect(sentRequest?.content).toContain("earlier pull requests or reviews");
  expect(sentRequest?.content).toContain(
    "project-linked Buzz channels and conversations",
  );
  expect(sentRequest?.content).toContain("Commit under review:");
  expect(sentRequest?.mentionPubkeys).toContain(RELAY_REVIEW_AGENT_PUBKEY);

  const requestId = requestIdFromPrompt(sentRequest?.content);
  const openerId = await openerEventId(page, requestId);

  await page.getByRole("button", { name: "Review", exact: true }).click();
  await openAliceReview(page);
  await page
    .getByRole("button", { name: "Prior art and future vision", exact: true })
    .click();
  const resumed = page.getByTestId("project-review-memory");
  await expect(resumed).toContainText("Searching");
  await expect(
    resumed.getByRole("button", {
      name: "Interrupt and find context again",
      exact: true,
    }),
  ).toBeEnabled();

  await waitForDmSubscription(page);
  await page.evaluate(
    ({ agentPubkey, channelId, openerId, requestId }) => {
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "DM",
        content: `BUZZ_REVIEW_CONTEXT_RESULT_V1\n${JSON.stringify({
          request_id: requestId,
          summary:
            "Earlier reviews kept checks advisory; the team now wants their reasoning to become durable project memory.",
          prior_art: [
            {
              title: "Keep review checks advisory",
              summary:
                "The earlier review explicitly separated automated guidance from merge authority.",
              source_url: "https://github.com/block/buzz/pull/803",
            },
          ],
          future_vision: [
            {
              title: "Turn review history into team memory",
              summary:
                "The engineering discussion asks future reviews to connect decisions with what happened later.",
              channel: "engineering",
              source_url: `buzz://message?channel=${channelId}&id=${"a".repeat(64)}`,
            },
          ],
        })}`,
        createdAt: Math.floor(Date.now() / 1_000) + 1,
        kind: 9,
        parentEventId: openerId,
        pubkey: agentPubkey,
      });
    },
    {
      agentPubkey: RELAY_REVIEW_AGENT_PUBKEY,
      channelId: ENGINEERING_CHANNEL_ID,
      openerId,
      requestId,
    },
  );

  const result = resumed.getByTestId("project-review-context-result");
  await expect(result).toContainText("Keep review checks advisory");
  await expect(result).toContainText("Turn review history into team memory");
  await expect(result).toContainText("#engineering");
  await expect(result.getByText("Open source")).toHaveCount(2);
  await waitForAnimations(page);
  await result.screenshot({ path: `${SHOTS}/review-context-result.png` });

  await page.getByRole("button", { name: "Review", exact: true }).click();
  await openAliceReview(page);
  await page
    .getByRole("button", { name: "Prior art and future vision", exact: true })
    .click();
  const restored = page.getByTestId("project-review-context-result");
  await expect(restored).toContainText("Keep review checks advisory");
  await expect(restored).toContainText("Turn review history into team memory");
});
