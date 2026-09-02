import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGitHubPublicationReceipt,
  buildUserDraftPullRequestBody,
  defaultUserPublicationBranch,
} from "./githubUserPublication.ts";

const proposal = {
  id: "BrickO-Brick/hive:base",
  version: 3,
  repository: {
    owner: "BrickO-Brick",
    name: "hive",
    url: "https://github.com/BrickO-Brick/hive",
  },
  baseCommit: "a".repeat(40),
  resultTree: "b".repeat(40),
  targetBranch: "main",
  summary: "Keep GitHub publication under the user identity.",
  files: [{ path: "publisher.ts", additions: 4, deletions: 1 }],
  scenarios: [
    {
      id: "TS-1",
      title: "Publication identity test",
      command: "pnpm test",
      given: [],
      when: [],
      expectedOutcomes: ["Tests pass"],
      status: "passed",
      testedTree: "b".repeat(40),
      expected: "Tests pass",
      actual: "Exit 0",
      evidence: ["4 passed"],
    },
  ],
  status: "approved",
  approval: {
    approverPubkey: "c".repeat(64),
    approvedAt: 1,
    proposalVersion: 3,
    resultTree: "b".repeat(40),
    scope: "commit",
  },
};

const commit = {
  branch: "users/bricko/keep-publication-user-owned",
  commit: "d".repeat(40),
  resultTree: "b".repeat(40),
  authorName: "BrickO User",
  authorEmail: "user@example.test",
  signedOffBy: "BrickO User <user@example.test>",
  checkedOut: true,
  indexSynchronized: true,
  warning: null,
};

test("default branch is namespaced to the signed-in user and safely slugged", () => {
  assert.equal(
    defaultUserPublicationBranch({
      githubLogin: "BrickO-Owner",
      repositoryName: "hive",
      summary: "Fix release / approval!",
    }),
    "users/bricko-owner/fix-release-approval",
  );
});

test("draft PR body carries exact-tree evidence and withholds release", () => {
  const body = buildUserDraftPullRequestBody({ proposal, commit });
  assert.match(body, /## Development Goal/);
  assert.match(body, new RegExp(proposal.resultTree));
  assert.match(body, new RegExp(commit.commit));
  assert.match(body, /4 passed/);
  assert.match(
    body,
    /Release, deployment, merge, and promotion are not authorized/,
  );
});

test("publication receipt binds actor and PR while keeping release false", () => {
  const receipt = buildGitHubPublicationReceipt({
    proposal,
    publication: {
      branch: commit.branch,
      commit: commit.commit,
      baseBranch: "main",
      githubLogin: "bricko-owner",
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/BrickO-Brick/hive/pull/42",
      draft: true,
      branchPushed: true,
    },
  });
  assert.match(receipt, /@bricko-owner/);
  assert.match(receipt, /"remotePublicationAuthorized": true/);
  assert.match(receipt, /"releaseAuthorized": false/);
});
