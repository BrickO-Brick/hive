import type { TiptapEditorHTMLElement } from "@tiptap/core";
import { expect, type Locator, type Page } from "@playwright/test";

import { installMockBridge } from "./bridge";

export const CHANNEL_ID = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
export const RANDOM_CHANNEL_ID = "9dae0116-799b-5071-a0a8-fdd30a91a35d";
export const AGENT_A = "a".repeat(64);
export const AGENT_B = "b".repeat(64);
export const THREAD_ROOT_ID = "mock-general-welcome";
export const KEEP_MENTIONED_AGENTS_PINNED_STORAGE_KEY =
  "buzz.messages.keepMentionedAgentsPinned";

export async function keepMentionedAgentsPinned(page: Page) {
  await page.addInitScript((storageKey) => {
    window.localStorage.setItem(storageKey, "true");
  }, KEEP_MENTIONED_AGENTS_PINNED_STORAGE_KEY);
}

export async function seedTheme(page: Page, theme: string, accent = "#c0a2f1") {
  await page.addInitScript(
    ({ selectedTheme, selectedAccent }) => {
      window.localStorage.setItem("buzz-theme", selectedTheme);
      window.localStorage.setItem("buzz-accent-color", selectedAccent);
    },
    { selectedTheme: theme, selectedAccent: accent },
  );
}

export async function automaticallyMention(
  composer: ReturnType<typeof channelComposer>,
  displayName: string,
) {
  await composer.locator("[data-mention-picker-trigger]").click();
  await composer
    .getByTestId("mention-autocomplete")
    .getByRole("button", { name: `Automatically mention ${displayName}` })
    .click();
  await expect(composer.getByTestId("message-input")).toContainText(
    `@${displayName}`,
  );
  await composer.locator("[data-mention-picker-trigger]").click();
}

export async function openGeneral(page: Page) {
  await page.goto(`/#/channels/${CHANNEL_ID}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("chat-title")).toHaveText("general");
}

export async function openThread(page: Page, threadRootId = THREAD_ROOT_ID) {
  await page.goto(
    `/#/channels/${CHANNEL_ID}?messageId=${threadRootId}&thread=${threadRootId}`,
    { waitUntil: "domcontentloaded" },
  );
  await expect(page.getByTestId("message-thread-panel")).toBeVisible();
}

export function channelComposer(page: Page) {
  return page.getByTestId("channel-composer-overlay");
}

export function threadComposer(page: Page) {
  return page.getByTestId("thread-composer-overlay");
}

export async function readComposerCaret(input: Locator) {
  return input.evaluate((element) => {
    const selection = window.getSelection();
    if (!selection?.anchorNode || !element.contains(selection.anchorNode)) {
      return null;
    }
    const range = document.createRange();
    range.selectNodeContents(element);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
    return range.toString().length;
  });
}

/** Assert selection without moving it, so autocomplete regressions stay visible. */
export async function expectComposerCaretAtEnd(input: Locator) {
  const readSelection = () =>
    input.evaluate((element) => {
      const editor = (element as TiptapEditorHTMLElement).editor;
      const selection = window.getSelection();
      if (!editor || !selection?.anchorNode || !selection.focusNode)
        return null;
      const range = document.createRange();
      range.selectNodeContents(element);
      range.setEnd(selection.anchorNode, selection.anchorOffset);
      return {
        focused: document.activeElement === element,
        collapsed: selection.isCollapsed && editor.state.selection.empty,
        atEnd: range.toString().length === element.textContent?.length,
        agreesWithEditor:
          editor.view.posAtDOM(selection.anchorNode, selection.anchorOffset) ===
            editor.state.selection.anchor &&
          editor.view.posAtDOM(selection.focusNode, selection.focusOffset) ===
            editor.state.selection.head,
      };
    });
  const expected = {
    focused: true,
    collapsed: true,
    atEnd: true,
    agreesWithEditor: true,
  };
  await expect.poll(readSelection).toEqual(expected);
  await input.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  expect(await readSelection()).toEqual(expected);
}

/** Explicit append setup after an edit that intentionally moves the caret. */
export async function focusComposerEnd(input: Locator) {
  await input.evaluate((element) => {
    const editor = (element as TiptapEditorHTMLElement).editor;
    if (!editor || editor.isDestroyed) throw new Error("Composer not mounted");
    editor.commands.focus("end", { scrollIntoView: false });
  });
  await expectComposerCaretAtEnd(input);
}

