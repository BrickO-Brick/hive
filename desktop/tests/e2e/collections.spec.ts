import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";
import { FEATURE_OVERRIDES_STORAGE_KEY } from "../helpers/features";

const repositoryCoordinate = `30617:${"a".repeat(64)}:buzz`;
const taskEventId = "b".repeat(64);
const noteCoordinate = `30023:${"c".repeat(64)}:design`;
const calendarUrl =
  "https://calendar.google.com/calendar/event?eid=Y29sbGVjdGlvbi10ZXN0";
const calendarDocumentUrl =
  "https://docs.google.com/document/d/collection-test";
const mockDesignDocumentTitle = "Mock Collections Design Doc";
const failingCalendarUrl =
  "https://calendar.google.com/calendar/event?eid=ZmFpbGluZy10ZXN0";
const githubPullRequestUrl = "https://github.com/block/buzz/pull/4242";
const failingGithubPullRequestUrl = "https://github.com/block/buzz/pull/4343";
const failingThreadRootId = "d".repeat(64);

test.beforeEach(async ({ page }) => {
  await page.addInitScript((storageKey) => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ collections: true }),
    );
  }, FEATURE_OVERRIDES_STORAGE_KEY);
  await installMockBridge(page, {
    collectionCalendarLinksByUrl: {
      [calendarUrl]: [
        {
          url: calendarDocumentUrl,
          label: mockDesignDocumentTitle,
          kind: "document",
        },
      ],
    },
    collectionCalendarActivityByUrl: {
      [calendarUrl]: {
        activities: [
          {
            action_type: "edit",
            timestamp: "2026-08-26T14:30:00Z",
            actor_display_name: "Mock Editor",
            actor_email: "mock-editor@example.com",
            document_title: mockDesignDocumentTitle,
            document_url: calendarDocumentUrl,
            document_file_id: "collection-test",
            source_calendar_url: calendarUrl,
            source_attachment_url: calendarDocumentUrl,
          },
          {
            action_type: "comment",
            timestamp: "2026-08-26T15:45:00Z",
            actor_display_name: "Mock Commenter",
            actor_email: "mock-commenter@example.com",
            document_title: mockDesignDocumentTitle,
            document_url: calendarDocumentUrl,
            document_file_id: "collection-test",
            source_calendar_url: calendarUrl,
            source_attachment_url: calendarDocumentUrl,
          },
        ],
        errors: [
          {
            source_url: calendarDocumentUrl,
            message: "buzz team weekly",
          },
          {
            source_url: calendarDocumentUrl,
            message: "buzz team weekly",
          },
        ],
      },
    },
    collectionCalendarErrorsByUrl: {
      [failingCalendarUrl]: "Calendar account needs attention",
    },
    collectionGithubPullRequestsByUrl: {
      [githubPullRequestUrl]: {
        url: githubPullRequestUrl,
        title: "Live collections activity feed",
        state: "open",
        author: "mock-author",
        author_avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
        updated_at: "2026-08-27T14:00:00Z",
        activity: [
          {
            kind: "review",
            author: "mock-reviewer",
            author_avatar_url: "https://avatars.githubusercontent.com/u/2?v=4",
            state: "approved",
            created_at: "2026-08-27T13:30:00Z",
            url: `${githubPullRequestUrl}#pullrequestreview-1`,
          },
          {
            kind: "comment",
            author: "mock-commenter",
            author_avatar_url: null,
            state: null,
            created_at: "2026-08-27T12:15:00Z",
            url: `${githubPullRequestUrl}#issuecomment-1`,
          },
        ],
      },
    },
    collectionGithubPullRequestErrorsByUrl: {
      [failingGithubPullRequestUrl]: "GitHub account needs attention",
    },
    collectionThreadActivityErrorsByRootId: {
      [failingThreadRootId]: "Thread history is temporarily unavailable",
    },
  });
  await page.goto("/");
});

