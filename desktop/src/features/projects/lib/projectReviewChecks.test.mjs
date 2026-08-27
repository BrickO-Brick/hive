import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProjectReviewCheckPrompt,
  DEFAULT_PROJECT_REVIEW_CHECKS,
  parseProjectReviewCheckDiffEvent,
  parseProjectReviewCheckResult,
  parseProjectReviewChecksConfig,
  PROJECT_REVIEW_CHECK_RESULT_MARKER,
  projectReviewChecksStorageKey,
  readProjectReviewCheckRuns,
  writeProjectReviewCheckRuns,
} from "./projectReviewChecks.mjs";

test("starter checks cover interface, frontend, and test quality", () => {
  assert.deepEqual(
    DEFAULT_PROJECT_REVIEW_CHECKS.map((check) => check.id),
    ["interface", "frontend", "test-quality"],
  );
});

test("parses repository-owned YAML check definitions", () => {
  assert.deepEqual(
    parseProjectReviewChecksConfig(`
version: 1
checks:
  - id: architecture
    name: Architecture
    description: Checks module boundaries.
    instructions:
      - Compare changed dependencies with the architecture contract.
`),
    [
      {
        id: "architecture",
        name: "Architecture",
        description: "Checks module boundaries.",
        instructions: [
          "Compare changed dependencies with the architecture contract.",
        ],
      },
    ],
  );
});

test("rejects invalid or duplicate project check ids", () => {
  assert.throws(
    () =>
      parseProjectReviewChecksConfig(`
version: 1
checks:
  - id: frontend
    name: Frontend
    description: First.
    instructions: [Review it.]
  - id: frontend
    name: Frontend again
    description: Second.
    instructions: [Review it again.]
`),
    /Duplicate check id/,
  );
});

test("parses an approved structured agent result", () => {
  const result = parseProjectReviewCheckResult(`Analysis first.

${PROJECT_REVIEW_CHECK_RESULT_MARKER}
\`\`\`json
{"request_id":"request-123","conclusion":"approved","summary":"The change follows the contract.","findings":[]}
\`\`\``);

  assert.deepEqual(result, {
    requestId: "request-123",
    conclusion: "approved",
    summary: "The change follows the contract.",
    findings: [],
  });
});

test("normalizes a changes-requested result to fix-recommended", () => {
  const result = parseProjectReviewCheckResult(
    `${PROJECT_REVIEW_CHECK_RESULT_MARKER}\n${JSON.stringify({
      conclusion: "changes-requested",
      summary: "The empty state has no accessible name.",
      findings: ["Add an accessible label.", 42, "Cover it with a UI test."],
    })}`,
  );

  assert.deepEqual(result, {
    conclusion: "fix-recommended",
    summary: "The empty state has no accessible name.",
    findings: [
      {
        title: "Add an accessible label.",
        detail: null,
        file: null,
        line: null,
      },
      {
        title: "Cover it with a UI test.",
        detail: null,
        file: null,
        line: null,
      },
    ],
  });
});

test("parses structured findings with bounded source locations", () => {
  const diffEventId = "d".repeat(64);
  const result = parseProjectReviewCheckResult(
    `${PROJECT_REVIEW_CHECK_RESULT_MARKER}\n${JSON.stringify({
      conclusion: "fix-recommended",
      summary: "Two interface fixes are needed.",
      diff_event_id: diffEventId,
      findings: [
        {
          title: "Use the shared button primitive",
          detail: "The custom button misses the standard focus treatment.",
          file: "desktop/src/features/projects/ui/ProjectReviewChecks.tsx",
          line: 742,
        },
        {
          title: "Add an accessible name",
          detail: "Icon-only controls need an explicit label.",
          file: null,
          line: -1,
        },
      ],
    })}`,
  );

  assert.deepEqual(result, {
    diffEventId,
    conclusion: "fix-recommended",
    summary: "Two interface fixes are needed.",
    findings: [
      {
        title: "Use the shared button primitive",
        detail: "The custom button misses the standard focus treatment.",
        file: "desktop/src/features/projects/ui/ProjectReviewChecks.tsx",
        line: 742,
      },
      {
        title: "Add an accessible name",
        detail: "Icon-only controls need an explicit label.",
        file: null,
        line: null,
      },
    ],
  });
});

