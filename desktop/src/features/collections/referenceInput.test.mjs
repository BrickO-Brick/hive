import assert from "node:assert/strict";
import test from "node:test";

import { collectionMemberNavigationTarget } from "./memberNavigation.ts";
import { parseCollectionReferenceInput } from "./referenceInput.ts";

const owner = "a".repeat(64);
const eventId = "b".repeat(64);
const repository = `30617:${owner}:buzz`;

test("parses repository, task, note, and external inputs", () => {
  assert.deepEqual(
    parseCollectionReferenceInput({
      coordinate: repository,
      eventId: "",
      type: "repository",
      url: "",
    }),
    { ok: true, reference: { type: "repository", coordinate: repository } },
  );
  assert.equal(
    parseCollectionReferenceInput({
      coordinate: repository,
      eventId,
      type: "task",
      url: "",
    }).ok,
    true,
  );
  assert.equal(
    parseCollectionReferenceInput({
      coordinate: `30023:${owner}:design`,
      eventId: "",
      type: "note",
      url: "",
    }).ok,
    true,
  );
  assert.equal(
    parseCollectionReferenceInput({
      coordinate: "",
      eventId: "",
      type: "external",
      url: "https://example.com/brief",
    }).ok,
    true,
  );
});

test("resolves supported references and leaves notes inert", () => {
  assert.equal(
    collectionMemberNavigationTarget({
      type: "repository",
      coordinate: repository,
    })?.kind,
    "entity",
  );
  assert.equal(
    collectionMemberNavigationTarget({
      type: "task",
      repository,
      event_id: eventId,
    })?.kind,
    "entity",
  );
  assert.equal(
    collectionMemberNavigationTarget({
      type: "note",
      coordinate: `30023:${owner}:design`,
    }),
    null,
  );
});