export async function pressPrimaryShiftM(page: Page) {
  const isMac = await page.evaluate(() =>
    /mac|iphone|ipad|ipod/i.test(navigator.platform),
  );
  await page.keyboard.press(`${isMac ? "Meta" : "Control"}+Shift+M`);
}

export async function readOutgoingMentionPubkeys(page: Page, content: string) {
  return page.evaluate((expectedContent) => {
    const signedEvent = window.__BUZZ_E2E_SIGNED_EVENTS__?.find(
      (event) => event.content === expectedContent,
    );
    if (signedEvent) {
      return (signedEvent.tags ?? [])
        .filter((tag) => tag[0] === "p" && tag[1])
        .map((tag) => tag[1]);
    }

    for (const entry of window.__BUZZ_E2E_COMMAND_LOG__ ?? []) {
      if (entry.command === "send_channel_message") {
        const payload = entry.payload as
          | { content?: string; mentionPubkeys?: string[] }
          | undefined;
        if (payload?.content === expectedContent) {
          return payload.mentionPubkeys ?? [];
        }
      }

      if (entry.command !== "plugin:websocket|send") continue;
      const data = (
        entry.payload as { message?: { data?: string } } | undefined
      )?.message?.data;
      if (!data) continue;

      try {
        const frame = JSON.parse(data) as [
          string,
          { content?: string; tags?: string[][] },
        ];
        if (frame[0] !== "EVENT" || frame[1]?.content !== expectedContent) {
          continue;
        }
        return (frame[1].tags ?? [])
          .filter((tag) => tag[0] === "p" && tag[1])
          .map((tag) => tag[1]);
      } catch {}
    }

    return null;
  }, content);
}

export async function readPersistedDraft(page: Page) {
  return page.evaluate((channelId) => {
    for (const storageKey of Object.keys(window.localStorage)) {
      if (!storageKey.startsWith("buzz-drafts.v2:")) continue;
      const drafts = JSON.parse(
        window.localStorage.getItem(storageKey) ?? "{}",
      ) as Record<string, { content?: string }>;
      if (drafts[channelId]) return drafts[channelId].content ?? "";
    }
    return "";
  }, CHANNEL_ID);
}

export async function addMention(
  composer: Locator,
  name: string,
  mode: "toolbar" | "typed",
) {
  const input = composer.getByTestId("message-input");
  if (mode === "toolbar") {
    await composer.getByTestId("message-insert-mention").click();
    await composer
      .getByRole("button", { name: `Mention ${name}`, exact: true })
      .click();
  } else {
    await input.pressSequentially(`@${name.slice(0, 3)}`);
    await expect(composer.getByTestId("mention-autocomplete")).toBeVisible();
    await input.press("Tab");
  }
  await expect(composer.getByTestId("mention-autocomplete")).toHaveCount(0);
  // Do not press End: on macOS it cancels chip-edge settlement without
  // moving the caret. Verify the natural autocomplete selection instead.
  await expectComposerCaretAtEnd(input);
}

export async function emitMockMessage(
  page: Page,
  content: string,
  mentionPubkeys: string[],
) {
  await page.evaluate(
    ({ body, mentions }) => {
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content: body,
        mentionPubkeys: mentions,
      });
    },
    { body: content, mentions: mentionPubkeys },
  );
}

export async function installAudienceFixtures(
  page: Page,
  options: {
    agentAName?: string;
    additionalAgents?: Array<{ pubkey: string; name: string }>;
    deferredComposerUploads?: boolean;
    sendMessageDelayMs?: number;
    sendMessageErrors?: string[];
    uploadDelayMs?: number;
    uploadDescriptors?: Array<{
      filename: string;
      sha256: string;
      size: number;
      type: string;
      uploaded: number;
      url: string;
    }>;
    usersBatchDelayMs?: number;
  } = {},
) {
  const {
    agentAName = "Morgarita",
    additionalAgents = [],
    ...bridgeOptions
  } = options;
  await installMockBridge(page, {
    ...bridgeOptions,
    managedAgents: [
      {
        pubkey: AGENT_A,
        name: agentAName,
        status: "running",
        channelNames: ["general"],
      },
      {
        pubkey: AGENT_B,
        name: "Vogue",
        status: "running",
        channelNames: ["general"],
      },
      ...additionalAgents.map((agent) => ({
        ...agent,
        status: "running" as const,
        channelNames: ["general"],
      })),
    ],
  });
}
