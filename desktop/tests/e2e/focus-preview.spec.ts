import { expect, test, type Page } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const SHOTS = process.env.FOCUS_PREVIEW_SHOTS ?? "test-results/focus-preview";
const AGENT_PUBKEY = TEST_IDENTITIES.tyler.pubkey;
const CHANNEL_ID = "94a444a4-c0a3-5966-ab05-530c6ddc2301"; // #agents
const SESSION = "session-focus-001";
const TURN = "turn-focus-001";
const THEME_STORAGE_KEY = "buzz-theme";

/**
 * Seed the active theme before the bridge installs — `ThemeProvider` reads
 * localStorage on first mount, and the bridge is what triggers that mount, so
 * an init script registered later would land after the read.
 */
async function seedTheme(page: Page, theme: "buzz" | "buzz-dark") {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: THEME_STORAGE_KEY, value: theme },
  );
}

const MANAGED_AGENTS = [
  {
    pubkey: AGENT_PUBKEY,
    name: "Observer Agent",
    status: "running" as const,
    channelNames: ["agents"],
  },
];

// Anchor the session just before "now" so relative labels ("Last updated 1m
// ago") read like a real session rather than a year-old archive. Both captures
// run within minutes of each other, so the labels stay comparable.
const T0 = Date.now() - 90_000;
const at = (offsetSeconds: number) =>
  new Date(T0 + offsetSeconds * 1_000).toISOString();

type Evt = {
  seq: number;
  timestamp: string;
  kind: string;
  agentIndex: number | null;
  channelId: string | null;
  sessionId: string | null;
  turnId: string | null;
  payload: unknown;
};

let seq = 0;
function sessionUpdate(offsetSeconds: number, update: unknown): Evt {
  seq += 1;
  return {
    seq,
    timestamp: at(offsetSeconds),
    kind: "acp_read",
    agentIndex: 0,
    channelId: CHANNEL_ID,
    sessionId: SESSION,
    turnId: TURN,
    payload: {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: SESSION, update },
    },
  };
}

function toolCall(
  offsetSeconds: number,
  input: {
    id: string;
    toolName: string;
    title: string;
    args: Record<string, unknown>;
    output: string;
    failed?: boolean;
  },
): Evt[] {
  return [
    sessionUpdate(offsetSeconds, {
      sessionUpdate: "tool_call",
      toolCallId: input.id,
      toolName: input.toolName,
      title: input.title,
      status: "in_progress",
      rawInput: input.args,
    }),
    sessionUpdate(offsetSeconds + 1, {
      sessionUpdate: "tool_call_update",
      toolCallId: input.id,
      toolName: input.toolName,
      title: input.title,
      status: input.failed ? "failed" : "completed",
      rawInput: input.args,
      content: [
        { type: "content", content: { type: "text", text: input.output } },
      ],
    }),
  ];
}

/**
 * The relay post the agent makes mid-turn, in the shape the message
 * presentation actually needs.
 *
 * Two details are load-bearing and neither is decoration:
 *
 *  - the command must be a real `buzz messages send … --content '…'`, because
 *    `parseBuzzCliCommand` is what classifies the step as `renderClass:
 *    "message"`, and the inline `--content` value is what
 *    `extractBuzzCliInlineContent` lifts out as the row's preview. Without it
 *    `CompactMessageSummary` would fall back to fetching the event by id, which
 *    the mock bridge does not serve, and the bubble would read "Message content
 *    unavailable."
 *  - the content must contain no backtick and no `$`.
 *    `extractBuzzCliInlineContent` (agentSessionToolClassifier.ts:459) returns
 *    `null` for either, because a preview lifted out of an unexecuted shell
 *    string cannot be shown as if it were the final text. The step still
 *    classifies as a message, but the preview is dropped and the row degrades to
 *    a bare "Sent messages" — measured, not assumed. Markdown in a seeded post
 *    therefore silently produces a *less* representative screenshot, so this
 *    body is deliberately plain prose.
 *  - the result must carry an `event_id`, because `getSentMessageLink` requires
 *    one (plus `completed` and no error) before it will produce a link — and the
 *    link is what turns the bubble into a clickable jump-to-message with its
 *    hover cue, which is the difference between the real presentation and a
 *    dead preview.
 */
