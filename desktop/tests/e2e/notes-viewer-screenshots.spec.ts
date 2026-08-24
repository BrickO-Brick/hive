/**
 * Deterministic mockups for the relay-hosted NIP-23 Notes viewer.
 *
 * Run: pnpm build:e2e && pnpm exec playwright test --project=smoke \
 *        tests/e2e/notes-viewer-screenshots.spec.ts
 */
import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const SHOTS = "test-results/notes-viewer";
const CURRENT_PUBKEY = "deadbeef".repeat(8);
const TYLER_PUBKEY = CURRENT_PUBKEY;

const LONG_FORM_NOTES = [
  {
    coordinate: `30023:${TEST_IDENTITIES.alice.pubkey}:relay-native-workspaces`,
    id: "a1".repeat(32),
    pubkey: TEST_IDENTITIES.alice.pubkey,
    slug: "relay-native-workspaces",
    title: "The relay is the workspace",
    summary:
      "A practical architecture for keeping conversation, code, agents, and durable knowledge in one event log.",
    topics: ["buzz", "architecture"],
    published_at: 1_787_484_600,
    updated_at: 1_787_574_600,
    created_at: 1_787_574_600,
    content: `## One workspace, one protocol

Buzz works best when **conversation and artifacts share the same identity and access model**. A note is not a detached document in another SaaS silo. It is a signed, relay-hosted event that can travel with the community.

### What this unlocks

- Durable project decisions beside the work
- Human and agent authors on equal footing
- Portable content with verifiable provenance

> The useful boundary is the community, not the app window.

## Start narrow

The first version should make existing long-form notes pleasant to read. Editing, deletion, and reactions can follow after the read path earns trust.`,
  },
  {
    coordinate: `30023:${TYLER_PUBKEY}:incident-review`,
    id: "b2".repeat(32),
    pubkey: TYLER_PUBKEY,
    slug: "incident-review",
    title: "Incident review: reconnect storm",
    summary:
      "What failed, how the relay recovered, and the guardrails we are adding before the next deployment.",
    topics: ["incident", "relay"],
    published_at: 1_787_398_200,
    updated_at: null,
    created_at: 1_787_398_200,
    content: `## Summary

A reconnect loop amplified a short relay interruption. No signed events were lost, but clients performed unnecessary subscription rebuilds.

## Follow-ups

1. Add jitter to reconnect backoff.
2. Preserve subscription intent across transport replacement.
3. Alert on reconnect fan-out before saturation.`,
  },
  {
    coordinate: `30023:${TEST_IDENTITIES.bob.pubkey}:agent-handoff`,
    id: "c3".repeat(32),
    pubkey: TEST_IDENTITIES.bob.pubkey,
    slug: "agent-handoff",
    title: "Designing agent handoffs that survive restarts",
    summary:
      "A compact contract for durable delegated work without turning every channel into a status feed.",
    topics: ["agents", "collaboration"],
    published_at: 1_787_052_600,
    updated_at: 1_787_139_000,
    created_at: 1_787_139_000,
    content: `## The handoff contract

A useful handoff records the original task, completed work, key decisions, remaining risks, and the next concrete action.

The goal is continuity, not ceremony.`,
  },
  {
    coordinate: `30023:${TEST_IDENTITIES.alice.pubkey}:desktop-release-checklist`,
    id: "d4".repeat(32),
    pubkey: TEST_IDENTITIES.alice.pubkey,
    slug: "desktop-release-checklist",
    title: "Desktop release checklist",
    summary: null,
    topics: ["desktop", "release"],
    published_at: 1_786_707_000,
    updated_at: null,
    created_at: 1_786_707_000,
    content: `## Before tagging

- Verify upgrade and rollback paths
- Exercise onboarding with a clean identity
- Confirm release notes match the shipped artifact`,
  },
];

