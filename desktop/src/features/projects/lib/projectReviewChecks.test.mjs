import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProjectReviewCheckPrompt,
  DEFAULT_PROJECT_REVIEW_CHECKS,
  parseProjectReviewCheckDiffEvent,
  parseProjectReviewCheckResult,
  PROJECT_REVIEW_CHECK_RESULT_MARKER,
  projectReviewChecksStorageKey,
  readProjectReviewCheckRuns,
  writeProjectReviewCheckRuns,
} from "./projectReviewChecks.mjs";

test("starter checks keep experience, correctness, patterns, history, and tests independent", () => {
  assert.deepEqual(
    DEFAULT_PROJECT_REVIEW_CHECKS.map((check) => check.id),
    [
      "interface",
      "code-correctness",
      "codebase-patterns",
      "historical-intent",
      "test-quality",
    ],
  );
});

test("historical intent check investigates precedent without treating it as a veto", () => {
  const check = DEFAULT_PROJECT_REVIEW_CHECKS.find(
    (candidate) => candidate.id === "historical-intent",
  );
  assert.ok(check);
  const instructions = check.instructions.join("\n");
  assert.match(instructions, /git blame and git log/);
  assert.match(instructions, /pull requests or review discussion/);
  assert.match(instructions, /clearly distinguish evidence from inference/);
  assert.match(instructions, /Do not reject a change merely because/);
});