test("creates a collection and adds supported reference types", async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await expect(page.getByTestId("sidebar-collections-section")).toBeVisible();
  await page.getByTestId("sidebar-collections-section-label").hover();
  await page.getByTestId("sidebar-collections-create").click();

  await page.getByLabel("Collection name").fill("Bird Voice");
  await page.getByLabel("Collection emoji").fill("🐦");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  await expect(page).toHaveURL(/\/collections\/collection-1$/);
  await expect(page.getByRole("heading", { name: "Bird Voice" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "data-state",
    "active",
  );
  await expect(
    page.getByRole("button", { name: "Change Collection icon" }),
  ).toContainText("🐦");
  await page.getByRole("button", { name: "Change Collection icon" }).click();
  await page
    .getByTestId("collection-icon-dialog")
    .getByLabel("Collection emoji")
    .fill("🐝");
  await page
    .getByTestId("collection-icon-dialog")
    .getByRole("button", { name: "Save" })
    .click();
  await expect(
    page.getByRole("button", { name: "Change Collection icon" }),
  ).toContainText("🐝");
  await expect(
    page.getByRole("heading", { name: "Quick navigation" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Briefing" })).toBeVisible();
  await expect(
    page.getByText("No sourced briefing is available yet."),
  ).toBeVisible();
  await expect(
    page.getByText("Add a source to discover collection activity."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Reference label")).toHaveCount(0);
  await page.getByLabel("External URL").fill("https://example.com/brief");
  await page.getByRole("button", { name: "Add external link" }).click();
  await page.getByRole("tab", { name: "Sources" }).click();

  const row = page.getByTestId("collection-member-collection-member-1");
  await expect(row).toContainText("https://example.com/brief");

  await page.getByLabel("Search collection").fill("missing");
  await expect(page.getByText("No items match these filters.")).toBeVisible();
  await page.getByLabel("Search collection").fill("brief");
  await expect(row).toBeVisible();

  await page.getByLabel("Filter by type").selectOption("channel");
  await expect(page.getByText("No items match these filters.")).toBeVisible();
  await page.getByLabel("Filter by type").selectOption("external");
  await expect(row).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await row
    .getByRole("button", { name: "Actions for https://example.com/brief" })
    .click();
  await page.getByRole("menuitem", { name: "Remove from Collection" }).click();
  await expect(
    page.getByText("No sources in this collection yet."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Reference type").selectOption("repository");
  await page.getByLabel("Repository coordinate").fill(repositoryCoordinate);
  await page.getByRole("button", { name: "Add repository" }).click();

  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Reference type").selectOption("task");
  await page.getByLabel("Repository coordinate").fill(repositoryCoordinate);
  await page.getByLabel("Task event ID").fill(taskEventId);
  await page.getByRole("button", { name: "Add repository task" }).click();

  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Reference type").selectOption("note");
  await page.getByLabel("Note coordinate").fill(noteCoordinate);
  await page.getByRole("button", { name: "Add note" }).click();

  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Reference type").selectOption("external");
  await page.getByLabel("External URL").fill(calendarUrl);
  await page.getByRole("button", { name: "Add external link" }).click();

  await page.getByTestId("channel-general").click();
  await page.evaluate((url) => {
    window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName: "general",
      content: `Please review ${url}?tab=checks and ${url}/files.`,
    });
  }, githubPullRequestUrl);
  await page.evaluate(
    ({ failingUrl }) => {
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content: `Thread status for Bird Voice: ${failingUrl}`,
        parentEventId: "mock-general-welcome",
        extraTags: [
          ["e", "mock-general-welcome", "", "root"],
          ["e", "mock-general-welcome", "", "reply"],
        ],
      });
    },
    { failingUrl: failingGithubPullRequestUrl },
  );
  await page.evaluate(() => {
    window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName: "general",
      content: "Unrelated channel update",
    });
  });
  await page.getByRole("button", { name: "Add to collection" }).click();
  await page
    .getByTestId("add-to-collection-dialog")
    .getByRole("button", { name: "Bird Voice" })
    .click();
  await expect(
    page.getByRole("button", { name: "Open Collection Bird Voice" }),
  ).toBeVisible();

  const messageRow = page.getByTestId("message-row").first();
  await messageRow.hover();
  await messageRow.locator('[data-testid^="more-actions-"]').click();
  await page.getByText("Add thread to Collection", { exact: true }).click();
  await page
    .getByTestId("add-to-collection-dialog")
    .getByRole("button", { name: "Bird Voice" })
    .click();

  await page.getByTestId("sidebar-collection-collection-1").click();
  await expect(
    page.getByText(/6 sources · \d+ discovered items/),
  ).toBeVisible();
  await page.getByRole("button", { name: "6 sources" }).click();
  await expect(page.getByRole("tab", { name: "Sources" })).toHaveAttribute(
    "data-state",
    "active",
  );
  await page.getByRole("tab", { name: "Overview" }).click();
  await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
  const peopleSection = page.getByTestId("collection-people");
  const firstPerson = peopleSection.locator("button[aria-pressed]").first();
  await firstPerson.click();
  await expect(firstPerson).toHaveAttribute("aria-pressed", "true");
  await peopleSection.getByRole("button", { name: "Clear" }).click();
  await expect(firstPerson).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByTestId("collection-quick-navigation").getByRole("button", {
      name: "Thread: Welcome to #general",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Sources" }).click();
  const sources = page.getByTestId("collection-sources");
  await expect(
    sources.getByRole("heading", { name: "Channels" }),
  ).toBeVisible();
  await expect(sources.getByRole("heading", { name: "Code" })).toBeVisible();
  await expect(
    sources.getByRole("heading", { name: "Conversations" }),
  ).toBeVisible();
  await expect(
    sources.getByRole("heading", { name: "External" }),
  ).toBeVisible();
  await expect(sources.getByLabel("channel source")).toBeVisible();
  await expect(
    sources.getByRole("button", { name: "Actions for general" }),
  ).toBeVisible();
  await expect(sources.getByLabel("repository source")).toBeVisible();
  const sourceDetails = sources.getByText("Details").first();
  await sourceDetails.click();
  await expect(sourceDetails.locator("..")).toContainText("9a1657ac");
  await page.getByRole("tab", { name: "Overview" }).click();

  const pullRequest = page.getByTestId(
    `collection-derived-${encodeURIComponent(githubPullRequestUrl)}`,
  );
  await expect(pullRequest).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Pull requests" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("collection-activity")).not.toContainText(
    "Thread status for Bird Voice",
  );
  await expect(page.getByTestId("collection-activity")).not.toContainText(
    "Please review",
  );
  await expect(page.getByTestId("collection-activity")).toContainText(
    "Unrelated channel update",
  );
  await expect(pullRequest.getByLabel(/^Derived from /)).toBeVisible();
  await expect(pullRequest).toContainText("Live collections activity feed");
  await expect(pullRequest).toContainText("open by mock-author");
  await expect(pullRequest).toContainText("1 review · 1 comment");
  await expect(pullRequest).toContainText(
    "Latest: mock-reviewer review · approved",
  );
  await expect(pullRequest).toContainText("mentioned PR");
  await expect(pullRequest.getByAltText("mock-author avatar")).toBeVisible();
  await pullRequest
    .getByRole("button", { name: "Actions for Live collections activity feed" })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Remove source from Collection" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  const calendarMeeting = page.getByTestId(
    `collection-derived-${encodeURIComponent(calendarUrl)}`,
  );
  await expect(calendarMeeting.getByLabel(/^Derived from /)).toBeVisible();
  await expect(calendarMeeting).toContainText(calendarUrl);
  await expect(calendarMeeting).toContainText(mockDesignDocumentTitle);
  await expect(calendarMeeting).toContainText("1 edit · 1 comment");
  await calendarMeeting
    .getByRole("button", { name: `Actions for ${calendarUrl}` })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Remove source from Collection" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-testid^="collection-calendar-warning-"]'),
  ).toHaveCount(1);
  await expect(
    page.getByText("mock-reviewer review · approved", { exact: false }),
  ).toBeVisible();
  const failedPullRequest = page.getByTestId(
    `collection-derived-${encodeURIComponent(failingGithubPullRequestUrl)}`,
  );
  await expect(failedPullRequest).toContainText("Mentioned PR");
  await expect(
    page.locator('[data-testid^="collection-github-pr-warning-"]'),
  ).toContainText("GitHub PR resolution failed");

  await calendarMeeting
    .getByRole("button", { name: mockDesignDocumentTitle })
    .click();
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByLabel("Filter activity by type")).toHaveValue("all");
  await page
    .getByLabel("Filter activity by type")
    .selectOption("pull-requests");
  await expect(pullRequest).toHaveCount(1);
  await expect(page.getByTestId("collection-activity")).not.toContainText(
    "Unrelated channel update",
  );
  await expect(calendarMeeting).toHaveCount(0);
  await page.getByLabel("Filter activity by type").selectOption("messages");
  await expect(page.getByTestId("collection-activity")).toContainText(
    "Unrelated channel update",
  );
  await expect(pullRequest).toHaveCount(0);
  await page.getByLabel("Filter activity by type").selectOption("meetings");
  await expect(calendarMeeting).toHaveCount(1);
  await expect(calendarMeeting).toContainText("1 edit · 1 comment");
  await expect(calendarMeeting).toContainText("Aug 26, 2026");
  await page.getByRole("tab", { name: "Overview" }).click();
  const mockEditor = peopleSection.getByRole("button", {
    name: /Mock Editor/,
  });
  await expect(mockEditor).toBeVisible();
  await mockEditor.click();
  await expect(mockEditor).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(calendarMeeting).toBeVisible();
  await expect(calendarMeeting).toContainText(mockDesignDocumentTitle);
  await page.getByRole("tab", { name: "Overview" }).click();
  await expect(
    page.getByRole("heading", { name: "Pull requests" }),
  ).toHaveCount(0);
  await mockEditor.click();
  await expect(mockEditor).toHaveAttribute("aria-pressed", "false");
  await expect(calendarMeeting).toContainText(calendarUrl);
  const commands = await page.evaluate(
    () => window.__BUZZ_E2E_COMMAND_PAYLOADS__ ?? [],
  );
  expect(commands).toContainEqual({
    command: "discover_collection_calendar_links",
    payload: { url: calendarUrl },
  });
  expect(
    commands.some(
      ({ command, payload }) =>
        command === "discover_collection_calendar_activity" &&
        payload.calendarUrl === calendarUrl &&
        typeof payload.startTime === "string" &&
        payload.endTime === null,
    ),
  ).toBe(true);
  expect(
    pageErrors.filter((error) =>
      /hooks conditionally|should have a queue/iu.test(error.message),
    ),
  ).toEqual([]);
  expect(
    commands.some(
      ({ command, payload }) =>
        command === "set_collection_icon" &&
        payload.input?.collection_id === "collection-1" &&
        payload.input?.icon === "🐝",
    ),
  ).toBe(true);
  expect(commands).toContainEqual({
    command: "plugin:opener|open_url",
    payload: { url: calendarDocumentUrl },
  });
  expect(commands).toContainEqual({
    command: "resolve_collection_github_pull_request",
    payload: { url: githubPullRequestUrl },
  });
  expect(commands).toContainEqual({
    command: "resolve_collection_github_pull_request",
    payload: { url: failingGithubPullRequestUrl },
  });
  expect(commands).toContainEqual({
    command: "get_channel_window",
    payload: {
      channelId: "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50",
      cursor: null,
      limitRows: 200,
    },
  });
  expect(
    commands.some(
      ({ command, payload }) =>
        command === "add_collection_member" &&
        JSON.stringify(payload).includes(calendarDocumentUrl),
    ),
  ).toBe(false);
  expect(
    commands.some(
      ({ command, payload }) =>
        command === "add_collection_member" &&
        (JSON.stringify(payload).includes(githubPullRequestUrl) ||
          JSON.stringify(payload).includes(failingGithubPullRequestUrl)),
    ),
  ).toBe(false);

  const quickNavigation = page.getByTestId("collection-quick-navigation");
  page.once("dialog", (dialog) => dialog.dismiss());
  await quickNavigation
    .getByRole("button", { name: `Actions for ${repositoryCoordinate}` })
    .click();
  await page.getByRole("menuitem", { name: "Remove from Collection" }).click();
  await expect(quickNavigation.getByText(repositoryCoordinate)).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await quickNavigation
    .getByRole("button", { name: `Actions for ${repositoryCoordinate}` })
    .click();
  await page.getByRole("menuitem", { name: "Remove from Collection" }).click();
  await expect(quickNavigation.getByText(repositoryCoordinate)).toHaveCount(0);

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("Related discovered activity");
    return dialog.accept();
  });
  await calendarMeeting
    .getByRole("button", { name: `Actions for ${calendarUrl}` })
    .click();
  await page
    .getByRole("menuitem", { name: "Remove source from Collection" })
    .click();
  await expect(calendarMeeting).toHaveCount(0);

  const removalCommands = await page.evaluate(
    () => window.__BUZZ_E2E_COMMAND_PAYLOADS__ ?? [],
  );
  expect(
    removalCommands.some(
      ({ command, payload }) =>
        command === "remove_collection_member" &&
        payload.collectionId === "collection-1" &&
        payload.memberId === "collection-member-2",
    ),
  ).toBe(true);
  expect(
    removalCommands.some(
      ({ command, payload }) =>
        command === "remove_collection_member" &&
        payload.collectionId === "collection-1" &&
        payload.memberId === "collection-member-5",
    ),
  ).toBe(true);
});

