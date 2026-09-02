import assert from "node:assert/strict";
import test from "node:test";

import {
  addChangeProposalScenario,
  approveChangeProposal,
  buildChangeProposalApprovalMessage,
  createChangeProposal,
  markChangeProposalReady,
  recordTestScenarioResult,
  reviseChangeProposal,
  startTestScenario,
  updateChangeProposalScenario,
} from "./changeProposal.ts";

const BASE = "a".repeat(40);
const TREE_V1 = "b".repeat(40);
const TREE_V2 = "c".repeat(40);
const PUBKEY = "d".repeat(64);

function proposal() {
  return createChangeProposal({
    id: "CP-104",
    repository: {
      owner: "BrickO-Brick",
      name: "hive",
      url: "https://github.com/BrickO-Brick/hive",
    },
    baseCommit: BASE,
    resultTree: TREE_V1,
    targetBranch: "feature/human-publication",
    summary: "Keep GitHub publication under the user identity.",
    files: [{ path: "publisher.ts", additions: 20, deletions: 4 }],
    scenarios: [
      {
        id: "TS-27",
        title: "Expired GitHub session",
        command: "gh auth status",
        given: ["The local GitHub session has expired"],
        when: ["The user requests publication"],
        expectedOutcomes: ["No remote branch is created"],
      },
    ],
  });
}

function passScenario(candidate) {
  const running = startTestScenario(candidate, {
    expectedVersion: candidate.version,
    scenarioId: "TS-27",
    resultTree: candidate.resultTree,
  });
  return recordTestScenarioResult(running, {
    expectedVersion: running.version,
    scenarioId: "TS-27",
    resultTree: running.resultTree,
    status: "passed",
    expected: "No branch or PR exists.",
    actual: "No branch or PR exists.",
    evidence: ["integration test exit code 0"],
  });
}

test("approval is bound to the exact passing result tree", () => {
  const passing = passScenario(proposal());
  const ready = markChangeProposalReady(passing, passing.version);
  const approved = approveChangeProposal(ready, {
    expectedVersion: ready.version,
    resultTree: TREE_V1,
    approverPubkey: PUBKEY,
    approvedAt: 1_788_225_200,
    scope: "commit",
  });
  assert.equal(approved.status, "approved");
  assert.deepEqual(approved.approval, {
    approverPubkey: PUBKEY,
    approvedAt: 1_788_225_200,
    proposalVersion: 1,
    resultTree: TREE_V1,
    scope: "commit",
  });
});

test("a code revision invalidates prior tests and approval readiness", () => {
  const ready = markChangeProposalReady(passScenario(proposal()), 1);
  const revised = reviseChangeProposal(ready, {
    expectedVersion: 1,
    resultTree: TREE_V2,
    files: [{ path: "publisher.ts", additions: 24, deletions: 4 }],
  });
  assert.equal(revised.version, 2);
  assert.equal(revised.status, "draft");
  assert.equal(revised.approval, null);
  assert.equal(revised.scenarios[0].status, "stale");
  assert.throws(
    () => markChangeProposalReady(revised, 2),
    /not passing for the exact result tree/,
  );
});

test("stale async test results cannot overwrite a newer proposal", () => {
  const running = startTestScenario(proposal(), {
    expectedVersion: 1,
    scenarioId: "TS-27",
    resultTree: TREE_V1,
  });
  const revised = reviseChangeProposal(running, {
    expectedVersion: 1,
    resultTree: TREE_V2,
    files: [{ path: "publisher.ts", additions: 22, deletions: 4 }],
  });
  assert.throws(
    () =>
      recordTestScenarioResult(revised, {
        expectedVersion: 1,
        scenarioId: "TS-27",
        resultTree: TREE_V1,
        status: "passed",
        expected: "No remote mutation",
        actual: "No remote mutation",
        evidence: [],
      }),
    /version moved from 1 to 2/,
  );
});

test("failed scenarios block readiness", () => {
  const running = startTestScenario(proposal(), {
    expectedVersion: 1,
    scenarioId: "TS-27",
    resultTree: TREE_V1,
  });
  const failed = recordTestScenarioResult(running, {
    expectedVersion: 1,
    scenarioId: "TS-27",
    resultTree: TREE_V1,
    status: "failed",
    expected: "No branch exists",
    actual: "A branch remained",
    evidence: ["remote ref observed"],
  });
  assert.throws(
    () => markChangeProposalReady(failed, 1),
    /not passing for the exact result tree/,
  );
});

test("editing a scenario invalidates only that scenario evidence", () => {
  const passing = passScenario(proposal());
  const added = addChangeProposalScenario(passing, {
    expectedVersion: 1,
    scenario: {
      id: "TS-28",
      title: "Unit tests",
      command: "pnpm test",
      given: [],
      when: ["The suite runs"],
      expectedOutcomes: ["All focused tests pass"],
    },
  });
  assert.equal(added.version, 2);
  assert.equal(added.scenarios[0].status, "passed");
  const updated = updateChangeProposalScenario(added, {
    expectedVersion: 2,
    scenarioId: "TS-28",
    title: "Focused tests",
    command: "pnpm test --filter proposal",
    expectedOutcomes: ["Focused tests pass"],
  });
  assert.equal(updated.version, 3);
  assert.equal(updated.scenarios[0].status, "passed");
  assert.equal(updated.scenarios[1].status, "planned");
});

test("approval message explicitly withholds remote publication", () => {
  const ready = markChangeProposalReady(passScenario(proposal()), 1);
  const approved = approveChangeProposal(ready, {
    expectedVersion: 1,
    resultTree: TREE_V1,
    approverPubkey: PUBKEY,
    approvedAt: 1_788_225_200,
    scope: "commit",
  });
  const message = buildChangeProposalApprovalMessage(approved);
  assert.match(message, /local commit only/);
  assert.match(message, /remotePublicationAuthorized.*false/s);
  assert.match(message, new RegExp(TREE_V1));
});
