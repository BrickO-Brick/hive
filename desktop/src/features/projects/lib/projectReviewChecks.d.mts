export type ProjectReviewCheckDefinition = {
  id: string;
  name: string;
  description: string;
  instructions: string[];
};

export type ProjectReviewCheckConclusion = "approved" | "fix-recommended";

export type ProjectReviewCheckFinding = {
  title: string;
  detail: string | null;
  file: string | null;
  line: number | null;
};

export type ProjectReviewCheckProposalReference = {
  title: string;
  summary: string;
  diffEventId: string;
};

export type ProjectReviewCheckResult = {
  requestId?: string;
  /** Legacy single-proposal reference. New results use `proposals`. */
  diffEventId?: string;
  proposals?: ProjectReviewCheckProposalReference[];
  conclusion: ProjectReviewCheckConclusion;
  summary: string;
  findings: ProjectReviewCheckFinding[];
};

export type ProjectReviewCheckDiffProposal = {
  eventId: string;
  content: string;
  repoUrl: string;
  commitSha: string;
  filePath: string | null;
  description: string | null;
  truncated: boolean;
};

export type ProjectReviewCheckResolvedProposal =
  ProjectReviewCheckDiffProposal & {
    title: string;
    summary: string;
  };

export const PROJECT_REVIEW_CHECK_RESULT_MARKER: string;
export const DEFAULT_PROJECT_REVIEW_CHECKS: ProjectReviewCheckDefinition[];

export function parseProjectReviewCheckResult(
  content: unknown,
): ProjectReviewCheckResult | null;

export function parseProjectReviewCheckDiffEvent(
  event: unknown,
  expected: {
    eventId: string;
    agentPubkey: string;
    repoUrl: string;
    commit: string | null;
  },
): ProjectReviewCheckDiffProposal | null;

export function buildProjectReviewCheckPrompt(input: {
  check: ProjectReviewCheckDefinition;
  projectName: string;
  repoAddress: string;
  repoUrl: string | null;
  channelId: string;
  reviewId: string;
  reviewLink: string;
  reviewTitle: string;
  requestId: string;
  commit: string | null;
  branchName: string | null;
  targetBranch: string | null;
  supersededRequestId?: string;
  supersededEventId?: string;
}): string;

export function projectReviewChecksStorageKey(input: {
  relayUrl: string | null;
  signerPubkey: string | null;
  repoAddress: string | null;
  reviewId: string | null;
}): string | null;

export function readProjectReviewCheckRuns(
  storage: Pick<Storage, "getItem"> | null,
  key: string | null,
): Record<string, unknown>;

export function writeProjectReviewCheckRuns(
  storage: Pick<Storage, "setItem"> | null,
  key: string | null,
  runs: Record<string, unknown>,
): void;