test("surfaces Collection source removal errors", async ({ page }) => {
  await installMockBridge(page, {
    collectionRemoveMemberErrorsById: {
      "collection-member-1": "Source is temporarily locked",
    },
    collectionSetNameErrorsById: {
      "collection-1": "Collection name is temporarily locked",
    },
  });
  await page.reload();

  await page.getByTestId("sidebar-collections-section-label").hover();
  await page.getByTestId("sidebar-collections-create").click();
  await page.getByLabel("Collection name").fill("Removal health");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("External URL").fill("https://example.com/locked");
  await page.getByRole("button", { name: "Add external link" }).click();
  await page.getByRole("tab", { name: "Sources" }).click();

  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", {
      name: "Actions for https://example.com/locked",
    })
    .last()
    .click();
  await page.getByRole("menuitem", { name: "Remove from Collection" }).click();
  await expect(page.getByText("Source is temporarily locked")).toBeVisible();
  await expect(
    page.getByText("https://example.com/locked").first(),
  ).toBeVisible();

  const sidebarItem = page.getByTestId("sidebar-collection-collection-1");
  await sidebarItem.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page
    .getByTestId("rename-collection-dialog")
    .getByLabel("Collection name")
    .fill("Should fail");
  await page
    .getByTestId("rename-collection-dialog")
    .getByRole("button", { name: "Save" })
    .click();
  await expect(
    page.getByText("Collection name is temporarily locked"),
  ).toBeVisible();
});

