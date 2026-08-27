import assert from "node:assert/strict";
import test from "node:test";

import { messageCollectionAction } from "./messageCollectionAction.ts";

const channelId = "channel-1";

test("a root event exposes only the thread Collection action", () => {
  assert.deepEqual(
    messageCollectionAction(channelId, {
      depth: 0,
      id: "root-1",
      rootId: null,
      tags: [],
    }),
    {
      menuLabel: "Add thread to Collection",
      reference: {
        type: "thread",
        channel_id: channelId,
        root_event_id: "root-1",
      },
      type: "thread",
    },
  );
});

test("a reply exposes only its direct message Collection action", () => {
  assert.deepEqual(
    messageCollectionAction(channelId, {
      depth: 1,
      id: "reply-1",
      rootId: "root-1",
      tags: [["e", "root-1", "", "root"]],
    }),
    {
      menuLabel: "Add message to Collection",
      reference: {
        type: "message",
        channel_id: channelId,
        event_id: "reply-1",
      },
      type: "message",
    },
  );
});

test("an explicit self root remains a thread action even when nested metadata is present", () => {
  assert.equal(
    messageCollectionAction(channelId, {
      depth: 1,
      id: "root-1",
      rootId: "root-1",
      tags: [["e", "root-1", "", "root"]],
    }).type,
    "thread",
  );
});
