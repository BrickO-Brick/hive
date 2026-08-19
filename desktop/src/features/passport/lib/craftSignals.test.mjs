import assert from "node:assert/strict";
import test from "node:test";

import {
  countCraftSignals,
  EMPTY_CRAFT_SIGNAL_COUNTS,
} from "./craftSignals.ts";

const AGENT = "a".repeat(64);
const OTHER = "b".repeat(64);
const PEER_AGENT = "c".repeat(64);
const AGENT_KEYS = new Set([AGENT, PEER_AGENT]);

function pullRequest(overrides = {}) {
  return {
    author: AGENT,
    comments: [],
    status: "Open",
    ...overrides,
  };
}

function comment(overrides = {}) {
  return {
    author: AGENT,
    isApproval: false,
    isChangeRequest: false,
    isInlineComment: false,
    ...overrides,
  };
}

function workItems({ issues = [], pullRequests = [] } = {}) {
  return {
    issues: { items: issues },
    pullRequests: { items: pullRequests },
  };
}

test("missing data or pubkey yields zero counts", () => {
  const zero = countCraftSignals(undefined, AGENT);
  assert.deepEqual(zero, EMPTY_CRAFT_SIGNAL_COUNTS);
  assert.deepEqual(countCraftSignals(workItems(), null), zero);
});

test("authored PRs split into merged and closed, keyed case-insensitively", () => {
  const counts = countCraftSignals(
    workItems({
      pullRequests: [
        {
          project: { id: "repo-1" },
          pullRequest: pullRequest({
            author: AGENT.toUpperCase(),
            status: "Merged",
          }),
        },
        {
          project: { id: "repo-1" },
          pullRequest: pullRequest({ status: "Closed" }),
        },
        {
          project: { id: "repo-1" },
          pullRequest: pullRequest({ status: "Open" }),
        },
        {
          project: { id: "repo-2" },
          pullRequest: pullRequest({ author: OTHER, status: "Merged" }),
        },
      ],
    }),
    AGENT,
  );
  assert.equal(counts.mergedPrCount, 1);
  assert.equal(counts.closedPrCount, 1);
  assert.equal(counts.repoCount, 1);
});

test("only review-weight comments on others' PRs count as reviews", () => {
  const counts = countCraftSignals(
    workItems({
      pullRequests: [
        {
          project: { id: "repo-2" },
          pullRequest: pullRequest({
            author: OTHER,
            comments: [
              comment({ isApproval: true }),
              comment({ isInlineComment: true }),
              comment(), // plain discussion — no review weight
              comment({ author: OTHER, isApproval: true }), // not the agent
            ],
          }),
        },
        {
          // Comments on the agent's own PR never count as reviews.
          project: { id: "repo-1" },
          pullRequest: pullRequest({
            comments: [comment({ isApproval: true })],
          }),
        },
      ],
    }),
    AGENT,
  );
  assert.equal(counts.reviewCount, 2);
  assert.equal(counts.repoCount, 2);
});

test("filed issues count and extend repo spread", () => {
  const counts = countCraftSignals(
    workItems({
      issues: [
        { project: { id: "repo-3" }, issue: { author: AGENT } },
        { project: { id: "repo-3" }, issue: { author: AGENT } },
        { project: { id: "repo-4" }, issue: { author: OTHER } },
      ],
    }),
    AGENT,
  );
  assert.equal(counts.issuesOpenedCount, 2);
  assert.equal(counts.repoCount, 1);
});

test("YOLO counts merged PRs with no review decision from anyone else", () => {
  const counts = countCraftSignals(
    workItems({
      pullRequests: [
        {
          project: { id: "repo-1" },
          pullRequest: pullRequest({
            createdAt: 1_000,
            status: "Merged",
            statusCreatedAt: 1_200,
          }),
        },
        {
          project: { id: "repo-1" },
          pullRequest: pullRequest({
            comments: [comment({ author: OTHER, isApproval: true })],
            createdAt: 1_000,
            status: "Merged",
            statusCreatedAt: 1_400,
          }),
        },
      ],
    }),
    AGENT,
  );
  assert.equal(counts.mergedPrCount, 2);
  assert.equal(counts.yoloMergeCount, 1);
});

test("Quickdraw counts authored PRs and issues closed within five minutes", () => {
  const counts = countCraftSignals(
    workItems({
      issues: [
        {
          project: { id: "repo-1" },
          issue: {
            assignees: [],
            author: AGENT,
            comments: [],
            createdAt: 1_000,
            status: "Done",
            updatedAt: 1_200,
          },
        },
        {
          project: { id: "repo-1" },
          issue: {
            assignees: [],
            author: AGENT,
            comments: [],
            createdAt: 1_000,
            status: "Done",
            updatedAt: 1_000 + 400,
          },
        },
      ],
      pullRequests: [
        {
          project: { id: "repo-1" },
          pullRequest: pullRequest({
            createdAt: 1_000,
            status: "Merged",
            statusCreatedAt: 1_240,
          }),
        },
      ],
    }),
    AGENT,
  );
  assert.equal(counts.quickdrawCount, 2);
});

test("pair and team-player counts require another community agent", () => {
  const counts = countCraftSignals(
    workItems({
      pullRequests: [
        {
          project: { id: "repo-2" },
          pullRequest: pullRequest({
            author: PEER_AGENT,
            comments: [comment({ isApproval: true })],
          }),
        },
        {
          project: { id: "repo-2" },
          pullRequest: pullRequest({
            author: OTHER,
            comments: [comment({ isInlineComment: true })],
          }),
        },
      ],
    }),
    AGENT,
    AGENT_KEYS,
  );
  assert.equal(counts.reviewCount, 2);
  assert.equal(counts.peerReviewCount, 1);
  assert.equal(counts.pairPrCount, 1);
});

test("issue follow-through counts done filings, help, and assigned work", () => {
  const counts = countCraftSignals(
    workItems({
      issues: [
        {
          project: { id: "repo-3" },
          issue: {
            assignees: [],
            author: AGENT,
            comments: [],
            createdAt: 1_000,
            status: "Done",
            updatedAt: 2_000,
          },
        },
        {
          project: { id: "repo-3" },
          issue: {
            assignees: [AGENT],
            author: OTHER,
            comments: [comment({ author: AGENT })],
            createdAt: 1_000,
            status: "Done",
            updatedAt: 2_000,
          },
        },
      ],
    }),
    AGENT,
  );
  assert.equal(counts.issueDoneCount, 1);
  assert.equal(counts.issueHelpCount, 1);
  assert.equal(counts.assignedDoneCount, 1);
});