test("renames and changes a Collection icon from the sidebar menu", async ({
  page,
}) => {
  await page.getByTestId("sidebar-collections-section-label").hover();
  await page.getByTestId("sidebar-collections-create").click();
  await page.getByLabel("Collection name").fill("Sidebar identity");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  let sidebarItem = page.getByTestId("sidebar-collection-collection-1");
  await sidebarItem.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page
    .getByTestId("rename-collection-dialog")
    .getByLabel("Collection name")
    .fill("Cancelled name");
  await page.keyboard.press("Escape");
  await expect(sidebarItem).toContainText("Sidebar identity");

  await sidebarItem.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page
    .getByTestId("rename-collection-dialog")
    .getByLabel("Collection name")
    .fill("Renamed collection");
  await page
    .getByTestId("rename-collection-dialog")
    .getByRole("button", { name: "Save" })
    .click();
  sidebarItem = page.getByTestId("sidebar-collection-collection-1");
  await expect(sidebarItem).toContainText("Renamed collection");

  await sidebarItem.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Change icon" }).click();
  await page
    .getByTestId("collection-icon-dialog")
    .getByLabel("Collection emoji")
    .fill("🧭");
  await page
    .getByTestId("collection-icon-dialog")
    .getByRole("button", { name: "Save" })
    .click();
  await expect(sidebarItem).toContainText("🧭");
});