function relayPostToolCall(offsetSeconds: number): Evt[] {
  return toolCall(offsetSeconds, {
    id: "call-relay-1",
    toolName: "buzz_dev_mcp__shell",
    title: "shell",
    args: {
      command:
        "buzz messages send --channel 3379e041-55ad-4c87-995a-6361970f6c01 --content 'Confirmed the mismatch is on the emit side: the alert is written with the plural category while every reader compares against the singular one, so the mention branch never matches and the badge falls through to the generic channel-activity path. Fix is one line at the emit site. Not pushed yet, because the feed test directory the suite expects does not exist.'",
    },
    output: JSON.stringify(
      {
        event_id:
          "a41c9e2f7b5d4c8390f16ab27de4c5b109882f3ad6c07e5419b3ac6d2e8f7104",
        channel: "3379e041-55ad-4c87-995a-6361970f6c01",
        accepted: true,
      },
      null,
      2,
    ),
  });
}

/**
 * One finished turn: prompt → thinking → three file reads → a shell command →
 * a relay write → a failed step → a plan → the agent's reply.
 */
function buildSessionEvents(): Evt[] {
  seq = 0;
  const events: Evt[] = [];

  // Human prompt (session/prompt, so the transcript renders the prompt bundle).
  seq += 1;
  events.push({
    seq,
    timestamp: at(0),
    kind: "acp_write",
    agentIndex: 0,
    channelId: CHANNEL_ID,
    sessionId: SESSION,
    turnId: TURN,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: {
        prompt: [
          {
            type: "text",
            text: "[Buzz event: Kind 9]\nContent: @Observer Agent the mention badge is showing up on the wrong channel row after a reconnect. Can you trace where the feed category is set and confirm whether the singular/plural mismatch is the cause? Post what you find here.",
          },
          {
            type: "text",
            text: "[Thread context]\nThis is the thread history with 3 prior messages.",
          },
        ],
      },
    },
  });

  // Short thinking block.
  events.push(
    sessionUpdate(4, {
      sessionUpdate: "agent_thought_chunk",
      messageId: "thought-1",
      content: {
        type: "text",
        text: "The badge is driven by the feed category emitted on the alert event, so the mismatch would show up where that category string is built. Start at the emit site, then follow the value into the sidebar row selector.",
      },
    }),
  );

  // Three file reads.
  events.push(
    ...toolCall(12, {
      id: "call-read-1",
      toolName: "buzz_dev_mcp__read_file",
      title: "read_file",
      args: { path: "desktop/src/features/feed/lib/feedCategory.ts" },
      output: 'export type FeedCategory = "mention" | "reply" | "reaction";',
    }),
    ...toolCall(15, {
      id: "call-read-2",
      toolName: "buzz_dev_mcp__read_file",
      title: "read_file",
      args: { path: "desktop/src/features/feed/lib/alertRouting.ts" },
      output: 'if (category === "mentions") { routeToChannel(channelId); }',
    }),
    ...toolCall(18, {
      id: "call-read-3",
      toolName: "buzz_dev_mcp__read_file",
      title: "read_file",
      args: { path: "desktop/src/features/channels/ui/ChannelRowBadge.tsx" },
      output: 'const hasMention = categories.includes("mention");',
    }),
  );

  // Shell command with a few lines of output.
  events.push(
    ...toolCall(24, {
      id: "call-shell-1",
      toolName: "buzz_dev_mcp__shell",
      title: "shell",
      args: {
        command:
          "rg -n 'mentions\\\"' desktop/src --glob '*.ts' --glob '*.tsx'",
      },
      output: [
        'desktop/src/features/feed/lib/alertRouting.ts:41:  if (category === "mentions") {',
        'desktop/src/features/feed/emitFeedAlert.ts:88:    category: "mentions",',
        'desktop/src/features/feed/emitFeedAlert.test.mjs:12:  category: "mentions",',
        "",
        "3 matches across 3 files",
      ].join("\n"),
    }),
  );

  // The relay post the agent makes mid-turn. `event_id` in the result is what
  // `getSentMessageLink` reads, so this is the shape that carries a real link
  // back to the posted message rather than an unlinked preview.
  events.push(...relayPostToolCall(31));

  // Failed step with an error string.
  events.push(
    ...toolCall(37, {
      id: "call-fail-1",
      toolName: "buzz_dev_mcp__shell",
      title: "shell",
      args: { command: "pnpm vitest run desktop/src/features/feed" },
      output:
        "Error: ENOENT: no such file or directory, scandir 'desktop/src/features/feed/__tests__'\n    at readdirSync (node:fs:1478:26)\nexit code 1",
      failed: true,
    }),
  );

  // Plan with checked and unchecked items.
  events.push(
    sessionUpdate(44, {
      sessionUpdate: "plan",
      entries: [
        { content: "Trace the feed category emit site", status: "completed" },
        {
          content: "Confirm the sidebar row reads the singular form",
          status: "completed",
        },
        {
          content: "Add a regression test for the routing branch",
          status: "pending",
        },
        { content: "Open the fix PR", status: "pending" },
      ],
    }),
  );

  // Final reply: a paragraph plus a fenced code block.
  events.push(
    sessionUpdate(52, {
      sessionUpdate: "agent_message_chunk",
      messageId: "reply-1",
      content: {
        type: "text",
        text: [
          'Confirmed — it is the singular/plural mismatch, and it is on the emit side. `emitFeedAlert` writes `category: "mentions"` while every reader compares against the singular `"mention"`, so the alert never matches the mention branch and falls through to the generic channel-activity path. That is why the badge lands on whichever row was last touched rather than the mentioning channel.',
          "",
          "```ts",
          "// desktop/src/features/feed/emitFeedAlert.ts",
          '-  category: "mentions",',
          '+  category: "mention",',
          "```",
          "",
          "The reader side needs no change. I have not pushed a fix yet — the feed test directory the suite expects does not exist, so the regression test needs a home first.",
        ].join("\n"),
      },
    }),
  );

  return events;
}

