import assert from "node:assert/strict";
import test from "node:test";

import {
  projectReviewFilesChangedBody,
  retainLatestByKey,
  reviewDiffWorkspaceBranch,
} from "./projectReviewDisplay.ts";

test("retainLatestByKey keeps the previous value when shouldReplace is false", () => {
  const cache = { current: { key: "pr-1", value: { files: [1] } } };

  const retained = retainLatestByKey(
    cache,
    "pr-1",
    { files: [] },
    (next, previous) =>
      next.files.length > 0 ? true : previous.files.length === 0,
  );

  assert.deepEqual(retained, { files: [1] });
  assert.deepEqual(cache.current.value, { files: [1] });
});

test("retainLatestByKey takes a new key immediately", () => {
  const cache = { current: { key: "pr-1", value: { files: [1] } } };

  const retained = retainLatestByKey(
    cache,
    "pr-2",
    { files: [] },
    (next) => next.files.length > 0,
  );

  assert.deepEqual(retained, { files: [] });
});

test("review files stay mounted when a populated diff races an unavailable snapshot", () => {
  assert.equal(
    projectReviewFilesChangedBody({
      hasPopulatedDiff: true,
      hasSelectedPullRequest: true,
      repositoryUnavailable: true,
    }),
    "files",
  );
});

test("review files can show unavailable before a diff exists", () => {
  assert.equal(
    projectReviewFilesChangedBody({
      hasPopulatedDiff: false,
      hasSelectedPullRequest: true,
      repositoryUnavailable: true,
    }),
    "unavailable",
  );
});

test("review files render the panel for a selected review when the repo is available", () => {
  assert.equal(
    projectReviewFilesChangedBody({
      hasPopulatedDiff: false,
      hasSelectedPullRequest: true,
      repositoryUnavailable: false,
    }),
    "files",
  );
});

test("review diffs stay on the target branch, not the head or picker branch", () => {
  assert.equal(
    reviewDiffWorkspaceBranch({
      activeBranch: "variation/bees",
      defaultBranch: "main",
      pullRequest: { targetBranch: "main" },
    }),
    "main",
  );
  assert.equal(
    reviewDiffWorkspaceBranch({
      activeBranch: "variation/bees",
      defaultBranch: "main",
      pullRequest: { targetBranch: null },
    }),
    "main",
  );
  assert.equal(
    reviewDiffWorkspaceBranch({
      activeBranch: "variation/bees",
      defaultBranch: "main",
      pullRequest: null,
    }),
    "variation/bees",
  );
});