test("shows exact message and thread Collection memberships", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  await page.getByTestId("sidebar-collections-section-label").hover();
  await page.getByTestId("sidebar-collections-create").click();
  await page.getByLabel("Collection name").fill("Alpha work");
  await page.getByLabel("Collection emoji").fill("🅰️");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  await page.getByTestId("channel-general").click();
  let rootRow = page.locator('[data-message-id="mock-general-welcome"]');
  await rootRow.hover();
  await rootRow.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByText("Add message to Collection", { exact: true }),
  ).toHaveCount(0);
  await page.getByText("Add thread to Collection", { exact: true }).click();
  await page
    .getByTestId("add-to-collection-dialog")
    .getByRole("button", { name: "Alpha work" })
    .click();
  await expect(
    rootRow.getByRole("button", { name: "Open Collection Alpha work" }),
  ).toBeVisible();

  await page.getByTestId("sidebar-collections-section-label").hover();
  await page.getByTestId("sidebar-collections-create").click();
  await page.getByLabel("Collection name").fill("Beta work");
  await page.getByLabel("Collection emoji").fill("🅱️");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  await page.getByTestId("channel-general").click();
  rootRow = page.locator('[data-message-id="mock-general-welcome"]');
  await rootRow.hover();
  await rootRow.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByText("Add message to Collection", { exact: true }),
  ).toHaveCount(0);
  await page.getByText("Add thread to Collection", { exact: true }).click();
  await page
    .getByTestId("add-to-collection-dialog")
    .getByRole("button", { name: "Beta work" })
    .click();
  await expect(
    rootRow.getByRole("button", { name: "Open Collection Alpha work" }),
  ).toBeVisible();
  await expect(
    rootRow.getByRole("button", { name: "Open Collection Beta work" }),
  ).toBeVisible();

  await rootRow
    .getByRole("button", { name: "Open Collection Beta work" })
    .click();
  await expect(page).toHaveURL(/\/collections\/collection-2$/);
  await page.getByTestId("channel-general").click();
  await page.evaluate(() => {
    window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName: "general",
      content: "Collection membership reply",
      parentEventId: "mock-general-welcome",
    });
  });
  await page.getByTestId("message-thread-summary").first().click();

  let replyRow = page
    .getByTestId("message-thread-panel")
    .getByTestId("message-row")
    .filter({ hasText: "Collection membership reply" });
  await expect(replyRow).toBeVisible();
  await replyRow.hover();
  await replyRow.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByText("Add thread to Collection", { exact: true }),
  ).toHaveCount(0);
  await page.getByText("Add message to Collection", { exact: true }).click();
  await page
    .getByTestId("add-to-collection-dialog")
    .getByRole("button", { name: "Alpha work" })
    .click();
  await expect(
    replyRow.getByRole("button", { name: "Open Collection Alpha work" }),
  ).toBeVisible();
  await expect(
    replyRow.getByRole("button", { name: "Open Collection Beta work" }),
  ).toHaveCount(0);

  await replyRow
    .getByRole("button", { name: "Open Collection Alpha work" })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/collections\/collection-1$/);
  await page.getByTestId("channel-general").click();
  rootRow = page.locator('[data-message-id="mock-general-welcome"]');
  await page.getByTestId("message-thread-summary").first().click();
  replyRow = page
    .getByTestId("message-thread-panel")
    .getByTestId("message-row")
    .filter({ hasText: "Collection membership reply" });
  await replyRow.hover();
  await replyRow.getByRole("button", { name: "More actions" }).click();
  await page.getByText("Add message to Collection", { exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByTestId("add-to-collection-dialog")
    .getByRole("button", { name: "Alpha work" })
    .click();
  await expect(
    replyRow.getByRole("button", { name: "Open Collection Alpha work" }),
  ).toHaveCount(0);

  expect(
    pageErrors.filter((error) =>
      /hooks conditionally|should have a queue/iu.test(error.message),
    ),
  ).toEqual([]);
});

