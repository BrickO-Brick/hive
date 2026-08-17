import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  isAtOrAfterConversationOpener,
  mergeProjectAgentConversationEvents,
  restoreProjectsAgentConversation,
  submitProjectAgentMessage,
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
const SELF_PUBKEY = "b".repeat(64);
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
  participantPubkeys: [AGENT_PUBKEY, SELF_PUBKEY],
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
    currentPubkey: SELF_PUBKEY,
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
    currentPubkey: SELF_PUBKEY,
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
      currentPubkey: SELF_PUBKEY,
    }),
    null,
  );
  assert.equal(
    restoreProjectsAgentConversation({
      stored,
      channels: [EXISTING_DM],
      candidates: [],
      currentPubkey: SELF_PUBKEY,
    }),
    null,
  );
});

test("a pointer naming a non-DM or foreign-participant channel is not restorable", () => {
  const stored = {
    agentPubkey: AGENT_PUBKEY,
    channelId: EXISTING_DM.id,
    opener: OPENER,
  };
  // Same id, but not a DM — a stale/colliding pointer must not render it.
  assert.equal(
    restoreProjectsAgentConversation({
      stored,
      channels: [{ ...EXISTING_DM, channelType: "stream" }],
      candidates: [AGENT],
      currentPubkey: SELF_PUBKEY,
    }),
    null,
  );
  // A DM with a third participant is someone else's conversation.
  assert.equal(
    restoreProjectsAgentConversation({
      stored,
      channels: [
        {
          ...EXISTING_DM,
          participantPubkeys: [AGENT_PUBKEY, SELF_PUBKEY, "c".repeat(64)],
        },
      ],
      candidates: [AGENT],
      currentPubkey: SELF_PUBKEY,
    }),
    null,
  );
  // A DM that does not include the agent proves nothing about the pointer.
  assert.equal(
    restoreProjectsAgentConversation({
      stored,
      channels: [{ ...EXISTING_DM, participantPubkeys: [SELF_PUBKEY] }],
      candidates: [AGENT],
      currentPubkey: SELF_PUBKEY,
    }),
    null,
  );
  // Without a current identity there is nothing to validate against.
  assert.equal(
    restoreProjectsAgentConversation({
      stored,
      channels: [EXISTING_DM],
      candidates: [AGENT],
      currentPubkey: null,
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

test("a fast reply in the opener's second is admitted via its reply reference", () => {
  // An agent reply signed within the opener's second can carry an id greater
  // than the opener's, which sorts "older" in relay order. Its `e` tag names
  // the opener — causality that must win over the id tiebreak.
  const fastReply = {
    ...message(PROMPT_AT, KIND_STREAM_MESSAGE_V2, `f${"a".repeat(63)}`),
    tags: [["e", OPENER.eventId, "", "reply"]],
  };
  // An unrelated same-second event with the same unlucky id ordering and no
  // reference to the opener stays excluded.
  const unrelated = {
    ...message(PROMPT_AT, KIND_STREAM_MESSAGE, `f${"b".repeat(63)}`),
    tags: [["e", `9${"9".repeat(63)}`, "", "reply"]],
  };

  assert.equal(isAtOrAfterConversationOpener(fastReply, OPENER), true);
  assert.equal(isAtOrAfterConversationOpener(unrelated, OPENER), false);
  const opener = message(PROMPT_AT, KIND_STREAM_MESSAGE, OPENER.eventId);
  // Same-second sort is stable, so relay arrival order (opener first) holds.
  assert.deepEqual(
    visibleConversationMessages([unrelated, opener, fastReply], OPENER),
    [opener, fastReply],
  );
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

// ── submitProjectAgentMessage ───────────────────────────────────────────────

/** Models the backend's fail-closed scope check: commands resolve the active
 * relay when they run and reject when a caller-captured scope no longer
 * matches. `active` is mutable so tests can switch communities mid-flight. */
function makeScopedBackend(active) {
  const state = { active, dmOpens: [], sends: [] };
  const assertScope = (expectedRelayUrl) => {
    if (expectedRelayUrl !== undefined && expectedRelayUrl !== state.active) {
      throw new Error(
        "active community changed before the message was submitted; not sent",
      );
    }
  };
  return {
    state,
    openDm: async (input) => {
      assertScope(input.expectedRelayUrl);
      state.dmOpens.push({ relay: state.active, input });
      return { id: `dm-on-${state.active}` };
    },
    send: async (request) => {
      assertScope(request.expectedRelayUrl);
      state.sends.push({ relay: state.active, request });
      return { eventId: `f${"0".repeat(63)}`, createdAt: PROMPT_AT };
    },
  };
}

test("a community switch during agent startup publishes nothing to either tenant", async () => {
  const backend = makeScopedBackend("wss://tenant-a.example");
  let releaseStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });

  const pending = submitProjectAgentMessage({
    agent: { pubkey: AGENT_PUBKEY, isManaged: true, isActive: false },
    conversation: null,
    content: "tenant A repo context",
    mentionPubkeys: [AGENT_PUBKEY],
    relayScope: "wss://tenant-a.example",
    startAgent: () => startGate,
    openDm: backend.openDm,
    send: backend.send,
  });

  // The user switches communities while the callback is suspended on the
  // managed-agent startup await. Remounting removed the panel, but this
  // callback keeps running.
  backend.state.active = "wss://tenant-b.example";
  releaseStart();

  await assert.rejects(pending, /active community changed/);
  assert.deepEqual(backend.state.dmOpens, []);
  assert.deepEqual(backend.state.sends, []);
});

test("a community switch during the DM open fails the send closed", async () => {
  const backend = makeScopedBackend("wss://tenant-a.example");
  const scopedOpenDm = backend.openDm;
  const pending = submitProjectAgentMessage({
    agent: { pubkey: AGENT_PUBKEY, isManaged: false, isActive: true },
    conversation: null,
    content: "tenant A repo context",
    mentionPubkeys: [AGENT_PUBKEY],
    relayScope: "wss://tenant-a.example",
    startAgent: () => {
      throw new Error("inactive relay agents are not startable");
    },
    openDm: async (input) => {
      const channel = await scopedOpenDm(input);
      // The switch lands after the DM was opened on tenant A but before the
      // message submit — the narrowest window Carl's finding names.
      backend.state.active = "wss://tenant-b.example";
      return channel;
    },
    send: backend.send,
  });

  await assert.rejects(pending, /active community changed/);
  // The DM was legitimately opened while tenant A was still active…
  assert.equal(backend.state.dmOpens.length, 1);
  assert.equal(backend.state.dmOpens[0].relay, "wss://tenant-a.example");
  // …but nothing was ever published anywhere.
  assert.deepEqual(backend.state.sends, []);
});

test("the captured scope rides every relay side effect of a first send", async () => {
  const backend = makeScopedBackend("wss://tenant-a.example");
  const result = await submitProjectAgentMessage({
    agent: { pubkey: AGENT_PUBKEY, isManaged: false, isActive: true },
    conversation: null,
    content: "opener",
    mentionPubkeys: [AGENT_PUBKEY],
    relayScope: "wss://tenant-a.example",
    startAgent: async () => {},
    openDm: backend.openDm,
    send: backend.send,
  });

  assert.equal(
    backend.state.dmOpens[0].input.expectedRelayUrl,
    "wss://tenant-a.example",
  );
  assert.equal(
    backend.state.sends[0].request.expectedRelayUrl,
    "wss://tenant-a.example",
  );
  // The opener is a thread root: no parent reference.
  assert.equal(backend.state.sends[0].request.parentEventId, undefined);
  assert.equal(result.channel.id, "dm-on-wss://tenant-a.example");
});

test("follow-ups reply to the opener so same-second id ordering cannot hide them", async () => {
  const backend = makeScopedBackend("wss://tenant-a.example");
  await submitProjectAgentMessage({
    agent: { pubkey: AGENT_PUBKEY, isManaged: false, isActive: true },
    conversation: { channel: EXISTING_DM, opener: OPENER },
    content: "follow-up in the opener's second",
    mentionPubkeys: [AGENT_PUBKEY],
    relayScope: "wss://tenant-a.example",
    startAgent: async () => {},
    openDm: () => {
      throw new Error("an existing conversation must reuse its channel");
    },
    send: backend.send,
  });

  const request = backend.state.sends[0].request;
  assert.equal(request.channelId, EXISTING_DM.id);
  assert.equal(request.parentEventId, OPENER.eventId);

  // Carl's exact-head probe: a same-second follow-up whose random id lands on
  // the rejected side of the id tiebreak (`e… > d…`). As an unreferenced root
  // it would vanish; as the reply the submit path now sends, it is admitted.
  const rejectedSideId = `e${"0".repeat(63)}`;
  const asUnreferencedRoot = {
    created_at: OPENER.createdAt,
    id: rejectedSideId,
    tags: [],
  };
  assert.equal(
    isAtOrAfterConversationOpener(asUnreferencedRoot, OPENER),
    false,
  );
  const asSentReply = {
    created_at: OPENER.createdAt,
    id: rejectedSideId,
    tags: [["e", OPENER.eventId, "", "reply"]],
  };
  assert.equal(isAtOrAfterConversationOpener(asSentReply, OPENER), true);
});
