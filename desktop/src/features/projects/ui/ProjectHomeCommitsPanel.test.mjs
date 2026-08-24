import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { JSDOM } from "jsdom";

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

after(() => dom.window.close());

function repository(id, name) {
  return {
    id,
    name,
    repoAddress: `30617:owner:${id}`,
    defaultBranch: "main",
  };
}

test("multi-repository commits remain visibly degraded when one repository fails", async () => {
  const { cleanup, render, screen } = await import("@testing-library/react");
  const { ProjectHomeCommitsPanel } = await import(
    "./ProjectHomeCommitsPanel.tsx"
  );
  const loadedRepository = repository("loaded", "Loaded");
  const failedRepository = repository("failed", "Failed");

  const React = await import("react");
  try {
    render(
      React.createElement(ProjectHomeCommitsPanel, {
        onSelectCommit: () => {},
        projectId: "project-1",
        pullRequests: [],
        results: [
          {
            error: null,
            isLoading: false,
            repository: loadedRepository,
            snapshot: {
              contributors: [],
              commits: [
                {
                  hash: "a".repeat(40),
                  shortHash: "aaaaaaa",
                  authorName: "Alice",
                  authorEmail: "alice@example.com",
                  timestamp: 2,
                  subject: "Loaded commit",
                },
              ],
            },
          },
          {
            error: new Error("unavailable"),
            isLoading: false,
            repository: failedRepository,
            snapshot: null,
          },
        ],
      }),
    );

    assert.match(
      screen.getByTestId("project-home-commits-degraded").textContent,
      /Showing commits from 1 of 2 repositories/,
    );
    assert.match(document.body.textContent, /Loaded commit/);
  } finally {
    cleanup();
  }
});
