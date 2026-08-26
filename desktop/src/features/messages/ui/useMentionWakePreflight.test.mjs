import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

import {
  buildMentionWakePlan,
  hasSubstantiveNonMentionText,
  MENTION_WAKE_DELAY_MS,
  useMentionWakePreflight,
} from "./useMentionWakePreflight.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

const AGENT = "a".repeat(64);
const OTHER_AGENT = "b".repeat(64);

const fizzRef = { displayName: "Fizz", pubkey: AGENT, isAgent: true };

test("mention-only composer content is not substantive", () => {
  assert.equal(hasSubstantiveNonMentionText("@Fizz ", [fizzRef]), false);
  assert.equal(hasSubstantiveNonMentionText("@Fizz hello", [fizzRef]), true);
  assert.equal(hasSubstantiveNonMentionText("hello @Fizz", [fizzRef]), true);
});

test("wake plan contains only managed agents already in the channel", () => {
  const plan = buildMentionWakePlan({
    channelId: "general",
    content: "@Fizz ask @Imp for help",
    isManagedAgentPubkey: (pubkey) => pubkey === AGENT,
    memberPubkeys: new Set([AGENT, OTHER_AGENT]),
    mentionRefs: [
      fizzRef,
      { displayName: "Imp", pubkey: OTHER_AGENT, isAgent: true },
    ],
  });

  assert.deepEqual(plan, {
    key: `general:${AGENT}`,
    pubkeys: [AGENT],
  });
});

test("wake plan rejects non-member managed agents", () => {
  assert.equal(
    buildMentionWakePlan({
      channelId: "general",
      content: "@Fizz hello",
      isManagedAgentPubkey: () => true,
      memberPubkeys: new Set(),
      mentionRefs: [fizzRef],
    }),
    null,
  );
});

test("editor updates arm a mention-first draft without a rerender", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { act, renderHook } = await import("@testing-library/react");
  let starts = 0;
  const contentRef = { current: "@Fizz " };
  const view = renderHook(() =>
    useMentionWakePreflight({
      channelId: "general",
      contentRef,
      enabled: true,
      expectedRelayUrl: "wss://relay.example",
      expectedSignerPubkey: "c".repeat(64),
      getDraftMentionRefs: () => [fizzRef],
      getManagedAgentsByPubkey: async () =>
        new Map([
          [
            AGENT,
            { pubkey: AGENT, status: "stopped", backend: { type: "local" } },
          ],
        ]),
      isManagedAgentPubkey: () => true,
      memberPubkeys: new Set([AGENT]),
      startManagedAgent: async () => {
        starts += 1;
        return { pubkey: AGENT, status: "running" };
      },
    }),
  );

  contentRef.current = "@Fizz please investigate";
  act(() => view.result.current.prepareMentionWake(contentRef.current));
  await act(async () => t.mock.timers.tick(MENTION_WAKE_DELAY_MS));

  assert.equal(starts, 1);
});

test("mention-free drafts skip the mention-ref snapshot entirely", async () => {
  const { act, renderHook } = await import("@testing-library/react");
  let snapshots = 0;
  const contentRef = { current: "" };
  const view = renderHook(() =>
    useMentionWakePreflight({
      channelId: "general",
      contentRef,
      enabled: true,
      expectedRelayUrl: "wss://relay.example",
      expectedSignerPubkey: "c".repeat(64),
      getDraftMentionRefs: () => {
        snapshots += 1;
        return [];
      },
      getManagedAgentsByPubkey: async () => new Map(),
      isManagedAgentPubkey: () => true,
      memberPubkeys: new Set([AGENT]),
      startManagedAgent: async () => ({ pubkey: AGENT, status: "running" }),
    }),
  );

  contentRef.current = "no mentions in this draft";
  act(() => view.result.current.prepareMentionWake(contentRef.current));

  assert.equal(snapshots, 0);
});

test("provider-backed agents are never woken speculatively", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { act, renderHook } = await import("@testing-library/react");
  let starts = 0;
  const contentRef = { current: "@Fizz please investigate" };
  const view = renderHook(() =>
    useMentionWakePreflight({
      channelId: "general",
      contentRef,
      enabled: true,
      expectedRelayUrl: "wss://relay.example",
      expectedSignerPubkey: "c".repeat(64),
      getDraftMentionRefs: () => [fizzRef],
      getManagedAgentsByPubkey: async () =>
        new Map([
          [
            AGENT,
            {
              pubkey: AGENT,
              status: "not_deployed",
              backend: { type: "provider", id: "blox", config: {} },
            },
          ],
        ]),
      isManagedAgentPubkey: () => true,
      memberPubkeys: new Set([AGENT]),
      startManagedAgent: async () => {
        starts += 1;
        return { pubkey: AGENT, status: "deployed" };
      },
    }),
  );

  act(() => view.result.current.prepareMentionWake(contentRef.current));
  await act(async () => t.mock.timers.tick(MENTION_WAKE_DELAY_MS));

  assert.equal(starts, 0);
});

test("unmount prevents a wake after an in-flight lookup resolves", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { act, renderHook } = await import("@testing-library/react");
  let resolveManagedAgents;
  const managedAgents = new Promise((resolve) => {
    resolveManagedAgents = resolve;
  });
  let starts = 0;
  const contentRef = { current: "@Fizz hello" };
  const view = renderHook(() =>
    useMentionWakePreflight({
      channelId: "general",
      contentRef,
      enabled: true,
      expectedRelayUrl: "wss://relay.example",
      expectedSignerPubkey: "c".repeat(64),
      getDraftMentionRefs: () => [fizzRef],
      getManagedAgentsByPubkey: () => managedAgents,
      isManagedAgentPubkey: () => true,
      memberPubkeys: new Set([AGENT]),
      startManagedAgent: async () => {
        starts += 1;
        return { pubkey: AGENT, status: "running" };
      },
    }),
  );

  await act(async () => t.mock.timers.tick(MENTION_WAKE_DELAY_MS));
  view.unmount();
  await act(async () => {
    resolveManagedAgents(
      new Map([
        [
          AGENT,
          { pubkey: AGENT, status: "stopped", backend: { type: "local" } },
        ],
      ]),
    );
    await managedAgents;
  });

  assert.equal(starts, 0);
});
