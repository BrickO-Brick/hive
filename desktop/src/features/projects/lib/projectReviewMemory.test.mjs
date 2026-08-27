import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProjectReviewContextPrompt,
  MAX_PROJECT_REVIEW_CONTEXT_ITEMS,
  parseProjectReviewContextResult,
  PROJECT_REVIEW_CONTEXT_RESULT_MARKER,
  projectReviewContextStorageKey,
  readProjectReviewContextRun,
  writeProjectReviewContextRun,
} from "./projectReviewMemory.ts";

const scope = {
  relayUrl: "WSS://Relay.Example/",
  repoAddress: `30617:${"a".repeat(64)}:buzz`,
  reviewId: "B".repeat(64),
  signerPubkey: "C".repeat(64),
};

function storageFixture() {
  const entries = new Map();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
  };
}

test("review context state is scoped to relay, signer, repository, and review", () => {
  const key = projectReviewContextStorageKey(scope);
  assert.ok(key);
  assert.match(key, /^buzz\.projects\.review-context\.v1:/);
  assert.notEqual(
    key,
    projectReviewContextStorageKey({ ...scope, reviewId: "D".repeat(64) }),
  );
  assert.equal(
    projectReviewContextStorageKey({ ...scope, signerPubkey: null }),
    null,
  );
});

test("structured discovery results keep sourced prior art and channel conversations", () => {
  const result = parseProjectReviewContextResult(
    [
      "Research complete.",
      PROJECT_REVIEW_CONTEXT_RESULT_MARKER,
      JSON.stringify({
        request_id: "request-1",
        summary:
          "The existing boundary is deliberate, with a planned follow-up.",
        prior_art: [
          {
            title: "Keep review checks advisory",
            summary: "This review records why checks do not gate merges.",
            source_url: "https://github.com/block/buzz/pull/803",
          },
          {
            title: "Unsafe source",
            summary: "This must be omitted.",
            source_url: "javascript:alert(1)",
          },
        ],
        future_vision: [
          {
            title: "Make review history durable memory",
            summary: "The team wants outcomes connected to review rationale.",
            channel: "#engineering",
            source_url: `buzz://message?channel=channel-1&id=${"d".repeat(64)}`,
          },
          {
            title: "Not a conversation",
            summary: "A generic web page is not enough evidence here.",
            source_url: "https://example.com/roadmap",
          },
        ],
      }),
    ].join("\n"),
  );

  assert.deepEqual(result, {
    requestId: "request-1",
    summary: "The existing boundary is deliberate, with a planned follow-up.",
    priorArt: [
      {
        title: "Keep review checks advisory",
        summary: "This review records why checks do not gate merges.",
        sourceUrl: "https://github.com/block/buzz/pull/803",
      },
    ],
    futureVision: [
      {
        title: "Make review history durable memory",
        summary: "The team wants outcomes connected to review rationale.",
        channel: "engineering",
        sourceUrl: `buzz://message?channel=channel-1&id=${"d".repeat(64)}`,
      },
    ],
  });
});

test("discovery result parsing requires the marker and bounded arrays", () => {
  const references = Array.from(
    { length: MAX_PROJECT_REVIEW_CONTEXT_ITEMS + 3 },
    (_, index) => ({
      title: `Review ${index}`,
      summary: `Evidence ${index}`,
      source_url: `https://github.com/block/buzz/pull/${index + 1}`,
    }),
  );
  assert.equal(
    parseProjectReviewContextResult(
      JSON.stringify({
        summary: "No marker",
        prior_art: [],
        future_vision: [],
      }),
    ),
    null,
  );
  const result = parseProjectReviewContextResult(
    `${PROJECT_REVIEW_CONTEXT_RESULT_MARKER}\n${JSON.stringify({
      summary: "Bounded evidence",
      prior_art: references,
      future_vision: [],
    })}`,
  );
  assert.equal(result?.priorArt.length, MAX_PROJECT_REVIEW_CONTEXT_ITEMS);
});

test("context prompt requests previous reviews and future-looking Buzz evidence", () => {
  const prompt = buildProjectReviewContextPrompt({
    branchName: "feature/context",
    channelId: "dm-channel",
    commit: "abc123",
    projectName: "Buzz",
    repoAddress: scope.repoAddress,
    repoUrl: "https://github.com/block/buzz",
    requestId: "request-2",
    reviewId: scope.reviewId,
    reviewLink: `buzz://pr?id=${scope.reviewId}&owner=${"a".repeat(64)}&d=buzz`,
    reviewTitle: "Add project memory",
    targetBranch: "main",
  });

  assert.match(prompt, /earlier pull requests or reviews/i);
  assert.match(prompt, /project-linked Buzz channels and conversations/i);
  assert.match(prompt, /not as a merge gate/i);
  assert.match(prompt, /buzz:\/\/message\?channel=/);
  assert.match(prompt, new RegExp(PROJECT_REVIEW_CONTEXT_RESULT_MARKER));
  assert.match(prompt, /"request_id":"request-2"/);
});

test("only completed generated context is restored", () => {
  const storage = storageFixture();
  const key = projectReviewContextStorageKey(scope);
  writeProjectReviewContextRun(storage, key, {
    agentPubkey: "agent",
    status: "running",
  });
  assert.equal(readProjectReviewContextRun(storage, key), null);

  const completed = {
    agentPubkey: "agent",
    status: "completed",
    result: { summary: "Done", priorArt: [], futureVision: [] },
  };
  writeProjectReviewContextRun(storage, key, completed);
  assert.deepEqual(readProjectReviewContextRun(storage, key), completed);
});
