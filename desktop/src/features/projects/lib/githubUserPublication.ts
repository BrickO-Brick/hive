import type { ChangeProposal } from "@/features/projects/lib/changeProposal";
import type {
  GitHubRepositoryCommitResult,
  GitHubRepositoryPublishResult,
} from "@/shared/api/githubRepositoryWorkspace";

function slugify(value: string, fallback: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 48)
    .replace(/[._-]+$/g, "");
  return slug || fallback;
}

export function defaultUserPublicationBranch(input: {
  githubLogin: string | null;
  repositoryName: string;
  summary: string;
}) {
  const actor = slugify(input.githubLogin ?? "owner", "owner");
  const task = slugify(input.summary, slugify(input.repositoryName, "change"));
  return `users/${actor}/${task}`;
}

export function buildUserDraftPullRequestBody(input: {
  proposal: ChangeProposal;
  commit: GitHubRepositoryCommitResult;
}) {
  const testing = input.proposal.scenarios
    .slice(0, 10)
    .map((scenario) => {
      const evidence = scenario.evidence.length
        ? scenario.evidence
            .slice(0, 3)
            .map((line) => `  - ${line.slice(0, 500)}`)
            .join("\n")
        : "  - No command output.";
      return [
        `- **${scenario.title}** — \`${scenario.command}\``,
        `  - Expected: ${scenario.expected ?? scenario.expectedOutcomes.join("; ")}`,
        `  - Actual: ${scenario.actual ?? "Not recorded"}`,
        evidence,
      ].join("\n");
    })
    .join("\n");
  return [
    "## Development Goal",
    input.proposal.summary.slice(0, 2_000),
    "",
    "## Previous Condition",
    `The approved change was not present at base commit \`${input.proposal.baseCommit}\`.`,
    "",
    "## Expected Result",
    `The exact approved result tree \`${input.proposal.resultTree}\` is represented by commit \`${input.commit.commit}\`.`,
    "",
    "## Testing",
    testing || "- No acceptance scenario was recorded.",
    "",
    "## Ownership and scope",
    `- Commit author: ${input.commit.authorName}`,
    "- A DCO Signed-off-by trailer is present in the commit metadata.",
    "- This Draft PR was explicitly published through the signed-in user's local GitHub CLI session.",
    "- BrickO participated in the discussion and recommendation; the user retained commit and publication control.",
    "- Release, deployment, merge, and promotion are not authorized by this publication.",
  ].join("\n");
}

export function buildLocalCommitReceipt(input: {
  proposal: ChangeProposal;
  commit: GitHubRepositoryCommitResult;
}) {
  return [
    "Local commit created from the approved exact tree under the user's Git identity.",
    "Remote publication remains unapproved.",
    "```json",
    JSON.stringify(
      {
        type: "buzz-local-commit-receipt",
        repository: input.proposal.repository,
        proposalVersion: input.proposal.version,
        baseCommit: input.proposal.baseCommit,
        resultTree: input.proposal.resultTree,
        branch: input.commit.branch,
        commit: input.commit.commit,
        author: {
          name: input.commit.authorName,
          email: input.commit.authorEmail,
        },
        signedOffBy: input.commit.signedOffBy,
        checkedOut: input.commit.checkedOut,
        indexSynchronized: input.commit.indexSynchronized,
        remotePublicationAuthorized: false,
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

export function buildGitHubPublicationReceipt(input: {
  proposal: ChangeProposal;
  publication: GitHubRepositoryPublishResult;
}) {
  return [
    `GitHub Draft PR published by @${input.publication.githubLogin} after explicit user confirmation.`,
    "Release, deployment, merge, and promotion remain unapproved.",
    input.publication.pullRequestUrl,
    "```json",
    JSON.stringify(
      {
        type: "buzz-github-publication-receipt",
        repository: input.proposal.repository,
        proposalVersion: input.proposal.version,
        resultTree: input.proposal.resultTree,
        branch: input.publication.branch,
        commit: input.publication.commit,
        baseBranch: input.publication.baseBranch,
        githubLogin: input.publication.githubLogin,
        pullRequestNumber: input.publication.pullRequestNumber,
        pullRequestUrl: input.publication.pullRequestUrl,
        draft: input.publication.draft,
        remotePublicationAuthorized: true,
        releaseAuthorized: false,
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}