test("scopes Calendar discovery warnings to their source", async ({ page }) => {
  await page.getByTestId("sidebar-collections-section-label").hover();
  await page.getByTestId("sidebar-collections-create").click();
  await page.getByLabel("Collection name").fill("Calendar watch");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("External URL").fill(failingCalendarUrl);
  await page.getByRole("button", { name: "Add external link" }).click();

  const warning = page.locator('[data-testid^="collection-calendar-warning-"]');
  await expect(warning).toContainText(
    `Calendar discovery failed for ${failingCalendarUrl}: Calendar account needs attention`,
  );
  await expect(
    page.getByText("No recent activity was found across linked sources."),
  ).toBeVisible();
});

test("distinguishes explicit source failures from no activity", async ({
  page,
}) => {
  await page.getByTestId("sidebar-collections-section-label").hover();
  await page.getByTestId("sidebar-collections-create").click();
  await page.getByLabel("Collection name").fill("Source health");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  await page.getByTestId("channel-general").click();
  await page.evaluate((id) => {
    window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName: "general",
      content: "Broken activity source",
      id,
    });
  }, failingThreadRootId);
  const row = page
    .getByTestId("message-row")
    .filter({ hasText: "Broken activity source" });
  await row.hover();
  await row.locator('[data-testid^="more-actions-"]').click();
  await page.getByText("Add thread to Collection", { exact: true }).click();
  await page
    .getByTestId("add-to-collection-dialog")
    .getByRole("button", { name: "Source health" })
    .click();

  await page.getByTestId("sidebar-collection-collection-1").click();
  const warning = page.locator('[data-testid^="collection-source-warning-"]');
  await expect(warning).toContainText("Source activity failed for Thread:");
  await expect(warning).toContainText(
    "Thread history is temporarily unavailable",
  );
  await expect(
    page.getByText("No recent activity was found across linked sources."),
  ).toBeVisible();
});
