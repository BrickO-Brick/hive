import assert from "node:assert/strict";
import test from "node:test";

import { submitMessageEdit } from "./submitMessageEdit.ts";

const UNRESOLVED_USER = "b".repeat(64);

function baseOptions(
  save,
  {
    content = "hello @Missing User",
    mentionText = content,
    editTarget = {
      mentionRefs: [],
      unresolvedMentionPubkeys: [UNRESOLVED_USER],
    },
    getMentionRefs = () => [],
  } = {},
) {
  return {
    clearComposer: () => {},
    content,
    mentionText,
    customEmoji: [],
    editTarget,
    editTargetId: "event-id",
    extractMentionPubkeys: () => [],
    getMentionRefs,
    ownerPubkey: "a".repeat(64),
    pendingImeta: [],
    queuedAttachments: [],
    restoreComposer: () => {},
    restoreMentionRefs: () => {},
    revalidateMentionPubkeys: async (pubkeys) => [...pubkeys],
    setDeferredUploadPending: () => {},
    setUploadError: () => {},
    shouldRestoreComposer: () => true,
    spoileredAttachmentUrls: new Set(),
    save,
  };
}

test("edit save emits unresolved identities as non-notifying mention references", async () => {
  let saved;
  await submitMessageEdit(
    baseOptions(async (content, tags, mentionPubkeys, eventId) => {
      saved = { content, tags, mentionPubkeys, eventId };
    }),
  );

  assert.deepEqual(saved, {
    content: "hello @Missing User",
    tags: [["mention", UNRESOLVED_USER]],
    mentionPubkeys: [],
    eventId: "event-id",
  });
});

test("edit save uses edit-target refs that resolve after edit-open", async () => {
  let saved;
  const resolvedRef = {
    displayName: "Missing User",
    isAgent: false,
    pubkey: UNRESOLVED_USER,
  };
  await submitMessageEdit(
    baseOptions(
      async (content, tags, mentionPubkeys, eventId) => {
        saved = { content, tags, mentionPubkeys, eventId };
      },
      {
        editTarget: {
          mentionRefs: [resolvedRef],
          unresolvedMentionPubkeys: [],
        },
        getMentionRefs: () => [resolvedRef],
      },
    ),
  );

  assert.deepEqual(saved, {
    content: "hello @Missing User",
    tags: [["mention", UNRESOLVED_USER]],
    mentionPubkeys: [],
    eventId: "event-id",
  });
});

test("edit save drops a stale duplicate-name identity without legacy fallback", async () => {
  const first = "1".repeat(64);
  const staleLastSelected = "2".repeat(64);
  let saved;

  await submitMessageEdit({
    ...baseOptions(
      async (content, tags, mentionPubkeys, eventId) => {
        saved = { content, tags, mentionPubkeys, eventId };
      },
      {
        content: "@Will",
        mentionText: "@Will",
        editTarget: {
          mentionRefs: [
            {
              displayName: "Will",
              isAgent: false,
              offset: 0,
              pubkey: first,
            },
            {
              displayName: "Will",
              isAgent: false,
              offset: 10,
              pubkey: staleLastSelected,
            },
          ],
          unresolvedMentionPubkeys: [],
        },
        getMentionRefs: () => [
          {
            displayName: "Will",
            isAgent: false,
            offset: 0,
            pubkey: first,
          },
        ],
      },
    ),
    extractMentionPubkeys: () => [first],
  });

  assert.deepEqual(saved, {
    content: "@Will",
    tags: [["mention", first]],
    mentionPubkeys: [],
    eventId: "event-id",
  });
});

test("edit save revalidates added mentions immediately before save", async () => {
  const agent = "c".repeat(64);
  const calls = [];
  await submitMessageEdit({
    ...baseOptions(async (_content, _tags, mentionPubkeys) => {
      calls.push(["save", mentionPubkeys]);
    }),
    content: "hello @Agent",
    mentionText: "hello @Agent",
    editTarget: {
      mentionRefs: [],
      unresolvedMentionPubkeys: [],
    },
    extractMentionPubkeys: (content) =>
      content.includes("@Agent") ? [agent] : [],
    revalidateMentionPubkeys: async (pubkeys) => {
      calls.push(["revalidate", pubkeys]);
      return [];
    },
  });

  assert.deepEqual(calls, [
    ["revalidate", [agent]],
    ["save", []],
  ]);
});

test("edit diff extracts current occurrence state once", async () => {
  const existing = "e".repeat(64);
  const added = "f".repeat(64);
  const extracted = [];

  await submitMessageEdit({
    ...baseOptions(async () => {}),
    content: "@Will @Will",
    mentionText: "@Will @Will",
    editTarget: {
      mentionRefs: [
        {
          displayName: "Will",
          isAgent: false,
          offset: 0,
          pubkey: existing,
        },
      ],
      unresolvedMentionPubkeys: [],
    },
    extractMentionPubkeys: (content) => {
      extracted.push(content);
      return [existing, added];
    },
    getMentionRefs: () => [
      { displayName: "Will", isAgent: false, offset: 0, pubkey: existing },
      { displayName: "Will", isAgent: false, offset: 6, pubkey: added },
    ],
    revalidateMentionPubkeys: async (pubkeys) => {
      assert.deepEqual(pubkeys, [added]);
      return pubkeys;
    },
  });

  assert.deepEqual(extracted, ["@Will @Will"]);
});

test("edit upload pause revalidates revoked mentions only after upload completes", async () => {
  const agent = "d".repeat(64);
  const calls = [];
  let completeUpload;
  await submitMessageEdit({
    ...baseOptions(async (_content, _tags, mentionPubkeys) => {
      calls.push(["save", mentionPubkeys]);
    }),
    content: "hello @Agent",
    mentionText: "hello @Agent",
    editTarget: {
      mentionRefs: [],
      unresolvedMentionPubkeys: [],
    },
    extractMentionPubkeys: (content) =>
      content.includes("@Agent") ? [agent] : [],
    queuedAttachments: [
      {
        file: new File(["image"], "image.png", { type: "image/png" }),
        id: 1,
        spoilered: false,
      },
    ],
    enqueueUpload: ({ onComplete }) => {
      completeUpload = () => onComplete([], new AbortController().signal);
      return {};
    },
    revalidateMentionPubkeys: async (pubkeys) => {
      calls.push(["revalidate", pubkeys]);
      return [];
    },
  });

  assert.deepEqual(calls, []);
  await completeUpload();
  assert.deepEqual(calls, [
    ["revalidate", [agent]],
    ["save", []],
  ]);
});