test("review guidance is assigned to the check that owns the concern", () => {
  const instructionsFor = (id) => {
    const check = DEFAULT_PROJECT_REVIEW_CHECKS.find(
      (candidate) => candidate.id === id,
    );
    assert.ok(check);
    return check.instructions.join("\n");
  };

  assert.match(
    instructionsFor("code-correctness"),
    /security and authorization boundaries, concurrency, persistence, and compatibility/,
  );
  assert.match(
    instructionsFor("codebase-patterns"),
    /smallest safe implementation/,
  );
  assert.match(
    instructionsFor("test-quality"),
    /exact reviewed commit and working-tree state/,
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

test("parses competing proposal directions with exact diff references", () => {
  const firstDiffEventId = "d".repeat(64);
  const secondDiffEventId = "e".repeat(64);
  const result = parseProjectReviewCheckResult(
    `${PROJECT_REVIEW_CHECK_RESULT_MARKER}\n${JSON.stringify({
      request_id: "request-123",
      conclusion: "fix-recommended",
      summary: "Choose where the read boundary should live.",
      proposals: [
        {
          title: "Follow the rendered timeline",
          summary: "Only mark messages read once they are visible.",
          diff_event_id: firstDiffEventId,
        },
        {
          title: "Follow the loaded query",
          summary: "Treat loaded messages as read at the physical bottom.",
          diff_event_id: secondDiffEventId,
        },
      ],
      findings: [],
    })}`,
  );

  assert.deepEqual(result, {
    requestId: "request-123",
    conclusion: "fix-recommended",
    summary: "Choose where the read boundary should live.",
    proposals: [
      {
        title: "Follow the rendered timeline",
        summary: "Only mark messages read once they are visible.",
        diffEventId: firstDiffEventId,
      },
      {
        title: "Follow the loaded query",
        summary: "Treat loaded messages as read at the physical bottom.",
        diffEventId: secondDiffEventId,
      },
    ],
    findings: [],
  });
});

test("bounds proposal copy to two short sentences", () => {
  const result = parseProjectReviewCheckResult(`
${PROJECT_REVIEW_CHECK_RESULT_MARKER}
${JSON.stringify({
  request_id: "request-123",
  conclusion: "fix-recommended",
  summary: "Choose a read boundary.",
  proposals: [
    {
      title: "Use rendered rows",
      summary:
        "Keep unread state tied to what the user can see. This preserves the navigation signal. This implementation detail should not appear in the decision copy.",
      diff_event_id: "a".repeat(64),
    },
  ],
  findings: [],
})}
`);

  assert.equal(
    result?.proposals?.[0]?.summary,
    "Keep unread state tied to what the user can see. This preserves the navigation signal.",
  );
});

test("bounds the shared decision summary", () => {
  const result = parseProjectReviewCheckResult(`
${PROJECT_REVIEW_CHECK_RESULT_MARKER}
${JSON.stringify({
  request_id: "request-123",
  conclusion: "fix-recommended",
  summary:
    "Choose whether visibility or loaded state owns the read boundary. Both preserve valid behavior. This extra analysis belongs in the finding.",
  proposals: [],
  findings: [],
})}
`);

  assert.equal(
    result?.summary,
    "Choose whether visibility or loaded state owns the read boundary. Both preserve valid behavior.",
  );
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
  assert.equal(
    parseProjectReviewCheckResult(
      `${PROJECT_REVIEW_CHECK_RESULT_MARKER}\n${JSON.stringify({
        conclusion: "fix-recommended",
        summary: "Proposal references must be unique.",
        proposals: [
          {
            title: "First",
            summary: "First direction.",
            diff_event_id: "f".repeat(64),
          },
          {
            title: "Second",
            summary: "Second direction.",
            diff_event_id: "f".repeat(64),
          },
        ],
        findings: [],
      })}`,
    ),
    null,
  );
  assert.equal(
    parseProjectReviewCheckResult(
      `${PROJECT_REVIEW_CHECK_RESULT_MARKER}\n${JSON.stringify({
        conclusion: "fix-recommended",
        summary: "Every proposal needs a verified patch reference.",
        proposals: [
          {
            title: "Missing reference",
            summary: "This direction cannot be correlated to a patch.",
            diff_event_id: null,
          },
        ],
        findings: [],
      })}`,
    ),
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
  const input = {
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
  };
  const prompt = buildProjectReviewCheckPrompt(input);

  assert.match(prompt, /Review only; do not modify code/);
  assert.match(prompt, /Commit under review: abc123/);
  assert.match(prompt, /Code correctness/);
  assert.match(prompt, /security and authorization boundaries/);
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
  assert.match(prompt, /"proposals":\[/);
  assert.match(prompt, /countering viable direction/);
  assert.match(prompt, /two genuinely distinct proposal directions/);
  assert.match(prompt, /DECISION COPY CONTRACT/);
  assert.match(prompt, /no more than two short sentences and 240 characters/);
  assert.match(prompt, /implementation details, identifiers, evidence/);
  assert.match(prompt, /continuation of this review negotiation/);
  assert.match(prompt, /copy its exact 64-character event_id/);
  assert.match(prompt, new RegExp(PROJECT_REVIEW_CHECK_RESULT_MARKER));
  assert.doesNotMatch(prompt, /Superseded request id:/);

  const replacementPrompt = buildProjectReviewCheckPrompt({
    ...input,
    requestId: "request-456",
    supersededRequestId: "request-123",
    supersededEventId: "a".repeat(64),
  });
  assert.match(replacementPrompt, /INTERRUPT DIRECTIVE: This replacement/);
  assert.match(replacementPrompt, /Superseded request id: "request-123"/);
  assert.match(
    replacementPrompt,
    new RegExp(`Superseded event id: ${"a".repeat(64)}`),
  );
  assert.match(replacementPrompt, /do not publish its result/);
  assert.match(replacementPrompt, /does not cancel or combine any other/);
});

test("local check lifecycle is restored within its scope", () => {
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
  const runs = {
    interface: {
      agentPubkey: "agent",
      status: "completed",
      result: {
        request_id: "completed-request",
        conclusion: "approved",
        summary: "No material issues found.",
        diff_event_id: null,
        findings: [],
      },
    },
    "code-correctness": { agentPubkey: "agent", status: "running" },
    "codebase-patterns": {
      agentPubkey: "agent",
      status: "failed",
      error: "Agent unavailable.",
    },
  };
  writeProjectReviewCheckRuns(storage, first, runs);
  assert.deepEqual(readProjectReviewCheckRuns(storage, first), runs);
  assert.deepEqual(readProjectReviewCheckRuns(storage, second), {});
});
