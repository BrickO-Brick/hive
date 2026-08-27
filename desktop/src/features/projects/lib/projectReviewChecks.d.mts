export type ProjectReviewCheckDefinition = {
  id: string;
  name: string;
  description: string;
  instructions: string[];
};

export type ProjectReviewCheckConclusion = "approved" | "fix-recommended";

export type ProjectReviewCheckResult = {
  conclusion: ProjectReviewCheckConclusion;
  summary: string;
  findings: string[];
};

export const PROJECT_REVIEW_CHECK_RESULT_MARKER: string;
export const PROJECT_REVIEW_CHECKS_CONFIG_PATH: string;
export const DEFAULT_PROJECT_REVIEW_CHECKS: ProjectReviewCheckDefinition[];

export function parseProjectReviewChecksConfig(
  content: string,
): ProjectReviewCheckDefinition[];

export function parseProjectReviewCheckResult(
  content: unknown,
): ProjectReviewCheckResult | null;

export function buildProjectReviewCheckPrompt(input: {
  check: ProjectReviewCheckDefinition;
  projectName: string;
  repoAddress: string;
  reviewId: string;
  reviewLink: string;
  reviewTitle: string;
  commit: string | null;
  branchName: string | null;
  targetBranch: string | null;
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
