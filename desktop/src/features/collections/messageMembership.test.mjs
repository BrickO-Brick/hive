import assert from "node:assert/strict";
import test from "node:test";

import { collectionReferencesForMessage } from "./messageMembership.ts";

const channelId = "channel-1";

test("a thread root exposes its exact message and thread identities", () => {
  assert.deepEqual(
    collectionReferencesForMessage(channelId, {
      depth: 0,
      id: "root-1",
      rootId: null,
      tags: [],
    }),
    [
      { type: "message", channel_id: channelId, event_id: "root-1" },
      { type: "thread", channel_id: channelId, root_event_id: "root-1" },
    ],
  );
});

test("a thread reply exposes only its direct message identity", () => {
  assert.deepEqual(
    collectionReferencesForMessage(channelId, {
      depth: 1,
      id: "reply-1",
      rootId: "root-1",
      tags: [["e", "root-1", "", "root"]],
    }),
    [{ type: "message", channel_id: channelId, event_id: "reply-1" }],
  );
});
