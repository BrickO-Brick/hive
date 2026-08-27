import assert from "node:assert/strict";
import test from "node:test";

import {
  collectionMemberMatches,
  collectionReferenceIdentity,
} from "./memberDisplay.ts";

test("collection reference identity preserves the useful locator", () => {
  assert.equal(
    collectionReferenceIdentity({
      type: "external",
      url: "https://example.com/spec",
    }),
    "https://example.com/spec",
  );
  assert.equal(
    collectionReferenceIdentity({
      type: "message",
      channel_id: "channel-a",
      event_id: "event-b",
    }),
    "channel-a · event-b",
  );
});

test("collection member filter searches labels and respects type", () => {
  const member = {
    id: "member-1",
    collection_id: "collection-1",
    reference: { type: "external", url: "https://example.com/spec" },
    label: "Design brief",
    added_at: "2026-08-27T14:00:00Z",
  };
  assert.equal(collectionMemberMatches(member, "brief", "all"), true);
  assert.equal(
    collectionMemberMatches(member, "example.com", "external"),
    true,
  );
  assert.equal(collectionMemberMatches(member, "brief", "channel"), false);
});
