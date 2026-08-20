import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

import { buildProjectDetailAgentContext } from "../lib/projectDetailAgentContext.ts";
import { projectDetailSelectionItem } from "../lib/projectDetailSelectionItem.ts";
import { reviewDiffWorkspaceBranch } from "../lib/projectReviewDisplay.ts";
import { buildProjectDetailCrumbs } from "./useProjectDetailCrumbs.ts";

const OWNER = "a".repeat(64);
const REVIEW_A_ID = "b".repeat(64);

const repository = {
  id: `${OWNER}:buzz`,
  cloneUrls: ["https://example.com/buzz.git"],
  defaultBranch: "main",
  channelId: "trusted-repository-channel",
  name: "buzz",
  repoAddress: `30617:${OWNER}:buzz`,
};

const reviewA = {
  id: REVIEW_A_ID,
  title: "Ship the retained review",
  author: "alice",
  status: "Open",
  branchName: "feature-a",
  targetBranch: "main",
  cloneUrls: repository.cloneUrls,
  repoAddress: repository.repoAddress,
  channelId: "forged-origin-channel",
};

const noop = () => {};

function productionConsumers({ activeRepoPullRequest, selectedPullRequest }) {
  const crumbs = buildProjectDetailCrumbs({
    activeTab: "prs",
    commit: null,
    issue: null,
    pullRequest: selectedPullRequest,
    setRequestedTab: noop,
    setSelectedCommitHash: noop,
    setSelectedIssueId: noop,
    setSelectedPullRequestId: noop,
    setTabsResetKey: noop,
  });
  const contextItem = projectDetailSelectionItem({
    projectChannelId: "trusted-project-channel",
    projectId: "project-id",
    pullRequest: selectedPullRequest,
    repository,
  });
  const agent = buildProjectDetailAgentContext({
    activeTab: "prs",
    branch: "feature-a",
    project: { name: "buzz" },
    repository: {
      name: repository.name,
      repoAddress: repository.repoAddress,
    },
    source: "remote",
    workItems: [null, null, selectedPullRequest],
  });
  return {
    agentReviewId: agent.workItem?.id ?? null,
    crumbTitle: crumbs.activeWorkItemCrumb?.title ?? null,
    contextId: contextItem?.id ?? null,
    diffQueryId: activeRepoPullRequest?.id ?? null,
    diffWorkspaceBranch: reviewDiffWorkspaceBranch({
      activeBranch: "feature-a",
      defaultBranch: repository.defaultBranch,
      pullRequest: activeRepoPullRequest,
    }),
  };
}

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

let hookModule;
before(async () => {
  hookModule = await import("./useRetainedProjectGitViews.ts");
});

async function renderSelection(initialProps) {
  const { renderHook } = await import("@testing-library/react");
  return renderHook(
    (props) => hookModule.useRetainedPullRequestSelection(props),
    { initialProps },
  );
}

test("selected review chrome and diff query stay aligned across fetch phases", async () => {
  const populated = {
    activeBranch: "feature-a",
    isFetching: false,
    pullRequests: [reviewA],
    repository,
    selectedPullRequestId: REVIEW_A_ID,
  };
  const { rerender, result } = await renderSelection(populated);

  const populatedConsumers = productionConsumers(result.current);
  assert.equal(result.current.selectedPullRequest, reviewA);
  assert.equal(result.current.activeRepoPullRequest, reviewA);
  assert.deepEqual(populatedConsumers, {
    agentReviewId: REVIEW_A_ID,
    crumbTitle: "Ship the retained review",
    contextId: `review:${REVIEW_A_ID}`,
    diffQueryId: REVIEW_A_ID,
    diffWorkspaceBranch: "main",
  });

  rerender({
    ...populated,
    isFetching: true,
    pullRequests: [],
  });
  const fetchingConsumers = productionConsumers(result.current);
  assert.equal(result.current.selectedPullRequest, reviewA);
  assert.equal(
    result.current.selectedPullRequest,
    result.current.activeRepoPullRequest,
  );
  assert.deepEqual(fetchingConsumers, populatedConsumers);

  rerender({
    ...populated,
    isFetching: false,
    pullRequests: [],
  });
  const completedConsumers = productionConsumers(result.current);
  assert.equal(result.current.selectedPullRequest, null);
  assert.equal(result.current.activeRepoPullRequest, null);
  assert.deepEqual(completedConsumers, {
    agentReviewId: null,
    crumbTitle: null,
    contextId: null,
    diffQueryId: null,
    diffWorkspaceBranch: "feature-a",
  });
});
