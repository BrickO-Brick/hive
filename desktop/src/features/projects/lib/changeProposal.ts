export type ChangeProposalStatus =
  | "draft"
  | "ready"
  | "approved"
  | "rejected"
  | "superseded";

export type TestScenarioStatus =
  | "planned"
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "stale";

export type ChangeProposalFile = {
  path: string;
  additions: number;
  deletions: number;
};

export type TestScenario = {
  id: string;
  title: string;
  command: string;
  given: string[];
  when: string[];
  expectedOutcomes: string[];
  status: TestScenarioStatus;
  testedTree: string | null;
  expected: string | null;
  actual: string | null;
  evidence: string[];
};

export type ChangeProposalApproval = {
  approverPubkey: string;
  approvedAt: number;
  proposalVersion: number;
  resultTree: string;
  scope: "apply" | "commit";
};

export type ChangeProposal = {
  id: string;
  version: number;
  repository: {
    owner: string;
    name: string;
    url: string;
  };
  baseCommit: string;
  resultTree: string;
  targetBranch: string;
  summary: string;
  files: ChangeProposalFile[];
  scenarios: TestScenario[];
  status: ChangeProposalStatus;
  approval: ChangeProposalApproval | null;
};

const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/;

function assertObjectId(value: string, label: string) {
  if (!GIT_OBJECT_ID.test(value)) {
    throw new Error(`${label} must be a lowercase Git object id.`);
  }
}

function assertProposalVersion(
  proposal: ChangeProposal,
  expectedVersion: number,
) {
  if (proposal.version !== expectedVersion) {
    throw new Error(
      `Change proposal version moved from ${expectedVersion} to ${proposal.version}. Refresh before continuing.`,
    );
  }
}

function assertScenario(proposal: ChangeProposal, scenarioId: string) {
  const index = proposal.scenarios.findIndex(
    (scenario) => scenario.id === scenarioId,
  );
  if (index < 0) throw new Error(`Test scenario ${scenarioId} was not found.`);
  return index;
}

export function createChangeProposal(input: {
  id: string;
  repository: ChangeProposal["repository"];
  baseCommit: string;
  resultTree: string;
  targetBranch: string;
  summary: string;
  files: ChangeProposalFile[];
  scenarios: Array<
    Pick<
      TestScenario,
      "id" | "title" | "command" | "given" | "when" | "expectedOutcomes"
    >
  >;
}): ChangeProposal {
  assertObjectId(input.baseCommit, "Base commit");
  assertObjectId(input.resultTree, "Result tree");
  if (
    !input.id.trim() ||
    !input.repository.name.trim() ||
    !input.targetBranch.trim()
  ) {
    throw new Error("Change proposal identity and target branch are required.");
  }
  if (
    new Set(input.scenarios.map((scenario) => scenario.id)).size !==
    input.scenarios.length
  ) {
    throw new Error(
      "Test scenario ids must be unique within a change proposal.",
    );
  }
  return {
    id: input.id,
    version: 1,
    repository: input.repository,
    baseCommit: input.baseCommit,
    resultTree: input.resultTree,
    targetBranch: input.targetBranch,
    summary: input.summary,
    files: input.files,
    scenarios: input.scenarios.map((scenario) => ({
      ...scenario,
      status: "planned",
      testedTree: null,
      expected: null,
      actual: null,
      evidence: [],
    })),
    status: "draft",
    approval: null,
  };
}

export function updateChangeProposalSummary(
  proposal: ChangeProposal,
  input: { expectedVersion: number; summary: string },
): ChangeProposal {
  assertProposalVersion(proposal, input.expectedVersion);
  if (proposal.status === "rejected" || proposal.status === "superseded") {
    throw new Error(`A ${proposal.status} change proposal cannot be updated.`);
  }
  return {
    ...proposal,
    version: proposal.version + 1,
    summary: input.summary.trim(),
    status: "draft",
    approval: null,
  };
}

export function addChangeProposalScenario(
  proposal: ChangeProposal,
  input: {
    expectedVersion: number;
    scenario: Pick<
      TestScenario,
      "id" | "title" | "command" | "given" | "when" | "expectedOutcomes"
    >;
  },
): ChangeProposal {
  assertProposalVersion(proposal, input.expectedVersion);
  if (
    proposal.scenarios.some((scenario) => scenario.id === input.scenario.id)
  ) {
    throw new Error(`Test scenario ${input.scenario.id} already exists.`);
  }
  return {
    ...proposal,
    version: proposal.version + 1,
    status: "draft",
    approval: null,
    scenarios: [
      ...proposal.scenarios,
      {
        ...input.scenario,
        status: "planned",
        testedTree: null,
        expected: null,
        actual: null,
        evidence: [],
      },
    ],
  };
}

export function updateChangeProposalScenario(
  proposal: ChangeProposal,
  input: {
    expectedVersion: number;
    scenarioId: string;
    title: string;
    command: string;
    expectedOutcomes: string[];
  },
): ChangeProposal {
  assertProposalVersion(proposal, input.expectedVersion);
  const index = assertScenario(proposal, input.scenarioId);
  const scenarios = proposal.scenarios.slice();
  scenarios[index] = {
    ...scenarios[index],
    title: input.title.trim(),
    command: input.command.trim(),
    expectedOutcomes: input.expectedOutcomes,
    status: "planned",
    testedTree: null,
    expected: null,
    actual: null,
    evidence: [],
  };
  return {
    ...proposal,
    version: proposal.version + 1,
    status: "draft",
    approval: null,
    scenarios,
  };
}

