import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

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

test("sidebar project add flow browses before creating", async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("sidebar-project-buzz")).toHaveCount(0);
  await page.getByTestId("sidebar-projects-section-label").hover();
  await page.getByTestId("sidebar-projects-create").click();

  const browser = page.getByTestId("project-browser-dialog");
  await expect(browser).toBeVisible();
  const search = browser.getByRole("searchbox", { name: "Search projects" });
  await search.fill("new workspace");
  await browser.getByTestId("project-browser-create").click();

  await expect(page.getByTestId("create-project-dialog")).toBeVisible();
  await expect(page.getByTestId("create-project-name")).toHaveValue(
    "new workspace",
  );
  await page.getByRole("button", { name: "Back to projects" }).click();
  await expect(browser).toBeVisible();

  await search.fill("buzz");
  await browser.getByTestId("project-browser-result-buzz").click();
  await expect(browser).toBeHidden();
  await expect(
    page.getByRole("navigation", { name: "Project breadcrumb" }),
  ).toContainText("buzz");
  const addedProject = page.getByTestId("sidebar-project-buzz");
  await expect(addedProject).toBeVisible();
  await addedProject.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove from sidebar" }).click();
  await expect(addedProject).toHaveCount(0);
});

test("restricted repositories keep event work visible and offer access help", async ({
  page,
}) => {
  await page.addInitScript((owner) => {
    window.__BUZZ_E2E_PROJECT_OWNER_OVERRIDE__ = owner;
  }, TEST_IDENTITIES.alice.pubkey);
  await installMockBridge(page, {
    projectAccessChannelId: "11111111-1111-4111-8111-111111111111",
    projectRepoSnapshotError: "remote: repository not found",
  });
  await openBuzzProject(page);

  const unavailableState = page
    .getByTestId("project-repository-unavailable")
    .first();
  await expect(unavailableState).toContainText("Repository access restricted");
  await expect(
    unavailableState.getByTestId("repository-owner-name"),
  ).toHaveText("alice");
  await expect(unavailableState).toContainText(/the repository owner/i);
  await expect(
    unavailableState
      .locator(
        '[data-testid="repository-owner-avatar-image"], [data-testid="repository-owner-avatar-fallback"]',
      )
      .first(),
  ).toBeVisible();
  await expect(page.getByTestId("project-section-header")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Ask for access" }),
  ).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Clone", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("project-repository-file-count")).toHaveText(
    "—",
  );

  await page.getByRole("tab", { name: "Tasks", exact: true }).click();
  await expect(page.getByTestId("project-issue-row").first()).toBeVisible();

  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await expect(
    page.getByTestId("project-pull-request-row").first(),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(page.getByText("Repository access restricted")).toBeVisible();
  await expect(page.getByTestId("project-section-header")).toHaveCount(0);

  await page.getByRole("tab", { name: "Commits", exact: true }).click();
  await expect(page.getByText("Repository access restricted")).toBeVisible();
  await page.getByRole("button", { name: "Ask for access" }).first().click();

  const chatPanel = page.getByTestId("project-agent-chat-panel");
  await expect(chatPanel).toBeVisible();
  await expect(chatPanel.getByTestId("project-agent-context")).toContainText(
    "Commits",
  );
  await expect(chatPanel.getByTestId("message-composer")).toBeVisible();
});

