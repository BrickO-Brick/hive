import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  isAtOrAfterConversationOpener,
  mergeProjectAgentConversationEvents,
  restoreProjectsAgentConversation,
  visibleConversationMessages,
} from "./projectAgentConversation.ts";
import {
  clearStoredProjectsAgentConversation,
  readStoredProjectsAgentConversation,
  writeStoredProjectsAgentConversation,
} from "./projectAgentConversationStorage.ts";
import {
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
} from "@/shared/constants/kinds";

const AGENT_PUBKEY = "a".repeat(64);
const WORKSPACE_ID = "wss://relay.example.com";
// The user opened the Projects prompt at this instant (epoch seconds).
const PROMPT_AT = 1_752_570_000;
// The relay-accepted event id of the opening prompt. Within the opener's
// second, the timeline orders by ascending id, so ids <= the opener's are
// at-or-after it and ids > it are older history.
const OPENER = { createdAt: PROMPT_AT, eventId: `d${"0".repeat(63)}` };

const AGENT = { pubkey: AGENT_PUBKEY, name: "Brain" };

/** A pre-existing agent DM channel with plenty of unrelated history. */
const EXISTING_DM = {
  id: "dm-channel-1",
  channelType: "dm",
  participantPubkeys: [AGENT_PUBKEY, "b".repeat(64)],
  lastMessageAt: new Date((PROMPT_AT - 60) * 1_000).toISOString(),
};

function message(createdAt, kind = KIND_STREAM_MESSAGE, id) {
  return { kind, created_at: createdAt, id: id ?? `msg-${kind}-${createdAt}` };
}

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

beforeEach(() => store.clear());

test("an existing agent DM is never auto-restored without a stored pointer", () => {
  const restored = restoreProjectsAgentConversation({
    stored: null,
    channels: [EXISTING_DM],
    candidates: [AGENT],
  });
  assert.equal(restored, null);
});

test("restores exactly the conversation this feature persisted", () => {
  const restored = restoreProjectsAgentConversation({
    stored: {
      agentPubkey: AGENT_PUBKEY.toUpperCase(),
      channelId: EXISTING_DM.id,
      opener: OPENER,
    },
    channels: [EXISTING_DM],
    candidates: [AGENT],
  });
  assert.equal(restored?.channel, EXISTING_DM);
  assert.equal(restored?.agent, AGENT);
  assert.deepEqual(restored?.opener, OPENER);
});

test("pointers to unknown channels or agents are not restorable", () => {
  const stored = {
    agentPubkey: AGENT_PUBKEY,
    channelId: EXISTING_DM.id,
    opener: OPENER,
  };
  assert.equal(
    restoreProjectsAgentConversation({
      stored,
      channels: [],
      candidates: [AGENT],
    }),
    null,
  );
  assert.equal(
    restoreProjectsAgentConversation({
      stored,
      channels: [EXISTING_DM],
      candidates: [],
    }),
    null,
  );
});

test("messages the DM held before the first Projects prompt never appear", () => {
  const olderHistory = [
    message(PROMPT_AT - 86_400),
    message(PROMPT_AT - 3_600, KIND_STREAM_MESSAGE_V2),
    message(PROMPT_AT - 1),
  ];
  const opener = message(PROMPT_AT, KIND_STREAM_MESSAGE, OPENER.eventId);
  const reply = message(PROMPT_AT + 5, KIND_STREAM_MESSAGE_V2);
  const nonChatEvent = message(PROMPT_AT + 10, 7);

  const visible = visibleConversationMessages(
    [reply, ...olderHistory, opener, nonChatEvent],
    OPENER,
  );
  assert.deepEqual(visible, [opener, reply]);
});

test("unrelated DM history sharing the opener's second is excluded", () => {
  // Relay order within one second is ascending id (newest first), so events
  // with ids greater than the opener's id are strictly older than it.
  const sameSecondOlder = message(
    PROMPT_AT,
    KIND_STREAM_MESSAGE,
    `e${"f".repeat(63)}`,
  );
  const opener = message(PROMPT_AT, KIND_STREAM_MESSAGE, OPENER.eventId);
  const sameSecondNewer = message(
    PROMPT_AT,
    KIND_STREAM_MESSAGE_V2,
    `c${"0".repeat(63)}`,
  );

  const visible = visibleConversationMessages(
    [sameSecondOlder, opener, sameSecondNewer],
    OPENER,
  );
  assert.deepEqual(visible, [opener, sameSecondNewer]);
  assert.equal(isAtOrAfterConversationOpener(sameSecondOlder, OPENER), false);
  assert.equal(isAtOrAfterConversationOpener(opener, OPENER), true);
});

test("root questions and separately queried replies stay in conversation order", () => {
  const firstQuestion = message(PROMPT_AT, KIND_STREAM_MESSAGE, OPENER.eventId);
  const firstAnswer = message(PROMPT_AT + 2, KIND_STREAM_MESSAGE_V2);
  const secondQuestion = message(PROMPT_AT + 4);
  const secondAnswer = message(PROMPT_AT + 6, KIND_STREAM_MESSAGE_V2);

  const merged = mergeProjectAgentConversationEvents(
    [firstQuestion, secondQuestion],
    [firstAnswer, secondAnswer, firstAnswer],
  );

  assert.deepEqual(merged, [
    firstQuestion,
    firstAnswer,
    secondQuestion,
    secondAnswer,
  ]);
});

test("storage read rejects legacy timestamp-only pointers", () => {
  // Pointers written before the opener was event-anchored carry only
  // `visibleAfter`. They cannot uphold the same-second isolation invariant,
  // so they are not restorable.
  globalThis.localStorage.setItem(
    `buzz.projects.agentConversation.${encodeURIComponent(WORKSPACE_ID)}`,
    JSON.stringify({
      agentPubkey: AGENT_PUBKEY,
      channelId: EXISTING_DM.id,
      visibleAfter: PROMPT_AT,
    }),
  );
  assert.equal(readStoredProjectsAgentConversation(WORKSPACE_ID), null);
});

test("storage read rejects malformed opener pointers", () => {
  for (const opener of [
    { createdAt: 0, eventId: OPENER.eventId },
    { createdAt: Number.NaN, eventId: OPENER.eventId },
    { createdAt: PROMPT_AT, eventId: "" },
    { createdAt: PROMPT_AT },
    null,
  ]) {
    globalThis.localStorage.setItem(
      `buzz.projects.agentConversation.${encodeURIComponent(WORKSPACE_ID)}`,
      JSON.stringify({
        agentPubkey: AGENT_PUBKEY,
        channelId: EXISTING_DM.id,
        opener,
      }),
    );
    assert.equal(readStoredProjectsAgentConversation(WORKSPACE_ID), null);
  }
});

test("storage round-trips opener-anchored pointers and clears them", () => {
  const stored = {
    agentPubkey: AGENT_PUBKEY,
    channelId: EXISTING_DM.id,
    opener: OPENER,
  };
  writeStoredProjectsAgentConversation(WORKSPACE_ID, stored);
  assert.deepEqual(readStoredProjectsAgentConversation(WORKSPACE_ID), stored);

  clearStoredProjectsAgentConversation(WORKSPACE_ID);
  assert.equal(readStoredProjectsAgentConversation(WORKSPACE_ID), null);
});
