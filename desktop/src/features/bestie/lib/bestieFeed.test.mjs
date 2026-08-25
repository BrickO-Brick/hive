import assert from "node:assert/strict";
import test from "node:test";

import {
  bestieItemSourceLabel,
  filterBestieFeedItems,
  getVisibleBestieFeedItems,
  reduceBestiePanelState,
  sortBestieFeedItems,
} from "./bestieFeed.ts";

const item = (overrides = {}) => ({
  avatarUrl: null,
  categories: ["activity"],
  categoryLabel: "Activity",
  channelLabel: "general",
  conversationId: "conversation",
  fullTimestampLabel: "Aug 25, 2026, 12:00 PM",
  groupItems: [],
  id: "item",
  isActionRequired: false,
  item: {
    category: "activity",
    channelId: "channel",
    channelName: "general",
    content: "Actual Buzz content",
    createdAt: 10,
    id: "item",
    kind: 9,
    pubkey: "a".repeat(64),
    tags: [],
  },
  latestActivityAt: 10,
  mentionNames: [],
  preview: "Actual Buzz content",
  senderLabel: "Alice",
  subject: "Channel update",
  timestampLabel: "12:00 PM",
  unreadCount: 0,
  ...overrides,
});

test("sortBestieFeedItems ranks actual categories, then recency and id", () => {
  const items = [
    item({ id: "activity", latestActivityAt: 30 }),
    item({
      categories: ["mention"],
      id: "mention",
      latestActivityAt: 10,
    }),
    item({ id: "b", isActionRequired: true, latestActivityAt: 20 }),
    item({ id: "a", isActionRequired: true, latestActivityAt: 20 }),
  ];

  assert.deepEqual(
    sortBestieFeedItems(items).map(({ id }) => id),
    ["a", "b", "mention", "activity"],
  );
  assert.equal(items[0].id, "activity");
});

test("filterBestieFeedItems derives views from real Inbox categories", () => {
  const items = [
    item({ id: "message" }),
    item({ id: "task", isActionRequired: true }),
    item({ categories: ["agent_activity"], id: "agent" }),
  ];

  assert.deepEqual(
    filterBestieFeedItems(items, "messages").map(({ id }) => id),
    ["message"],
  );
  assert.deepEqual(
    filterBestieFeedItems(items, "tasks").map(({ id }) => id),
    ["task", "agent"],
  );
});

test("getVisibleBestieFeedItems hides only active local snoozes", () => {
  const items = [item({ id: "active" }), item({ id: "expired" })];
  assert.deepEqual(
    getVisibleBestieFeedItems(items, { active: 200, expired: 99 }, 100).map(
      ({ id }) => id,
    ),
    ["expired"],
  );
});

test("bestieItemSourceLabel uses only source metadata with a neutral fallback", () => {
  assert.equal(bestieItemSourceLabel(item()), "general");
  assert.equal(
    bestieItemSourceLabel(
      item({ channelLabel: null, item: { ...item().item, channelName: "" } }),
    ),
    "Buzz",
  );
});

test("reduceBestiePanelState keeps only one floating panel open", () => {
  const reply = reduceBestiePanelState(
    { mode: "closed" },
    { itemId: "message", type: "open-reply" },
  );
  assert.deepEqual(reply, { itemId: "message", mode: "reply" });
  assert.deepEqual(
    reduceBestiePanelState(reply, { itemId: "pr", type: "open-chat" }),
    { itemId: "pr", mode: "chat" },
  );
  assert.deepEqual(reduceBestiePanelState(reply, { type: "close" }), {
    mode: "closed",
  });
});
