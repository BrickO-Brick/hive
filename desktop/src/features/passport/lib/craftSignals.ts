/**
 * Craft signal counting — turns the community's NIP-34 work items into the
 * per-pubkey engineering counts that feed `computeAgentBadges`. Shared by the
 * passport screen and the agent catalog so both surfaces read the exact same
 * record.
 */

import type { ProjectIssue } from "@/features/projects/projectIssues.mjs";
import type { ProjectPullRequest } from "@/features/projects/projectPullRequests.mjs";

/** GitHub Quickdraw: closed or merged within five minutes of opening. */
export const QUICKDRAW_SECONDS = 5 * 60;

export type CraftSignalCounts = {
  /** Issues assigned to the holder (not authored) that reached Done. */
  assignedDoneCount: number;
  closedPrCount: number;
  /** Comments the holder left on issues they did not file. */
  issueHelpCount: number;
  issuesOpenedCount: number;
  /** Filed issues that reached Done. */
  issueDoneCount: number;
  mergedPrCount: number;
  /** PRs where this holder and another community agent both participated. */
  pairPrCount: number;
  /** Review-weight comments on pull requests authored by other agents. */
  peerReviewCount: number;
  /** Authored issues/PRs closed or merged within five minutes. */
  quickdrawCount: number;
  repoCount: number;
  reviewCount: number;
  /** Merged authored PRs with no review decision from anyone else. */
  yoloMergeCount: number;
};

export const EMPTY_CRAFT_SIGNAL_COUNTS: CraftSignalCounts = {
  assignedDoneCount: 0,
  closedPrCount: 0,
  issueDoneCount: 0,
  issueHelpCount: 0,
  issuesOpenedCount: 0,
  mergedPrCount: 0,
  pairPrCount: 0,
  peerReviewCount: 0,
  quickdrawCount: 0,
  repoCount: 0,
  reviewCount: 0,
  yoloMergeCount: 0,
};

type CraftWorkItems = {
  issues: { items: Array<{ project: { id: string }; issue: ProjectIssue }> };
  pullRequests: {
    items: Array<{ project: { id: string }; pullRequest: ProjectPullRequest }>;
  };
};

function isReviewWeight(comment: {
  isApproval: boolean;
  isChangeRequest: boolean;
  isInlineComment: boolean;
}): boolean {
  return (
    comment.isApproval || comment.isChangeRequest || comment.isInlineComment
  );
}

function isReviewDecision(comment: {
  isApproval: boolean;
  isChangeRequest: boolean;
}): boolean {
  return comment.isApproval || comment.isChangeRequest;
}

function closedWithinFiveMinutes(
  openedAt: number,
  closedAt: number | null,
): boolean {
  if (closedAt === null) {
    return false;
  }
  const elapsed = closedAt - openedAt;
  return elapsed >= 0 && elapsed <= QUICKDRAW_SECONDS;
}

/** Count the pubkey's authored PRs, filed issues, reviews, and repo spread. */
export function countCraftSignals(
  workItems: CraftWorkItems | undefined,
  pubkeyLower: string | null,
  agentPubkeys: ReadonlySet<string> = new Set(),
): CraftSignalCounts {
  const counts: CraftSignalCounts = { ...EMPTY_CRAFT_SIGNAL_COUNTS };
  if (!pubkeyLower || !workItems) {
    return counts;
  }
  const repos = new Set<string>();
  const pairPrIds = new Set<string>();

  for (const { project, pullRequest } of workItems.pullRequests.items) {
    const author = pullRequest.author.toLowerCase();
    const isAuthor = author === pubkeyLower;
    const otherReviewers = new Set<string>();
    let holderReviewed = false;
    let otherReviewDecision = false;

    for (const comment of pullRequest.comments) {
      const commenter = comment.author.toLowerCase();
      if (!isReviewWeight(comment) || commenter === author) {
        continue;
      }
      if (commenter === pubkeyLower) {
        holderReviewed = true;
        counts.reviewCount += 1;
        repos.add(project.id);
        if (agentPubkeys.has(author) && author !== pubkeyLower) {
          counts.peerReviewCount += 1;
        }
      } else {
        otherReviewers.add(commenter);
        if (isReviewDecision(comment)) {
          otherReviewDecision = true;
        }
      }
    }

    const participants = new Set<string>([author, ...otherReviewers]);
    if (holderReviewed) {
      participants.add(pubkeyLower);
    }
    const otherAgentParticipated = [...participants].some(
      (pubkey) => pubkey !== pubkeyLower && agentPubkeys.has(pubkey),
    );
    if (participants.has(pubkeyLower) && otherAgentParticipated) {
      pairPrIds.add(pullRequest.id);
    }

    if (!isAuthor) {
      continue;
    }
    repos.add(project.id);
    if (pullRequest.status === "Merged") {
      counts.mergedPrCount += 1;
      if (!otherReviewDecision) {
        counts.yoloMergeCount += 1;
      }
    } else if (pullRequest.status === "Closed") {
      counts.closedPrCount += 1;
    }
    if (
      (pullRequest.status === "Merged" || pullRequest.status === "Closed") &&
      closedWithinFiveMinutes(
        pullRequest.createdAt,
        pullRequest.statusCreatedAt,
      )
    ) {
      counts.quickdrawCount += 1;
    }
  }

  for (const { issue, project } of workItems.issues.items) {
    const author = issue.author.toLowerCase();
    const isAuthor = author === pubkeyLower;
    const assignees = issue.assignees ?? [];
    const comments = issue.comments ?? [];
    const isAssignee = assignees.some(
      (assignee) => assignee.toLowerCase() === pubkeyLower,
    );
    const isDone = issue.status === "Done";
    const isClosed = issue.status === "Closed" || isDone;

    if (isAuthor) {
      counts.issuesOpenedCount += 1;
      repos.add(project.id);
      if (isDone) {
        counts.issueDoneCount += 1;
      }
      if (
        isClosed &&
        closedWithinFiveMinutes(issue.createdAt, issue.updatedAt)
      ) {
        counts.quickdrawCount += 1;
      }
    } else if (isAssignee && isDone) {
      counts.assignedDoneCount += 1;
    }

    if (!isAuthor) {
      for (const comment of comments) {
        if (comment.author.toLowerCase() === pubkeyLower) {
          counts.issueHelpCount += 1;
        }
      }
    }
  }

  counts.pairPrCount = pairPrIds.size;
  counts.repoCount = repos.size;
  return counts;
}