// Walks the Projects v3 workspace through its headline states so PR
// screenshots capture distinct pixels per feature (overview box, tab-strip
// plus, issue detail with inline copy link + avatar timeline, PR detail).
test("projects v3 workspace screenshot states", async ({ page }) => {
  await installMockBridge(page);
  await openBuzzProject(page);
  const initialProjectBreadcrumb = page.getByRole("navigation", {
    name: "Project breadcrumb",
  });
  await expect(
    initialProjectBreadcrumb.getByTestId("project-breadcrumb-project"),
  ).toBeVisible();
  await expect(
    initialProjectBreadcrumb.getByTestId("project-breadcrumb-repository"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open Discussion" }),
  ).toHaveCount(0);

  // Borderless workspace: repository controls live in the persistent,
  // resizable auxiliary panel instead of a header row.
  const overviewTab = page.getByRole("tab", { name: "Overview" });
  const filesTab = page.getByRole("tab", { name: "Files" });
  const channelsTab = page.getByRole("tab", { name: "Channels" });
  const contributorsTab = page.getByRole("tab", { name: "Contributors" });
  const tabMenu = page.getByTestId("project-workspace-tab-menu");
  const workspacePanel = page.getByTestId("project-workspace-panel");
  const projectDetailScroll = page.getByTestId("project-detail-scroll");
  const repositoryActionsPanel = page.getByTestId(
    "project-repository-actions-panel",
  );
  const expectFullWidthSection = async () => {
    const sectionHeader = workspacePanel.getByTestId("project-section-header");
    const [workspaceBox, headerBox, menuBox] = await Promise.all([
      workspacePanel.boundingBox(),
      sectionHeader.boundingBox(),
      tabMenu.boundingBox(),
    ]);
    expect(workspaceBox).not.toBeNull();
    expect(headerBox).not.toBeNull();
    expect(menuBox).not.toBeNull();
    expect(headerBox?.x).toBe(workspaceBox?.x);
    expect(headerBox?.width).toBe(workspaceBox?.width);
    expect(workspaceBox?.x).toBe(menuBox?.x);
    expect((workspaceBox?.x ?? 0) + (workspaceBox?.width ?? 0)).toBe(
      (menuBox?.x ?? 0) + (menuBox?.width ?? 0),
    );
  };
  await expect(filesTab).toBeVisible();
  await expect(projectDetailScroll).toHaveCSS("overscroll-behavior-y", "none");
  await expect(overviewTab).toHaveAttribute("data-state", "active");
  const [projectDetailScrollBounds, initialTabMenuBounds] = await Promise.all([
    projectDetailScroll.boundingBox(),
    tabMenu.boundingBox(),
  ]);
  expect(projectDetailScrollBounds).not.toBeNull();
  expect(initialTabMenuBounds?.y).toBe(projectDetailScrollBounds?.y);
  expect(
    await filesTab.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).borderRadius),
    ),
  ).toBeGreaterThan(13);
  expect((await filesTab.boundingBox())?.height).toBe(28);
  await expect(repositoryActionsPanel).toBeVisible();
  const repositoryPanelTab = page.getByTestId(
    "project-right-panel-repository-tab",
  );
  const chatPanelTab = page.getByTestId("project-right-panel-chat-tab");
  const terminalButton = page.getByTestId("project-terminal-toggle");
  const terminalIcon = page.getByTestId("project-terminal-icon");
  await expect(repositoryPanelTab).toHaveAttribute("aria-pressed", "true");
  await expect(terminalIcon).toBeVisible();
  expect(
    await terminalIcon.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        maskImage: style.maskImage || style.webkitMaskImage,
        parentColor: getComputedStyle(element.parentElement ?? element).color,
      };
    }),
  ).toMatchObject({
    backgroundColor: await terminalButton.evaluate(
      (element) => getComputedStyle(element).color,
    ),
    maskImage: expect.not.stringMatching(/^none$/),
  });
  const [repositoryTabBounds, chatTabBounds] = await Promise.all([
    repositoryPanelTab.boundingBox(),
    chatPanelTab.boundingBox(),
  ]);
  expect(repositoryTabBounds?.width).toBe(chatTabBounds?.width);
  await chatPanelTab.click();
  const agentChatPanel = page.getByTestId("project-agent-chat-panel");
  await expect(agentChatPanel).toBeVisible();
  await expect(agentChatPanel.getByTestId("message-composer")).toBeVisible();
  const agentContext = agentChatPanel.getByTestId("project-agent-context");
  await expect(agentContext).toBeVisible();
  await expect(agentContext).toContainText("Overview");
  await expect(agentContext).not.toContainText("Buzz /");
  const [tabMenuHeaderBounds, agentContextBounds] = await Promise.all([
    tabMenu.boundingBox(),
    agentContext.boundingBox(),
  ]);
  expect(tabMenuHeaderBounds).not.toBeNull();
  expect(agentContextBounds).not.toBeNull();
  expect(tabMenuHeaderBounds?.height).toBe(52);
  expect(
    Math.abs((tabMenuHeaderBounds?.y ?? 0) - (agentContextBounds?.y ?? 0)),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(
      (tabMenuHeaderBounds?.height ?? 0) - (agentContextBounds?.height ?? 0),
    ),
  ).toBeLessThanOrEqual(1);
  const sharedHeaderBackdrop = page.getByTestId(
    "project-shared-header-backdrop",
  );
  await expect(sharedHeaderBackdrop).toBeVisible();
  await expect
    .poll(() =>
      sharedHeaderBackdrop.evaluate(
        (element) => getComputedStyle(element).backdropFilter,
      ),
    )
    .not.toBe("none");
  const sharedHeaderBackdropBounds = await sharedHeaderBackdrop.boundingBox();
  expect(sharedHeaderBackdropBounds).not.toBeNull();
  expect(sharedHeaderBackdropBounds?.x).toBeLessThanOrEqual(
    tabMenuHeaderBounds?.x ?? 0,
  );
  expect(
    (sharedHeaderBackdropBounds?.x ?? 0) +
      (sharedHeaderBackdropBounds?.width ?? 0),
  ).toBeGreaterThanOrEqual(
    (agentContextBounds?.x ?? 0) + (agentContextBounds?.width ?? 0),
  );
  await expect
    .poll(() =>
      agentContext.evaluate((element) => getComputedStyle(element).position),
    )
    .toBe("absolute");
  const agentConversationScroll = agentChatPanel.getByTestId(
    "project-agent-conversation-scroll",
  );
  await expect
    .poll(() =>
      agentConversationScroll.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).paddingTop),
      ),
    )
    .toBeGreaterThanOrEqual(52);
  await agentChatPanel
    .getByTestId("message-input")
    .fill("Summarize this repository.");
  await agentChatPanel.getByTestId("send-message").click();
  const projectAgentMessage = agentChatPanel
    .locator("[data-message-id]")
    .filter({ hasText: "Summarize this repository." });
  await expect(projectAgentMessage).toBeVisible();
  const projectAgentMessageId =
    await projectAgentMessage.getAttribute("data-message-id");
  expect(projectAgentMessageId).not.toBeNull();
  const projectAgentChannelId = await agentChatPanel
    .locator("[data-project-agent-channel-id]")
    .getAttribute("data-project-agent-channel-id");
  expect(projectAgentChannelId).not.toBeNull();
  await page.evaluate(
    async ({ channelId, parentEventId }) => {
      if (!channelId)
        throw new Error("Project agent DM channel was not recorded.");
      await window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__?.("send_channel_message", {
        channelId,
        content: "A persisted threaded agent response.",
        parentEventId: parentEventId ?? undefined,
      });
    },
    { channelId: projectAgentChannelId, parentEventId: projectAgentMessageId },
  );
  await expect(
    agentChatPanel.getByText("A persisted threaded agent response."),
  ).toBeVisible();
  await expect(repositoryActionsPanel).toHaveCount(0);
  await page.getByTestId("project-right-panel-repository-tab").click();
  await expect(repositoryActionsPanel).toBeVisible();
  await expect(
    page.getByTestId("project-repository-selection-row"),
  ).toHaveCount(0);
  await page.getByTestId("project-repository-actions-collapse").click();
  await expect(repositoryActionsPanel).toHaveCount(0);
  const collapsedMainPaneBounds = await workspacePanel.boundingBox();
  const viewportSize = page.viewportSize();
  expect(collapsedMainPaneBounds).not.toBeNull();
  expect(viewportSize).not.toBeNull();
  expect(
    Math.abs(
      (collapsedMainPaneBounds?.x ?? 0) +
        (collapsedMainPaneBounds?.width ?? 0) -
        (viewportSize?.width ?? 0),
    ),
  ).toBeLessThanOrEqual(8);
  const expandRepositoryPanel = page.getByTestId(
    "project-repository-actions-expand",
  );
  const projectBreadcrumb = page.getByRole("navigation", {
    name: "Project breadcrumb",
  });
  const expandBounds = await expandRepositoryPanel.boundingBox();
  const breadcrumbBounds = await projectBreadcrumb.boundingBox();
  expect(expandBounds).not.toBeNull();
  expect(breadcrumbBounds).not.toBeNull();
  expect(
    Math.abs(
      (expandBounds?.y ?? 0) +
        (expandBounds?.height ?? 0) / 2 -
        ((breadcrumbBounds?.y ?? 0) + (breadcrumbBounds?.height ?? 0) / 2),
    ),
  ).toBeLessThanOrEqual(1);
  await expandRepositoryPanel.click();
  await expect(repositoryActionsPanel).toBeVisible();
  await expect(page.getByTestId("project-detail-copy-link")).toBeVisible();
  await expect(
    repositoryActionsPanel.getByTestId("project-detail-copy-link"),
  ).toHaveCount(0);
  await expect(
    workspacePanel.getByTestId("project-workspace-tab-menu"),
  ).toHaveCount(0);
  const overviewBounds = await overviewTab.boundingBox();
  const channelsBounds = await channelsTab.boundingBox();
  const contributorsBounds = await contributorsTab.boundingBox();
  const tabMenuBounds = await tabMenu.boundingBox();
  const workspaceBounds = await workspacePanel.boundingBox();
  const repositoryActionsBounds = await repositoryActionsPanel.boundingBox();
  expect(overviewBounds).not.toBeNull();
  expect(channelsBounds).not.toBeNull();
  expect(contributorsBounds).not.toBeNull();
  expect(tabMenuBounds).not.toBeNull();
  expect(workspaceBounds).not.toBeNull();
  expect(repositoryActionsBounds).not.toBeNull();
  expect(channelsBounds?.x).toBeLessThan(contributorsBounds?.x ?? 0);
  expect(overviewBounds?.x).toBeGreaterThan(workspaceBounds?.x ?? 0);
  expect(tabMenuBounds?.y).toBeLessThan(workspaceBounds?.y ?? 0);
  expect(repositoryActionsBounds?.x).toBeGreaterThan(workspaceBounds?.x ?? 0);
  await expect(
    workspacePanel.getByRole("heading", { name: "README", exact: true }),
  ).toHaveCount(0);
  await expect(
    workspacePanel.getByTestId("project-section-header-icon"),
  ).toHaveCount(0);
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/01-workspace-overview.png` });

  await filesTab.click();
  await expect(repositoryActionsPanel).toBeVisible();
  await expect(
    workspacePanel.getByRole("heading", { name: "Files", exact: true }),
  ).toBeVisible();
  await chatPanelTab.click();
  await expect(agentContext).toContainText("Files");
  await expect(
    agentChatPanel.getByText("A persisted threaded agent response."),
  ).toBeVisible();
  await repositoryPanelTab.click();
  await expect(repositoryActionsPanel).toBeVisible();
  await expectFullWidthSection();
  await page.getByRole("tab", { name: "Commits" }).click();
  await expect(repositoryActionsPanel).toBeVisible();
  await expect(
    workspacePanel.getByRole("heading", { name: "Commits", exact: true }),
  ).toBeVisible();
  await expectFullWidthSection();
  const commitRow = page.getByTestId("project-activity-feed-item").first();
  const commitDate = commitRow.getByTestId("project-commit-row-date");
  const commitHash = commitRow.getByTitle(/^View commit /);
  await expect(commitDate).toBeVisible();
  const commitDateBounds = await commitDate.boundingBox();
  const commitHashBounds = await commitHash.boundingBox();
  expect(commitDateBounds).not.toBeNull();
  expect(commitHashBounds).not.toBeNull();
  expect(commitDateBounds?.x).toBeGreaterThan(commitHashBounds?.x ?? 0);
  await contributorsTab.click();
  await expectFullWidthSection();
  const contributorRow = page.getByTestId("project-contributor-row").first();
  await expect(
    contributorRow.getByTestId("project-contributor-commit-count"),
  ).toBeVisible();
  await expect(
    contributorRow.getByTestId("project-contributor-review-count"),
  ).toBeVisible();
  await expect(
    contributorRow.getByTestId("project-contributor-task-count"),
  ).toBeVisible();
  const contributorBounds = await contributorRow.boundingBox();
  const contributorIdentityBounds = await contributorRow
    .getByTestId("project-contributor-identity")
    .boundingBox();
  const contributorCommitCountBounds = await contributorRow
    .getByTestId("project-contributor-commit-count")
    .boundingBox();
  expect(contributorBounds).not.toBeNull();
  expect(contributorBounds?.height).toBeLessThanOrEqual(40);
  expect(contributorIdentityBounds).not.toBeNull();
  expect(contributorCommitCountBounds?.x).toBeGreaterThan(
    contributorIdentityBounds?.x ?? 0,
  );
  const contributorCommitCounts = await page
    .getByTestId("project-contributor-commit-count")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const value = Number.parseInt(node.textContent?.trim() ?? "", 10);
        return Number.isNaN(value) ? -1 : value;
      }),
    );
  expect(contributorCommitCounts).toEqual(
    [...contributorCommitCounts].sort((left, right) => right - left),
  );

  await channelsTab.click();
  await expect(
    workspacePanel.getByRole("heading", { name: "Channels", exact: true }),
  ).toBeVisible();
  await expectFullWidthSection();

  // Issues tab: the create action lives in the section header.
  await page.getByRole("tab", { name: "Tasks", exact: true }).click();
  await expect(repositoryActionsPanel).toBeVisible();
  await expectFullWidthSection();
  const newIssueButton = workspacePanel.getByRole("button", {
    name: "Create task",
  });
  await expect(newIssueButton).toBeVisible();
  await expect(
    tabMenu.getByRole("button", { name: "Create task" }),
  ).toHaveCount(0);
  const issuesHeading = workspacePanel.getByRole("heading", {
    name: "Tasks",
    exact: true,
  });
  const issuesHeadingBounds = await issuesHeading.boundingBox();
  const newIssueBounds = await newIssueButton.boundingBox();
  expect(issuesHeadingBounds).not.toBeNull();
  expect(newIssueBounds).not.toBeNull();
  expect(newIssueBounds?.x).toBeGreaterThan(issuesHeadingBounds?.x ?? 0);
  const issueRow = page.getByTestId("project-issue-row").first();
  await expect(issueRow).toBeVisible({ timeout: 10_000 });
  const issueDate = issueRow.getByTestId("project-issue-row-date");
  const issueId = issueRow.getByTitle("View task");
  await expect(issueDate).toBeVisible();
  const issueDateBounds = await issueDate.boundingBox();
  const issueIdBounds = await issueId.boundingBox();
  const issueRowBounds = await issueRow.boundingBox();
  expect(issueDateBounds).not.toBeNull();
  expect(issueIdBounds).not.toBeNull();
  expect(issueRowBounds).not.toBeNull();
  expect(issueRowBounds?.height).toBeLessThanOrEqual(40);
  expect(issueDateBounds?.x).toBeGreaterThan(issueIdBounds?.x ?? 0);
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/02-issues-tab.png` });

  // Issue detail: inline copy link after the title, assignees rail, and the
  // avatar comment timeline (seed comments so the timeline renders).
  await issueRow.getByRole("button", { name: /^#/ }).click();
  const composer = page.getByTestId("project-issue-comment-composer");
  await expect(composer).toBeVisible();
  await expect(tabMenu).toHaveCount(0);
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
  const issueActivity = workspacePanel.getByRole("button", {
    name: "Activity",
    exact: true,
  });
  await issueActivity.click();
  await expect(composer).toBeVisible();
  await expect(
    page.getByTestId("project-issue-comment-timeline-row"),
  ).toHaveCount(0);
  await issueActivity.click();
  // Let the "Comment posted." toast dismiss so it doesn't photobomb.
  await expect(page.getByText("Comment posted.")).toHaveCount(0, {
    timeout: 10_000,
  });
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/03-issue-detail.png` });

  // PR list: section header owns creation; detail keeps its entity header.
  await page
    .getByRole("navigation", { name: "Project breadcrumb" })
    .getByRole("button", { name: "Tasks", exact: true })
    .click();
  await expect(tabMenu).toBeVisible();
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await expect(
    workspacePanel.getByRole("heading", {
      name: "Reviews",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    workspacePanel.getByRole("button", { name: "Create review" }),
  ).toBeVisible();
  await expectFullWidthSection();
  await expect(
    tabMenu.getByRole("button", { name: "Create review" }),
  ).toHaveCount(0);
  const prRow = page.getByTestId("project-pull-request-row").first();
  await expect(prRow).toBeVisible({ timeout: 10_000 });
  const prDate = prRow.getByTestId("project-pull-request-row-date");
  const prId = prRow.getByTitle("View review");
  await expect(prDate).toBeVisible();
  const prDateBounds = await prDate.boundingBox();
  const prIdBounds = await prId.boundingBox();
  expect(prDateBounds).not.toBeNull();
  expect(prIdBounds).not.toBeNull();
  expect(prDateBounds?.x).toBeGreaterThan(prIdBounds?.x ?? 0);
  await prRow.getByRole("button", { name: /^#/ }).click();
  await expect(
    page.getByTestId("project-pull-request-copy-link"),
  ).toBeVisible();
  const reviewCommits = workspacePanel.getByRole("button", {
    name: "Commits",
    exact: true,
  });
  await expect(reviewCommits).toHaveAttribute("aria-expanded", "false");
  await expect(reviewCommits).toHaveCSS("font-size", "16px");
  await expect(reviewCommits).toHaveCSS("font-weight", "400");
  await reviewCommits.click();
  const openedReviewCommits = workspacePanel.getByRole("button", {
    name: /^Commits \d+$/,
  });
  await expect(openedReviewCommits).toHaveAttribute("aria-expanded", "true");
  await openedReviewCommits.click();
  const reviewComposer = page.getByTestId(
    "project-pull-request-comment-composer",
  );
  await expect(reviewComposer).toBeVisible();
  const reviewActivity = workspacePanel.getByRole("button", {
    name: "Activity",
    exact: true,
  });
  await reviewActivity.click();
  await expect(reviewComposer).toBeVisible();
  await expect(tabMenu).toHaveCount(0);
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
  const reviewTable = page.getByTestId("projects-list-container");
  await expect(reviewTable.locator("thead")).toHaveClass(/sr-only/);
  const pullRequestRow = page.getByTestId(/^projects-pr-row-/).first();
  await expect(pullRequestRow).toBeVisible();
  await expect(pullRequestRow).toContainText("Review");
  await expect(pullRequestRow).toContainText("opened this in");
  await expect(pullRequestRow).toContainText(/from\s*feature\/mock-2-0/);
  await expect(pullRequestRow).not.toContainText(/#[0-9a-f]{8}/);
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/05-pr-list-metadata.png` });

  await page.getByTestId("projects-section-issues").click();
  const taskTable = page.getByTestId("projects-list-container");
  await expect(taskTable.locator("thead")).toHaveClass(/sr-only/);
  const issueRow = page.getByTestId(/^projects-issue-row-/).first();
  await expect(issueRow).toBeVisible();
  await expect(issueRow).toContainText("Issue");
  await expect(issueRow).toContainText(/opened this in\s*relay-tools/);
  await expect(issueRow).not.toContainText(/#[0-9a-f]{8}/);
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/06-issue-list-metadata.png` });
});