async function seedSession(page: Page) {
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__ === "function",
    null,
    { timeout: 15_000 },
  );
  await page.evaluate(
    ({ pubkey, evts }) => {
      window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__?.({
        agentPubkey: pubkey,
        events: evts,
      });
    },
    { pubkey: AGENT_PUBKEY, evts: buildSessionEvents() },
  );
  await page.waitForTimeout(500);
}

/**
 * The same turn caught mid-flight: everything up to and including the relay
 * post, then one step still `in_progress` and no answer yet.
 *
 * The trailing announcement is deliberately left unpaired — a `tool_call`
 * with no `tool_call_update` is exactly what the harness has published when a
 * step is genuinely running, and `toolEntryState` only reports `running` when
 * the item's turn is the live one, so the live turn has to be seeded too (see
 * `seedLiveSession`).
 */
function buildLiveSessionEvents(): Evt[] {
  const events = buildSessionEvents();
  // Drop everything after the relay post's terminal update: the failure, the
  // plan and the answer all come later, and a turn cannot be mid-flight and
  // have delivered its answer. Found by walking the events rather than by a
  // hardcoded index, so reordering the seeded turn cannot silently truncate in
  // the wrong place.
  const postTerminalSeq = relayPostTerminalSeq(events);
  const upToPost = events.filter((event) => event.seq <= postTerminalSeq);
  seq = postTerminalSeq;
  upToPost.push(
    sessionUpdate(34, {
      sessionUpdate: "tool_call",
      toolCallId: "call-live-1",
      toolName: "buzz_dev_mcp__shell",
      title: "shell",
      status: "in_progress",
      rawInput: {
        command: "pnpm vitest run desktop/src/features/feed --reporter dot",
      },
    }),
  );
  return upToPost;
}

/** The seq of the relay post's terminal `tool_call_update`. */
function relayPostTerminalSeq(events: Evt[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const update = (
      event.payload as {
        params?: { update?: { sessionUpdate?: string; toolCallId?: string } };
      }
    )?.params?.update;
    if (
      update?.toolCallId === "call-relay-1" &&
      update.sessionUpdate === "tool_call_update"
    ) {
      return event.seq;
    }
  }
  throw new Error("relay post terminal update not found in the seeded turn");
}

