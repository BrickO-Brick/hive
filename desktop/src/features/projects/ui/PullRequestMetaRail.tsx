import { GitMerge, GitPullRequest } from "lucide-react";

import { useIsManagedAgent } from "@/features/agent-memory/hooks";
import type {
  ProjectPullRequest,
  Repository as Project,
} from "@/features/projects/hooks";
import {
  formatExactTimestamp,
  relativeTime,
} from "@/features/projects/lib/projectsViewHelpers";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { useIdentityQuery } from "@/shared/api/hooks";
import { cn } from "@/shared/lib/cn";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { CopyCommitHashButton } from "./ProjectCommitCopyButton";
import { OverviewRailSection } from "./ProjectOverviewPanel";
import { PullRequestReviewersRow } from "./PullRequestReviewersRow";
import { PROJECT_DETAIL_META_RAIL_WIDE_BORDER_CLASS } from "./projectPanelStyles";

const META_RAIL_HEADING_CLASS =
  "text-2xs font-medium uppercase tracking-wide text-muted-foreground";

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function statusBadgeClassName(status: ProjectPullRequest["status"]) {
  if (status === "Closed") return "bg-destructive";
  if (status === "Draft") return "bg-muted-foreground/80";
  if (status === "Merged") return "bg-purple-600";
  return "bg-green-600";
}

/** Compact, actionable metadata for a selected review. */
export function PullRequestMetaRail({
  profiles,
  project,
  pullRequest,
  stacked = false,
}: {
  profiles?: UserProfileLookup;
  project: Project;
  pullRequest: ProjectPullRequest;
  stacked?: boolean;
}) {
  const identityQuery = useIdentityQuery();
  const targetBranch =
    pullRequest.targetBranch || project.defaultBranch || "default branch";
  const sourceBranch = pullRequest.branchName || "unknown branch";
  const discussionComments = pullRequest.comments.filter(
    (comment) =>
      !(
        (comment.isReviewRequest && comment.isTrustedReviewRequest) ||
        comment.isTrustedReviewDecision
      ),
  );
  const inlineCommentCount = discussionComments.filter(
    (comment) => comment.isInlineComment,
  ).length;
  const outdatedCommentCount = discussionComments.filter(
    (comment) => comment.inlineCommentStatus === "outdated",
  ).length;
  const labels = pullRequest.labels.filter(
    (label) => label.toLowerCase() !== "draft",
  );
  const viewerPubkey = identityQuery.data?.pubkey;
  const viewer = viewerPubkey ? normalizePubkey(viewerPubkey) : null;
  const isAuthor = viewer === normalizePubkey(pullRequest.author);
  const isOwner = viewer === normalizePubkey(project.owner);
  const isManagedAgentOwner = useIsManagedAgent(project.owner) === true;
  const canRequestReview =
    Boolean(viewer) && (isAuthor || isOwner || isManagedAgentOwner);

  return (
    <aside
      className={cn(
        "min-w-0 space-y-5 border-border/60 p-4",
        stacked
          ? "border-t"
          : cn("border-t", PROJECT_DETAIL_META_RAIL_WIDE_BORDER_CLASS),
      )}
    >
      <OverviewRailSection
        title="Status"
        titleClassName={META_RAIL_HEADING_CLASS}
      >
        <span
          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-white ${statusBadgeClassName(pullRequest.status)}`}
        >
          {pullRequest.status === "Merged" ? (
            <GitMerge className="h-3.5 w-3.5" />
          ) : (
            <GitPullRequest className="h-3.5 w-3.5" />
          )}
          {pullRequest.status}
        </span>
      </OverviewRailSection>
      <OverviewRailSection
        title="Review"
        titleClassName={META_RAIL_HEADING_CLASS}
      >
        <PullRequestReviewersRow
          canRequest={canRequestReview}
          profiles={profiles}
          project={project}
          pullRequest={pullRequest}
          signAsManagedOwner={isManagedAgentOwner && !isOwner}
        />
      </OverviewRailSection>
      {discussionComments.length > 0 ? (
        <OverviewRailSection
          title="Discussion"
          titleClassName={META_RAIL_HEADING_CLASS}
        >
          <p className="text-xs text-muted-foreground">
            {pluralize(discussionComments.length, "comment")}
            {inlineCommentCount > 0 ? ` · ${inlineCommentCount} inline` : ""}
            {outdatedCommentCount > 0
              ? ` · ${outdatedCommentCount} outdated`
              : ""}
          </p>
        </OverviewRailSection>
      ) : null}
      <OverviewRailSection
        title="Source"
        titleClassName={META_RAIL_HEADING_CLASS}
      >
        <div className="space-y-1.5 text-xs text-muted-foreground">
          <p className="flex min-w-0 flex-wrap items-center gap-1.5">
            <code className="rounded-sm bg-muted px-1.5 py-0.5 text-2xs text-foreground">
              {sourceBranch}
            </code>
            <span aria-hidden>→</span>
            <code className="rounded-sm bg-muted px-1.5 py-0.5 text-2xs text-foreground">
              {targetBranch}
            </code>
          </p>
          {pullRequest.commit ? (
            <p className="flex min-w-0 items-center gap-1.5">
              <span>Commit</span>
              <code
                className="truncate rounded-sm bg-muted px-1.5 py-0.5 text-2xs text-foreground"
                title={pullRequest.commit}
              >
                {pullRequest.commit.slice(0, 7)}
              </code>
              <CopyCommitHashButton
                className="h-6 w-6"
                hash={pullRequest.commit}
              />
            </p>
          ) : (
            <p>No commit reported</p>
          )}
        </div>
      </OverviewRailSection>
      {labels.length > 0 ? (
        <OverviewRailSection
          title="Labels"
          titleClassName={META_RAIL_HEADING_CLASS}
        >
          <div className="flex flex-wrap gap-1.5">
            {labels.map((label) => (
              <span
                className="rounded-full border border-border/60 px-2 py-0.5 text-2xs text-muted-foreground"
                key={label}
              >
                {label}
              </span>
            ))}
          </div>
        </OverviewRailSection>
      ) : null}
      <OverviewRailSection
        title="Activity"
        titleClassName={META_RAIL_HEADING_CLASS}
      >
        <dl className="space-y-1.5 text-xs text-muted-foreground">
          <div className="flex items-center justify-between gap-3">
            <dt>Updated</dt>
            <dd
              className="font-medium text-foreground"
              title={formatExactTimestamp(pullRequest.updatedAt)}
            >
              {relativeTime(pullRequest.updatedAt)}
            </dd>
          </div>
          {(pullRequest.status === "Merged" ||
            pullRequest.status === "Closed") &&
          pullRequest.statusCreatedAt ? (
            <div className="flex items-center justify-between gap-3">
              <dt>{pullRequest.status}</dt>
              <dd
                className="font-medium text-foreground"
                title={formatExactTimestamp(pullRequest.statusCreatedAt)}
              >
                {relativeTime(pullRequest.statusCreatedAt)}
              </dd>
            </div>
          ) : null}
        </dl>
      </OverviewRailSection>
    </aside>
  );
}