test("resolves only the exact agent diff for the reviewed repository and commit", () => {
  const eventId = "d".repeat(64);
  const agentPubkey = "a".repeat(64);
  const repoUrl = "https://github.com/block/buzz";
  const commit = "b".repeat(40);
  const event = {
    id: eventId,
    pubkey: agentPubkey,
    kind: 40008,
    content:
      "diff --git a/src/check.ts b/src/check.ts\n--- a/src/check.ts\n+++ b/src/check.ts\n@@ -1 +1 @@\n-old\n+new",
    tags: [
      ["repo", repoUrl],
      ["commit", commit],
      ["file", "src/check.ts"],
      ["description", "Review check request-123"],
    ],
  };

  assert.deepEqual(
    parseProjectReviewCheckDiffEvent(event, {
      eventId,
      agentPubkey,
      repoUrl,
      commit,
    }),
    {
      eventId,
      content: event.content,
      repoUrl,
      commitSha: commit,
      filePath: "src/check.ts",
      description: "Review check request-123",
      truncated: false,
    },
  );
  assert.equal(
    parseProjectReviewCheckDiffEvent(event, {
      eventId,
      agentPubkey: "c".repeat(64),
      repoUrl,
      commit,
    }),
    null,
  );
  assert.equal(
    parseProjectReviewCheckDiffEvent(event, {
      eventId,
      agentPubkey,
      repoUrl,
      commit: "e".repeat(40),
    }),
    null,
  );
});

test("does not treat ordinary agent prose as a completed check", () => {
  assert.equal(
    parseProjectReviewCheckResult(
      '{"conclusion":"approved","summary":"Missing marker"}',
    ),
    null,
  );
  assert.equal(
    parseProjectReviewCheckResult(
      `${PROJECT_REVIEW_CHECK_RESULT_MARKER}\n{"conclusion":"approved"}`,
    ),
    null,
  );
  assert.equal(
    parseProjectReviewCheckResult(
      `${PROJECT_REVIEW_CHECK_RESULT_MARKER}\n${JSON.stringify({
        conclusion: "fix-recommended",
        summary: "Malformed diff reference.",
        diff_event_id: "not-an-event-id",
        findings: [],
      })}`,
    ),
    null,
  );
  assert.equal(
    parseProjectReviewCheckResult(
      `${PROJECT_REVIEW_CHECK_RESULT_MARKER}\n${JSON.stringify({
        conclusion: "approved",
        summary: "Approved results cannot propose changes.",
        diff_event_id: "f".repeat(64),
        findings: [],
      })}`,
    ),
    null,
  );
});

test("builds a review-only prompt pinned to the exact commit", () => {
  const prompt = buildProjectReviewCheckPrompt({
    check: DEFAULT_PROJECT_REVIEW_CHECKS[1],
    projectName: "Buzz",
    repoAddress: "30617:owner:buzz",
    repoUrl: "https://github.com/block/buzz",
    channelId: "check-channel",
    reviewId: "review-event",
    reviewLink: "buzz://pr?id=review-event",
    reviewTitle: "Add checks",
    requestId: "request-123",
    commit: "abc123",
    branchName: "checks",
    targetBranch: "main",
  });

  assert.match(prompt, /Review only; do not modify code/);
  assert.match(prompt, /Commit under review: abc123/);
  assert.match(prompt, /Frontend quality/);
  assert.match(prompt, /"request_id":"request-123"/);
  assert.match(prompt, /Echo request_id exactly/);
  assert.match(prompt, /process every event independently/);
  assert.match(prompt, /answering only the last event/);
  assert.match(prompt, /exact 64-character Event ID enclosing this request/);
  assert.match(
    prompt,
    /buzz messages send --channel "check-channel" --content - --reply-to <THIS_REQUEST_EVENT_ID>/,
  );
  assert.match(prompt, /buzz messages send-diff/);
  assert.match(prompt, /send-diff[^\n]+--reply-to <THIS_REQUEST_EVENT_ID>/);
  assert.match(prompt, /"diff_event_id":null/);
  assert.match(prompt, /copy its exact 64-character event_id/);
  assert.match(prompt, new RegExp(PROJECT_REVIEW_CHECK_RESULT_MARKER));
});

test("local check state is isolated by relay, signer, repo, and review", () => {
  const base = {
    relayUrl: "wss://relay.example",
    signerPubkey: "A".repeat(64),
    repoAddress: "30617:owner:buzz",
    reviewId: "review-one",
  };
  const first = projectReviewChecksStorageKey(base);
  const second = projectReviewChecksStorageKey({
    ...base,
    signerPubkey: "B".repeat(64),
  });
  assert.notEqual(first, second);

  const entries = new Map();
  const storage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
  };
  const runs = { frontend: { agentPubkey: "agent", status: "idle" } };
  writeProjectReviewCheckRuns(storage, first, runs);
  assert.deepEqual(readProjectReviewCheckRuns(storage, first), runs);
  assert.deepEqual(readProjectReviewCheckRuns(storage, second), {});
});