/**
 * Seed a live turn: the observer events plus the active-turn record.
 *
 * `isTurnLive` comes from the active-turns store
 * (`AgentSessionTranscriptList.tsx:116`), which is what gates
 * `buildConversationTurnMeta` into producing any liveness hints at all; the turn
 * id inside the transcript is what `toolEntryState` compares against.
 *
 * The explicit `__BUZZ_E2E_SEED_ACTIVE_TURNS__` call is belt-and-braces, NOT a
 * requirement — measured by removing it, after which the mid-flight test still
 * passes with a `running` tail. The seeded `acp_read`/`acp_write` frames carry a
 * `turnId` and a `channelId`, and `activeAgentTurnsStore`'s stream-activity
 * branch resurrects a turn from exactly that (`activeAgentTurnsStore.ts:434` ->
 * `resurrectTurn:238`), so the events alone already make the turn live. It is
 * kept because it states the intent that the turn is live rather than leaving it
 * to a side effect of the frame kind, but do not rely on it as the only thing
 * holding the live state up.
 */
async function seedLiveSession(page: Page) {
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__ === "function",
    null,
    { timeout: 15_000 },
  );
  await page.evaluate(
    ({ pubkey, evts, channelId, turnId }) => {
      window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__?.({
        agentPubkey: pubkey,
        events: evts,
      });
      window.__BUZZ_E2E_SEED_ACTIVE_TURNS__?.({
        agentPubkey: pubkey,
        channelId,
        turnId,
      });
    },
    {
      pubkey: AGENT_PUBKEY,
      evts: buildLiveSessionEvents(),
      channelId: CHANNEL_ID,
      turnId: TURN,
    },
  );
  await page.waitForTimeout(500);
}

/** Composer activity bar → View activity. Same ingress in both builds. */
async function openActivityFromComposer(page: Page) {
  await page.getByTestId("channel-agents").click();
  await expect(page.getByTestId("chat-title")).toHaveText("agents");

  await page.evaluate((pubkey) => {
    window.__BUZZ_E2E_EMIT_MOCK_TYPING__?.({
      channelName: "agents",
      pubkey,
    });
  }, AGENT_PUBKEY);

  const trigger = page.getByTestId("bot-activity-composer-trigger");
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await trigger.click();
  const item = page.getByTestId(`bot-activity-composer-item-${AGENT_PUBKEY}`);
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.click({ force: true });
  await expect(page.getByTestId("agent-session-thread-panel")).toBeVisible({
    timeout: 15_000,
  });
}