async function openNotes(page: import("@playwright/test").Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const notesButton = page.getByTestId("open-notes-view");
  if ((await notesButton.count()) === 0) {
    await page.locator('[data-sidebar="trigger"]').click();
  }
  await notesButton.waitFor({ state: "attached" });
  await notesButton.evaluate((button) => button.click());
  await expect(page.getByTestId("notes-view")).toBeVisible();
  const mobileSidebar = page.locator('[data-mobile="true"][data-state="open"]');
  if ((await mobileSidebar.count()) > 0) {
    await page.keyboard.press("Escape");
    await expect(mobileSidebar).toHaveCount(0);
  }
}

test.describe("Notes viewer mockups", () => {
  test("desktop master/detail", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("buzz-theme", "light"));
    await installMockBridge(page, { longFormNotes: LONG_FORM_NOTES });
    await openNotes(page);
    await expect(page.getByTestId("note-detail")).toContainText(
      "The relay is the workspace",
    );
    await page.locator('[data-sidebar="trigger"]').click();
    await expect(page.getByTestId("open-notes-view")).toBeVisible();
    await expect(page.getByTestId("open-notes-view")).toContainText("Notes");
    await waitForAnimations(page);
    await page.screenshot({
      path: `${SHOTS}/01-desktop-sidebar-and-master-detail.png`,
      fullPage: true,
    });
  });

  test("mobile list and detail", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("buzz-theme", "light"));
    await installMockBridge(page, { longFormNotes: LONG_FORM_NOTES });
    await openNotes(page);

    await expect(page.getByTestId("notes-list")).toBeVisible();
    await expect(page.getByTestId("note-detail")).toHaveCount(0);
    await waitForAnimations(page);
    await page.screenshot({
      path: `${SHOTS}/02-mobile-list.png`,
      fullPage: true,
    });

    await page
      .getByTestId(
        `note-row-${TEST_IDENTITIES.alice.pubkey}-relay-native-workspaces`,
      )
      .click();
    await expect(page.getByTestId("note-detail")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Back to notes" }),
    ).toBeVisible();
    await waitForAnimations(page);
    await page.screenshot({
      path: `${SHOTS}/03-mobile-detail.png`,
      fullPage: true,
    });

    await page.getByRole("button", { name: "Back to notes" }).click();
    await expect(
      page.getByTestId(
        `note-row-${TEST_IDENTITIES.alice.pubkey}-relay-native-workspaces`,
      ),
    ).toBeFocused();
  });

  test("owner edit, conflict, and deletion mockups", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("buzz-theme", "light"));
    await installMockBridge(page, { longFormNotes: LONG_FORM_NOTES });
    await openNotes(page);
    await page
      .getByTestId(`note-row-${CURRENT_PUBKEY}-incident-review`)
      .click();
    await expect(page.getByTestId("note-owner-actions")).toBeVisible();

    await page.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByTestId("note-editor-mockup")).toBeVisible();
    await waitForAnimations(page);
    await page.screenshot({
      path: `${SHOTS}/04-owner-edit.png`,
      fullPage: true,
    });

    await page.getByTestId("mock-publish-note").click();
    await expect(
      page.getByText("A newer version replaced this note"),
    ).toBeVisible();
    await waitForAnimations(page);
    await page.screenshot({
      path: `${SHOTS}/05-stale-edit-conflict.png`,
      fullPage: true,
    });

    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Delete note" }).click();
    await expect(page.getByTestId("delete-note-mockup")).toBeVisible();
    await waitForAnimations(page);
    await page.screenshot({
      path: `${SHOTS}/06-delete-request.png`,
      fullPage: true,
    });
  });

  test("empty and unavailable states", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("buzz-theme", "light"));
    await installMockBridge(page, { longFormNotes: [] });
    await openNotes(page);
    await expect(page.getByText("No notes yet")).toHaveCount(2);
    await waitForAnimations(page);
    await page.screenshot({ path: `${SHOTS}/07-empty.png`, fullPage: true });
  });
});
