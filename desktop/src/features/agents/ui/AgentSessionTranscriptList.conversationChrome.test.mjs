/**
 * Presentation contract for the `conversation` transcript variant's *chrome*:
 * the agent identity row above each reply, and the focus code-block recipe.
 *
 * Split out of `AgentSessionTranscriptList.conversation.test.mjs` to stay under
 * the repo's hard 1000-line/file ceiling (AGENTS.md). The shared jsdom setup,
 * ambient-formatting pins, and render helpers live in the harness so the two
 * suites cannot drift apart.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT,
  AGENT_AVATAR_URL,
  AGENT_PROFILES,
  cleanup,
  fencedCodeItems,
  fencedCodePromptItems,
  renderTranscript,
  renderTranscriptWithCodeChrome,
} from "./AgentSessionTranscriptList.conversationHarness.mjs";

test("the conversation identity row announces the agent exactly once", async () => {
  // `UserAvatar` names itself — either an `<img alt="${displayName} avatar">` or
  // its fallback initials — and the row puts the agent's name in visible text
  // immediately after it. Left unhidden, assistive tech reads the same identity
  // twice for every single agent turn in the transcript. The visible name is
  // the row's one accessible identity; the avatar is decorative.
  const { container } = await renderTranscript("conversation", {
    agentAvatarUrl: null,
    profiles: AGENT_PROFILES,
  });
  const identity = container.querySelector(
    '[data-testid="transcript-assistant-identity"]',
  );
  assert.ok(identity, "the identity row should render");

  // The avatar is present and still shows the resolved image ...
  const decorative = identity.querySelector('[aria-hidden="true"]');
  assert.ok(decorative, "the avatar must be hidden from the accessible tree");
  const image = decorative.querySelector("img");
  assert.ok(image, "hiding the avatar must not stop it rendering visually");
  assert.equal(image.getAttribute("src"), AGENT_AVATAR_URL);

  // ... but every name-bearing node it contains is inside the hidden subtree,
  // so the accessible tree is left with exactly one copy of the name.
  const named = [...identity.querySelectorAll("img[alt], [aria-label]")];
  assert.ok(named.length > 0, "the avatar should still expose a raw alt/label");
  for (const node of named) {
    assert.ok(
      node.closest('[aria-hidden="true"]') !== null,
      `${node.tagName} carrying an accessible name escapes the hidden avatar subtree`,
    );
  }

  // The one remaining accessible identity is the visible name text.
  assert.equal(identity.textContent, "Test Agent");
});

test("conversation labels the agent turn with a berd-style identity row", async () => {
  // The single biggest divergence from berd was that agent prose carried no
  // attribution at all. berd puts a 20px round avatar + the agent name at
  // `text-xs` above every reply (MessageBubble.tsx:961-981).
  const { container } = await renderTranscript("conversation");
  const identity = container.querySelector(
    '[data-testid="transcript-assistant-identity"]',
  );
  assert.ok(identity, "conversation should label the agent turn");
  assert.match(identity.textContent, /Test Agent/);
  assert.match(identity.className, /text-xs/);
  assert.match(identity.className, /gap-1(?!\d)/);
  // 20px avatar, berd's size (UserAvatar `size="xs"` → `h-5 w-5`).
  assert.ok(
    identity.querySelector(".h-5.w-5"),
    "identity row should carry a 20px avatar",
  );
  // The prose itself stays unboxed and full-width.
  const message = container.querySelector(
    '[data-testid="transcript-assistant-message"]',
  );
  assert.doesNotMatch(message.innerHTML, /rounded-2xl/);
});

test("the conversation identity row resolves the agent avatar from the profiles lookup", async () => {
  // Regression guard for the primary channel flow. `ChannelAgentSessionAgent`
  // (useChannelAgentSessions.ts:21-29) has no avatar field at all, so when the
  // focus conversation is opened from a channel the panel passes
  // `agentAvatarUrl: null` — which is exactly this mount. The row must still
  // show the configured avatar by resolving it out of the `profiles` lookup the
  // panel already hands down, the same way the ToolItem row
  // (ToolItem.tsx:45-52) and the panel header above it already do. Before the
  // fix, every channel-opened session fell back to initials.
  const { container } = await renderTranscript("conversation", {
    agentAvatarUrl: null,
    profiles: AGENT_PROFILES,
  });
  const identity = container.querySelector(
    '[data-testid="transcript-assistant-identity"]',
  );
  assert.ok(identity, "the identity row should render");
  const image = identity.querySelector("img");
  assert.ok(
    image,
    "the profile avatar must win over the caller's null agent record avatar",
  );
  assert.equal(image.getAttribute("src"), AGENT_AVATAR_URL);
});

test("the conversation identity row resolves the agent name the same way the header does", async () => {
  // The row sits directly under the panel header, which labels the same agent
  // through `resolveUserLabel` (AgentSessionThreadPanel.tsx:244-249). Reading
  // the raw `agentName` prop instead let the two disagree whenever the relay
  // profile's display name differed from the caller's agent record.
  const { container } = await renderTranscript("conversation", {
    agentName: "stale-record-name",
    profiles: {
      [AGENT.agentPubkey]: {
        displayName: "Profile Display Name",
        avatarUrl: null,
        nip05Handle: null,
        ownerPubkey: null,
      },
    },
  });
  const identity = container.querySelector(
    '[data-testid="transcript-assistant-identity"]',
  );
  assert.equal(identity.textContent, "Profile Display Name");
});

test("the conversation identity row keeps the caller's avatar when the lookup has none", async () => {
  // The managed-agent path is the other direction: a locally managed agent can
  // carry an avatar its relay profile never published. The prop stays the
  // fallback, so resolving profile-first must not drop it.
  const localAvatar = "https://cdn.example.test/local-managed.png";
  const { container } = await renderTranscript("conversation", {
    agentAvatarUrl: localAvatar,
    profiles: {
      [AGENT.agentPubkey]: {
        displayName: "Test Agent",
        avatarUrl: null,
        nip05Handle: null,
        ownerPubkey: null,
      },
    },
  });
  const image = container
    .querySelector('[data-testid="transcript-assistant-identity"]')
    .querySelector("img");
  assert.ok(image, "the caller-supplied avatar should still render");
  assert.equal(image.getAttribute("src"), localAvatar);
});

test("conversation frames fenced code with berd's header row", async () => {
  // berd puts the language in a real header row above the frame, with the copy
  // action opposite it (`code-block.tsx` CodeBlockHeader:388-402), and the code
  // itself in a 10px-radius, page-background, borderless-shadow frame
  // (:528-529). Buzz's `rounded-lg` (`--radius: 0.625rem`) is exactly berd's
  // `rounded-[0.625rem]`.
  const { container } = await renderTranscriptWithCodeChrome("conversation", {
    items: fencedCodeItems(),
  });
  const header = container.querySelector(
    '[data-testid="markdown-code-block-header"]',
  );
  assert.ok(header, "focus mode should render a code-block header row");
  // Language sits in the header, not inside the frame.
  assert.match(header.textContent, /^ts/);
  assert.match(header.className, /justify-between/);
  assert.match(header.className, /items-end/);
  assert.match(header.className, /min-h-7/);
  assert.ok(
    header.querySelector('[aria-label="Copy code block"]'),
    "the copy action is a flow sibling of the language label",
  );

  const frame = container.querySelector("pre");
  assert.ok(frame, "the code frame should render");
  assert.match(frame.className, /rounded-lg/);
  assert.match(frame.className, /bg-background/);
  assert.match(frame.className, /border-border\/80/);
  assert.doesNotMatch(
    frame.className,
    /shadow/,
    "berd's code frame carries no shadow",
  );
  // Guards against the default recipe leaking in: it uses a 16px radius, a
  // muted fill, `pr-12` to clear an absolutely-positioned copy button, and an
  // inline `borderRadius` style.
  assert.doesNotMatch(frame.className, /rounded-2xl/);
  assert.doesNotMatch(frame.className, /bg-muted/);
  assert.doesNotMatch(frame.className, /pr-12/);
  assert.equal(frame.style.borderRadius, "");
  // Line numbers come from `.code-block-lines [data-line]` in markdown.css, so
  // the frame only has to keep emitting per-line elements under that class.
  const code = frame.querySelector("code.code-block-lines");
  assert.ok(code, "the code element keeps the line-number class");
  assert.equal(code.querySelectorAll("[data-line]").length, 2);
});

test("conversation applies the code recipe to a fenced human prompt too", async () => {
  // Regression guard for a real bug quality caught. The provider was first
  // mounted inside `MessageActivity`, which only handles assistant items — the
  // user bubble returns before it, so a fence inside a prompt kept the legacy
  // 16px muted frame nested inside the new 12px bubble. The recipe is a
  // property of the *surface*, not of a role, so the provider now sits at the
  // transcript boundary and both roles inherit it.
  const { container } = await renderTranscriptWithCodeChrome("conversation", {
    items: fencedCodePromptItems(),
  });
  const bubble = container.querySelector(
    '[data-testid="transcript-user-message"]',
  );
  assert.ok(bubble, "the prompt should render");
  assert.ok(
    bubble.querySelector('[data-testid="markdown-code-block-header"]'),
    "a fence inside the prompt gets berd's header row",
  );
  const frame = bubble.querySelector("pre");
  assert.match(frame.className, /rounded-lg/);
  assert.doesNotMatch(
    frame.className,
    /rounded-2xl/,
    "the legacy 16px frame must not nest inside the 12px bubble",
  );
  assert.doesNotMatch(frame.className, /pr-12/);
});

test("the default transcript variant keeps the legacy code chrome", async () => {
  // The markdown renderer is shared with channel messages, so `focusProse` is
  // opt-in per surface. Rendering the same fenced block through the `default`
  // transcript variant must still produce the original chrome: no header row,
  // 16px radius, muted fill, and the absolutely-positioned copy button.
  //
  // This proves the *variant gate*, not the channel-message row itself — those
  // rows are covered by the markdown tests in `shared/ui/markdown`.
  const { container } = await renderTranscriptWithCodeChrome("default", {
    items: fencedCodeItems(),
  });
  // `assert.ok(x === null)` rather than `assert.equal(x, null)`: on failure the
  // latter serializes the whole matched jsdom element (and its ancestors) to
  // build a diff, which exhausts memory instead of printing the message.
  assert.ok(
    container.querySelector('[data-testid="markdown-code-block-header"]') ===
      null,
    "the default recipe has no header row",
  );
  const frame = container.querySelector("pre");
  assert.match(frame.className, /rounded-2xl/);
  assert.match(frame.className, /bg-muted\/60/);
  assert.match(frame.className, /pr-12/);
  assert.match(frame.className, /shadow-xs/);
  const copy = container.querySelector('[aria-label="Copy code block"]');
  assert.ok(copy, "the default copy button still renders");
  assert.match(copy.className, /absolute/);
});

test("the identity row is conversation-only", async () => {
  // `default`/`compactPreview` markup is pinned byte-for-byte, so the identity
  // row must not leak into them. The fixture comparison would catch this too;
  // this asserts it directly so the failure names the cause.
  for (const variant of ["default", "compactPreview"]) {
    const { container } = await renderTranscript(variant);
    assert.ok(
      container.querySelector(
        '[data-testid="transcript-assistant-identity"]',
      ) === null,
      `${variant} must not render the identity row`,
    );
    cleanup();
  }
});