async function settle(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations({ subtree: true })
        .filter(
          (a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY,
        )
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  await page.waitForTimeout(400);
}

/**
 * Open the work block that holds the agent's relay post.
 *
 * Clicks the summary trigger rather than forcing a `<details>` open, because in
 * this build the block's disclosure is a `<button aria-expanded>` backed by the
 * shared disclosure store, not a native `<details>` — forcing the DOM would
 * bypass the store and capture a state the product cannot reach.
 */
async function openWorkBlock(page: Page) {
  const summary = page.getByTestId("transcript-work-block-summary").first();
  await expect(summary).toBeVisible({ timeout: 10_000 });
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  await summary.click();
  await expect(summary).toHaveAttribute("aria-expanded", "true");
}

/** The rail step whose label is the agent's relay post. */
function sentStep(page: Page) {
  return page
    .getByTestId("transcript-work-block-step")
    .filter({ hasText: "Sent" })
    .first();
}

async function scrollTranscriptToTop(page: Page) {
  await page.getByTestId("agent-session-thread-panel").evaluate((panel) => {
    let node = panel.querySelector('[role="log"]')?.parentElement ?? null;
    while (node) {
      const overflowY = window.getComputedStyle(node).overflowY;
      if (
        (overflowY === "auto" || overflowY === "scroll") &&
        node.scrollHeight > node.clientHeight
      ) {
        node.scrollTop = 0;
        return;
      }
      node = node.parentElement;
    }
  });
}

/**
 * How the focus view presents a message the agent posted to a channel.
 *
 * Captured in both themes because the step's whole presentation is tone — muted
 * label, muted preview, a spine glyph — and a light-only shot cannot show
 * whether that survives on the dark palette.
 */
async function captureMessageDisplay(page: Page, theme: "light" | "dark") {
  await seedSession(page);
  await openActivityFromComposer(page);
  await seedSession(page);
  await settle(page);

  const panel = page.getByTestId("agent-session-thread-panel");
  // The reading view really is the pinned conversation variant — without this
  // every shot below could be of the dense activity feed and still look
  // plausible.
  await expect(panel.locator("[data-transcript-variant]")).toHaveAttribute(
    "data-transcript-variant",
    "conversation",
  );

  // 1 — folded. The turn's answer is the only prose in frame; every step the
  // agent took, the relay post included, is behind the one-line summary.
  await expect(
    page.getByTestId("transcript-work-block-summary").first(),
  ).toBeVisible({ timeout: 10_000 });
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/${theme}-01-folded.png` });

  // 2 — the rail open, with the post as a step on it. Scrolled to the head so
  // the whole rail is in frame rather than its tail.
  await openWorkBlock(page);
  await scrollTranscriptToTop(page);
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/${theme}-02-rail-open.png` });

  // 3 — the post's own step, expanded. This is the frame that answers what a
  // reader actually sees of the message body.
  const step = sentStep(page);
  await expect(step).toBeVisible({ timeout: 10_000 });
  // The row must carry the posted text, not just the verb. A backtick or `$`
  // anywhere in the seeded `--content` makes `extractBuzzCliInlineContent`
  // return null, and the row silently degrades to a bare "Sent messages" — a
  // shot that looks plausible while showing none of the message. Pinning a
  // distinctive phrase from the body is what makes that failure loud.
  await expect(step).toContainText("the alert is written with the plural");
  await step.scrollIntoViewIfNeeded();
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/${theme}-03-sent-step.png` });

  const stepDetails = step.locator("details").first();
  if (await stepDetails.count()) {
    await stepDetails.locator("summary").first().click();
    await settle(page);
    await step.scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({
      path: `${SHOTS}/${theme}-04-sent-step-expanded.png`,
    });
  }
}

test.describe("focus view preview", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("typical agent session with tool calls", async ({ page }) => {
    await installMockBridge(page, { managedAgents: MANAGED_AGENTS });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await seedSession(page);
    await openActivityFromComposer(page);
    await seedSession(page);
    await settle(page);

    // 1 — the full window exactly as the surface opens.
    await page.screenshot({ path: `${SHOTS}/01-opened.png` });

    // 2 — scrolled to the head of the transcript.
    await scrollTranscriptToTop(page);
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/02-prompt-and-thinking.png` });

    // 3 — the work block open, so the turn's steps are on screen.
    await openWorkBlock(page);
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/03-work-block-open.png` });
  });

  test("agent's posted message, light", async ({ page }) => {
    await seedTheme(page, "buzz");
    await installMockBridge(page, { managedAgents: MANAGED_AGENTS });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await captureMessageDisplay(page, "light");
  });

  test("agent's posted message, dark", async ({ page }) => {
    await seedTheme(page, "buzz-dark");
    await installMockBridge(page, { managedAgents: MANAGED_AGENTS });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await captureMessageDisplay(page, "dark");
  });

  test("mid-flight, with the post already on the rail", async ({ page }) => {
    await seedTheme(page, "buzz");
    await installMockBridge(page, { managedAgents: MANAGED_AGENTS });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await seedLiveSession(page);
    await openActivityFromComposer(page);
    await seedLiveSession(page);
    await settle(page);

    // While live the block has no summary trigger — the rail IS the status — so
    // this asserts the live presentation rather than assuming it, and the shot
    // is worthless if the block turns out to be folded.
    await expect(
      page.getByTestId("transcript-work-block-step").first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("transcript-work-block-summary")).toHaveCount(
      0,
    );
    // Liveness really reached the rail: the unpaired trailing step must project
    // as `running`, which only happens when the active-turn store agrees the
    // item's turn is the live one (`toolEntryState`). Read off `data-step-state`
    // rather than off the glyph, because the running glyph and the settled glyph
    // are the same wrench — a mid-flight shot with a settled tail would look
    // entirely plausible and prove nothing.
    await expect(page.locator('[data-step-state="running"]')).toHaveCount(1);
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/live-01-mid-flight.png` });
  });
});