export function removeChangeProposalScenario(
  proposal: ChangeProposal,
  input: { expectedVersion: number; scenarioId: string },
): ChangeProposal {
  assertProposalVersion(proposal, input.expectedVersion);
  const index = assertScenario(proposal, input.scenarioId);
  return {
    ...proposal,
    version: proposal.version + 1,
    status: "draft",
    approval: null,
    scenarios: proposal.scenarios.filter(
      (_, scenarioIndex) => scenarioIndex !== index,
    ),
  };
}

/**
 * Replaces the proposed result atomically. Every previous test and approval is
 * invalidated because neither is evidence for the new exact result tree.
 */
export function reviseChangeProposal(
  proposal: ChangeProposal,
  input: {
    expectedVersion: number;
    resultTree: string;
    summary?: string;
    files: ChangeProposalFile[];
  },
): ChangeProposal {
  assertProposalVersion(proposal, input.expectedVersion);
  assertObjectId(input.resultTree, "Result tree");
  if (proposal.status === "rejected" || proposal.status === "superseded") {
    throw new Error(`A ${proposal.status} change proposal cannot be revised.`);
  }
  return {
    ...proposal,
    version: proposal.version + 1,
    resultTree: input.resultTree,
    summary: input.summary ?? proposal.summary,
    files: input.files,
    status: "draft",
    approval: null,
    scenarios: proposal.scenarios.map((scenario) => ({
      ...scenario,
      status: "stale",
      testedTree: scenario.testedTree,
    })),
  };
}

export function startTestScenario(
  proposal: ChangeProposal,
  input: { expectedVersion: number; scenarioId: string; resultTree: string },
): ChangeProposal {
  assertProposalVersion(proposal, input.expectedVersion);
  if (input.resultTree !== proposal.resultTree) {
    throw new Error("Test target no longer matches the proposal result tree.");
  }
  const index = assertScenario(proposal, input.scenarioId);
  const scenarios = proposal.scenarios.slice();
  scenarios[index] = {
    ...scenarios[index],
    status: "running",
    testedTree: input.resultTree,
    expected: null,
    actual: null,
    evidence: [],
  };
  return { ...proposal, status: "draft", approval: null, scenarios };
}

export function recordTestScenarioResult(
  proposal: ChangeProposal,
  input: {
    expectedVersion: number;
    scenarioId: string;
    resultTree: string;
    status: "passed" | "failed" | "blocked";
    expected: string;
    actual: string;
    evidence: string[];
  },
): ChangeProposal {
  assertProposalVersion(proposal, input.expectedVersion);
  if (input.resultTree !== proposal.resultTree) {
    throw new Error("Test result belongs to an outdated proposal result tree.");
  }
  const index = assertScenario(proposal, input.scenarioId);
  if (proposal.scenarios[index].status !== "running") {
    throw new Error("Test scenario must be running before recording a result.");
  }
  const scenarios = proposal.scenarios.slice();
  scenarios[index] = {
    ...scenarios[index],
    status: input.status,
    testedTree: input.resultTree,
    expected: input.expected,
    actual: input.actual,
    evidence: input.evidence.slice(0, 50),
  };
  return { ...proposal, status: "draft", approval: null, scenarios };
}

export function markChangeProposalReady(
  proposal: ChangeProposal,
  expectedVersion: number,
): ChangeProposal {
  assertProposalVersion(proposal, expectedVersion);
  if (proposal.scenarios.length === 0) {
    throw new Error("At least one acceptance scenario is required.");
  }
  const incomplete = proposal.scenarios.filter(
    (scenario) =>
      scenario.status !== "passed" ||
      scenario.testedTree !== proposal.resultTree,
  );
  if (incomplete.length > 0) {
    throw new Error(
      `${incomplete.length} acceptance scenario${incomplete.length === 1 ? " is" : "s are"} not passing for the exact result tree.`,
    );
  }
  return { ...proposal, status: "ready", approval: null };
}

export function approveChangeProposal(
  proposal: ChangeProposal,
  input: {
    expectedVersion: number;
    resultTree: string;
    approverPubkey: string;
    approvedAt: number;
    scope: ChangeProposalApproval["scope"];
  },
): ChangeProposal {
  assertProposalVersion(proposal, input.expectedVersion);
  if (proposal.status !== "ready") {
    throw new Error("Only a ready change proposal can be approved.");
  }
  if (input.resultTree !== proposal.resultTree) {
    throw new Error(
      "Approval target no longer matches the proposal result tree.",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.approverPubkey)) {
    throw new Error("Approver pubkey must be lowercase 64-character hex.");
  }
  return {
    ...proposal,
    status: "approved",
    approval: {
      approverPubkey: input.approverPubkey,
      approvedAt: input.approvedAt,
      proposalVersion: proposal.version,
      resultTree: proposal.resultTree,
      scope: input.scope,
    },
  };
}

export function buildChangeProposalApprovalMessage(
  proposal: ChangeProposal,
): string {
  if (proposal.status !== "approved" || !proposal.approval) {
    throw new Error(
      "The change proposal must be approved before recording it.",
    );
  }
  const record = {
    type: "buzz-change-proposal-approval",
    repository: proposal.repository,
    baseCommit: proposal.baseCommit,
    resultTree: proposal.resultTree,
    proposalVersion: proposal.version,
    summary: proposal.summary,
    files: proposal.files.slice(0, 100),
    tests: proposal.scenarios.slice(0, 30).map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      command: scenario.command,
      status: scenario.status,
      testedTree: scenario.testedTree,
      expected: scenario.expected,
      actual: scenario.actual,
      evidence: scenario.evidence.slice(0, 10),
    })),
    approval: proposal.approval,
    remotePublicationAuthorized: false,
  };
  return [
    "I approve this exact local change proposal for a local commit only.",
    "Push, pull request, release, deployment, and other remote publication remain unapproved and require a separate user action.",
    "```json",
    JSON.stringify(record, null, 2),
    "```",
  ].join("\n");
}
