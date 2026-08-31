import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProjectRelatedChannelRevisionTemplate,
  removeProjectRelatedChannel,
} from "./projectRelatedChannelRevision.ts";

const HOME = "11111111-1111-4111-8111-111111111111";
const RELATED = "22222222-2222-4222-8222-222222222222";
const OWNER = "a".repeat(64);

function project(overrides = {}) {
  return {
    effectiveRevisionId: "b".repeat(64),
    legacy: false,
    projectAddress: `30621:${OWNER}:buzz`,
    projectChannelId: HOME,
    relatedChannelIds: [],
    ...overrides,
  };
}

test("buildProjectRelatedChannelRevisionTemplate builds add and remove CAS operations", () => {
  assert.deepEqual(
    buildProjectRelatedChannelRevisionTemplate(
      project(),
      RELATED,
      "add-related-channel",
    ),
    {
      kind: 1622,
      content: "",
      tags: [
        ["a", `30621:${OWNER}:buzz`],
        ["e", "b".repeat(64)],
        ["op", "add-related-channel"],
        ["channel", RELATED],
      ],
    },
  );
  assert.equal(
    buildProjectRelatedChannelRevisionTemplate(
      project({ relatedChannelIds: [RELATED] }),
      RELATED,
      "remove-related-channel",
    ).tags[2][1],
    "remove-related-channel",
  );
});

test("buildProjectRelatedChannelRevisionTemplate rejects stale and invalid mutations", () => {
  assert.throws(
    () =>
      buildProjectRelatedChannelRevisionTemplate(
        project({ effectiveRevisionId: undefined }),
        RELATED,
        "add-related-channel",
      ),
    /Refresh/,
  );
  assert.throws(
    () =>
      buildProjectRelatedChannelRevisionTemplate(
        project(),
        HOME,
        "add-related-channel",
      ),
    /home channel/,
  );
  assert.throws(
    () =>
      buildProjectRelatedChannelRevisionTemplate(
        project({ relatedChannelIds: [RELATED] }),
        RELATED,
        "add-related-channel",
      ),
    /already related/,
  );
});

test("removeProjectRelatedChannel publishes a remove revision and advances local state", async () => {
  const calls = [];
  const updated = await removeProjectRelatedChannel(
    project({ relatedChannelIds: [RELATED] }),
    RELATED,
    {
      signEvent: async (template) => ({
        ...template,
        id: "c".repeat(64),
        pubkey: OWNER,
        created_at: 123,
      }),
      publishEvent: async (...args) => calls.push(args),
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].tags[2][1], "remove-related-channel");
  assert.deepEqual(updated.relatedChannelIds, []);
  assert.equal(updated.effectiveRevisionId, "c".repeat(64));
});
