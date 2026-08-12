import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

const SHOTS = "test-results/projects-v3-screenshots";

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
}

// Walks the Projects v3 workspace through its headline states so PR
// screenshots capture distinct pixels per feature (overview box, tab-strip
// plus, issue detail with inline copy link + avatar timeline, PR detail).
test("projects v3 workspace screenshot states", async ({ page }) => {
  await installMockBridge(page);
  await openBuzzProject(page);

  // Single-box workspace: pickers + tab strip + readme overview.
  await expect(page.getByRole("tab", { name: "Files" })).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/01-workspace-overview.png` });

  // Issues tab: the create action lives in the tab strip now.
  await page.getByRole("tab", { name: "Issues", exact: true }).click();
  await expect(page.getByRole("button", { name: "New issue" })).toBeVisible();
  const issueRow = page.getByTestId("project-issue-row").first();
  await expect(issueRow).toBeVisible({ timeout: 10_000 });
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/02-issues-tab.png` });

  // Issue detail: inline copy link after the title, assignees rail, and the
  // avatar comment timeline (seed comments so the timeline renders).
  await issueRow.getByRole("button", { name: /^#/ }).click();
  const composer = page.getByTestId("project-issue-comment-composer");
  await expect(composer).toBeVisible();
  for (const comment of [
    "The palette needs the most work — starting there.",
    "Agreed. Typography pass can land separately.",
  ]) {
    await composer.locator('[contenteditable="true"]').fill(comment);
    await composer.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText(comment, { exact: true })).toBeVisible({
      timeout: 10_000,
    });
  }
  await expect(page.getByTestId("project-issue-copy-link")).toBeVisible();
  await expect(
    page.getByTestId("project-issue-comment-timeline-row").first(),
  ).toBeVisible();
  // Let the "Comment posted." toast dismiss so it doesn't photobomb.
  await expect(page.getByText("Comment posted.")).toHaveCount(0, {
    timeout: 10_000,
  });
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/03-issue-detail.png` });

  // PR detail: inline copy link after the PR title.
  await page.getByRole("tab", { name: "Pull Request", exact: true }).click();
  const prRow = page.getByTestId("project-pull-request-row").first();
  await expect(prRow).toBeVisible({ timeout: 10_000 });
  await prRow.getByRole("button", { name: /^#/ }).click();
  await expect(
    page.getByTestId("project-pull-request-copy-link"),
  ).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/04-pr-detail.png` });
});

test("projects v3 work-item list metadata", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("buzz.projects.viewMode", "list");
  });
  await installMockBridge(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-projects-view").click();

  await page.getByTestId("projects-section-prs").click();
  const pullRequestRow = page.getByTestId(/^projects-pr-row-/).first();
  await expect(pullRequestRow).toBeVisible();
  await expect(pullRequestRow).toContainText("feature/mock-2-0");
  await expect(pullRequestRow).not.toContainText(/#[0-9a-f]{8}/);
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/05-pr-list-metadata.png` });

  await page.getByTestId("projects-section-issues").click();
  const issueRow = page.getByTestId(/^projects-issue-row-/).first();
  await expect(issueRow).toBeVisible();
  await expect(issueRow).toContainText("relay-tools");
  await expect(issueRow).not.toContainText(/#[0-9a-f]{8}/);
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/06-issue-list-metadata.png` });
});
