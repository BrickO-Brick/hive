import {
  CircleCheck,
  CircleDot,
  CircleX,
  MessageSquare,
  Tag,
  User,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { useIsManagedAgent } from "@/features/agent-memory/hooks";
import { ForumComposer } from "@/features/forum/ui/ForumComposer";
import {
  type ProjectIssue,
  type Repository as Project,
  useCreateProjectIssueCommentMutation,
  useProjectIssuesQuery,
} from "@/features/projects/hooks";
import {
  resolveUserLabel,
  type UserProfileLookup,
} from "@/features/profile/lib/identity";
import { entityDiscussionQuery } from "@/features/projects/lib/discussionChannels";
import { issueShareLink } from "@/features/projects/lib/projectShareLinks";
import { relativeTime } from "@/features/projects/lib/projectsViewHelpers";
import {
  projectTaskCategoryLabel,
  projectTaskUserLabels,
} from "@/features/projects/projectTaskCategories";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { ChannelMember } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { IssueAssigneeFacepile, IssueAssigneesRow } from "./IssueAssigneesRow";
import {
  ProjectFeedRow,
  ProjectFeedRowCluster,
  ProjectFeedRowMonoCell,
} from "./ProjectFeedRow";
import { DiscussedInChannels } from "./DiscussionChannels";
import { ProjectIssueCommentTimeline } from "./ProjectIssueCommentTimeline";
import { ProjectOriginReference } from "./ProjectOriginReference";
import {
  ProjectDetailMetaList,
  ProjectDetailMetaPills,
  ProjectDetailMetaRow,
} from "./ProjectDetailMeta";
import { ProjectDetailSection } from "./ProjectDetailSection";
import { ProfileIdentityButton } from "./ProjectProfileIdentity";
import { ProjectRichContent } from "./ProjectRichContent";
import { ShareLinkButton } from "./ShareLinkButton";

export function issueStatusClassName(status: ProjectIssue["status"]) {
  if (status === "Done") return "text-purple-400";
  if (status === "Closed") return "text-destructive";
  return "text-green-500";
}

function issueStatusVisual(status: ProjectIssue["status"]) {
  if (status === "Done") {
    return { className: "text-purple-400", icon: CircleCheck };
  }
  if (status === "Closed") {
    return { className: "text-destructive", icon: CircleX };
  }
  return { className: "text-green-500", icon: CircleDot };
}

function issueMembers(
  project: Project,
  issue: ProjectIssue,
  profiles?: UserProfileLookup,
): ChannelMember[] {
  return [
    ...new Set([
      project.owner,
      issue.author,
      ...project.contributors,
      ...issue.recipients,
    ]),
  ].map((pubkey) => {
    const profile = profiles?.[normalizePubkey(pubkey)];
    return {
      pubkey,
      role: "member" as const,
      isAgent: profile?.isAgent === true,
      joinedAt: new Date(0).toISOString(),
      displayName:
        profile?.displayName?.trim() || profile?.nip05Handle?.trim() || null,
    };
  });
}

function IssueRow({
  issue,
  onOpen,
  profiles,
}: {
  issue: ProjectIssue;
  onOpen: () => void;
  profiles?: UserProfileLookup;
}) {
  const authorProfile = profiles?.[normalizePubkey(issue.author)];
  const authorLabel = resolveUserLabel({ profiles, pubkey: issue.author });
  const status = issueStatusVisual(issue.status);
  const labels = projectTaskUserLabels(issue.labels);

  return (
    <ProjectFeedRow
      meta={
        <>
          <ProfileIdentityButton
            avatarClassName="shrink-0"
            avatarSize="xs"
            avatarUrl={authorProfile?.avatarUrl ?? null}
            isAgent={authorProfile?.isAgent === true}
            label={authorLabel}
            pubkey={issue.author}
            showLabel={false}
          />
          <span className="truncate text-foreground/80">
            <span className="font-medium">{authorLabel}</span> created this task
          </span>
          <span>·</span>
          <span>{projectTaskCategoryLabel(issue.category)}</span>
          <span>·</span>
          <span>{issue.status}</span>
          {labels.map((label) => (
            <span
              className="rounded-full border border-border/60 px-1.5 py-0.5 text-2xs"
              key={label}
            >
              {label}
            </span>
          ))}
        </>
      }
      eventId={issue.id}
      onOpen={onOpen}
      statusIcon={
        <status.icon className={`h-3.5 w-3.5 shrink-0 ${status.className}`} />
      }
      testId="project-issue-row"
      title={issue.title}
      trailing={
        <>
          <IssueAssigneeFacepile
            assignees={issue.assignees}
            profiles={profiles}
          />
          {issue.comments.length > 0 ? (
            <button
              aria-label={`View ${issue.comments.length} comments`}
              className="flex items-center gap-1 rounded-md text-xs text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onOpen}
              type="button"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              {issue.comments.length}
            </button>
          ) : null}
          <ProjectFeedRowCluster>
            <ProjectFeedRowMonoCell
              label={`#${issue.id.slice(0, 8)}`}
              onClick={onOpen}
              title="View task"
            />
          </ProjectFeedRowCluster>
          <span
            className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground sm:block"
            data-testid="project-issue-row-date"
            title={new Date(issue.createdAt * 1_000).toLocaleString()}
          >
            {relativeTime(issue.createdAt)}
          </span>
        </>
      }
    />
  );
}

/** Full issue conversation and comment composer. */
export function ProjectIssueDetail({
  issue,
  profiles,
  project,
}: {
  issue: ProjectIssue;
  profiles?: UserProfileLookup;
  project: Project;
}) {
  const commentMutation = useCreateProjectIssueCommentMutation(project);
  const authorLabel = resolveUserLabel({ profiles, pubkey: issue.author });
  const members = React.useMemo(
    () => issueMembers(project, issue, profiles),
    [issue, profiles, project],
  );
  const handleCommentSubmit = React.useCallback(
    async (
      content: string,
      mentionPubkeys: string[],
      mediaTags?: string[][],
    ) => {
      try {
        await commentMutation.mutateAsync({
          content,
          issue,
          mediaTags,
          mentionPubkeys,
        });
        toast.success("Comment posted.");
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to post comment.",
        );
        throw error;
      }
    },
    [commentMutation, issue],
  );
  const identityQuery = useIdentityQuery();
  const authorProfile = profiles?.[normalizePubkey(issue.author)];
  const status = issueStatusVisual(issue.status);
  const labels = projectTaskUserLabels(issue.labels);
  const viewerPubkey = identityQuery.data?.pubkey;
  const viewer = viewerPubkey ? normalizePubkey(viewerPubkey) : null;
  const isAuthor = viewer === normalizePubkey(issue.author);
  const isOwner = viewer === normalizePubkey(project.owner);
  const isManagedAgentOwner = useIsManagedAgent(project.owner) === true;
  const canAssignOthers =
    Boolean(viewer) && (isAuthor || isOwner || isManagedAgentOwner);

  return (
    <div>
      <header className="space-y-1 px-4 pb-1 pt-3">
        <h3 className="line-clamp-2 text-xl font-semibold text-foreground">
          {issue.title}{" "}
          <span className="font-normal text-muted-foreground">
            #{issue.id.slice(0, 8)}
          </span>
          <ShareLinkButton
            className="ml-1 inline-flex h-7 w-7 align-text-bottom"
            label="Copy task link"
            link={issueShareLink(issue)}
            testId="project-issue-copy-link"
          />
        </h3>
        <p className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs font-medium text-muted-foreground">
          <ProfileIdentityButton
            avatarClassName="shrink-0"
            avatarSize="xs"
            avatarUrl={authorProfile?.avatarUrl ?? null}
            isAgent={authorProfile?.isAgent === true}
            label={authorLabel}
            pubkey={issue.author}
            showLabel={false}
          />
          <span className="font-medium text-foreground">{authorLabel}</span>
          <span
            className="shrink-0 whitespace-nowrap"
            title={new Date(issue.createdAt * 1_000).toLocaleString()}
          >
            {relativeTime(issue.createdAt)}
          </span>
          <ProjectOriginReference
            agentName={issue.originAgentName}
            channelId={issue.channelId}
          />
        </p>
      </header>
      <ProjectDetailMetaList>
        <ProjectDetailMetaRow icon={status.icon} label="Status">
          <span className={`font-medium ${status.className}`}>
            {issue.status}
          </span>
        </ProjectDetailMetaRow>
        <ProjectDetailMetaRow icon={CircleDot} label="Category">
          {projectTaskCategoryLabel(issue.category)}
        </ProjectDetailMetaRow>
        {issue.assignees.length > 0 || viewer ? (
          <ProjectDetailMetaRow icon={User} label="Assignees">
            <IssueAssigneesRow
              canAssignOthers={canAssignOthers}
              issue={issue}
              profiles={profiles}
              project={project}
              signAsManagedOwner={isManagedAgentOwner && !isOwner}
              viewerPubkey={viewer}
            />
          </ProjectDetailMetaRow>
        ) : null}
        {labels.length > 0 ? (
          <ProjectDetailMetaRow icon={Tag} label="Labels">
            <ProjectDetailMetaPills labels={labels} />
          </ProjectDetailMetaRow>
        ) : null}
      </ProjectDetailMetaList>
      {issue.content ? (
        <ProjectDetailSection defaultOpen title="Description">
          <ProjectRichContent content={issue.content} tags={issue.tags} />
        </ProjectDetailSection>
      ) : null}
      <ProjectDetailSection defaultOpen title="Activity">
        <div className="space-y-3">
          <DiscussedInChannels
            entityLabel="this task"
            originChannelId={issue.channelId}
            originCreatedAt={issue.createdAt}
            originPubkey={issue.author}
            query={entityDiscussionQuery(issue.id)}
            testId="issue-discussed-in"
          />
          <ProjectIssueCommentTimeline
            comments={issue.comments}
            key={issue.id}
            profiles={profiles}
          />
          <div data-testid="project-issue-comment-composer">
            <ForumComposer
              className="border border-border/60 bg-background/45"
              disabled={commentMutation.isPending}
              isSending={commentMutation.isPending}
              members={members}
              onSubmit={handleCommentSubmit}
              placeholder="Add a comment…"
              profiles={profiles}
            />
          </div>
        </div>
      </ProjectDetailSection>
    </div>
  );
}

export function ProjectIssuesPanel({
  onSelectedIssueIdChange,
  profiles,
  project,
  selectedIssueId,
}: {
  onSelectedIssueIdChange: (id: string | null) => void;
  profiles?: UserProfileLookup;
  project: Project;
  selectedIssueId: string | null;
}) {
  const issuesQuery = useProjectIssuesQuery(project);
  const issues = issuesQuery.data ?? [];
  const selectedIssue =
    issues.find((issue) => issue.id === selectedIssueId) ?? null;

  if (issuesQuery.isLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading tasks…</p>;
  }

  if (issues.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {issuesQuery.error
          ? "Could not load tasks for this repository."
          : "No tasks yet."}
      </p>
    );
  }

  if (selectedIssue) {
    return (
      <ProjectIssueDetail
        issue={selectedIssue}
        profiles={profiles}
        project={project}
      />
    );
  }

  return (
    <div className="divide-y divide-border/50">
      {issues.map((issue) => (
        <IssueRow
          issue={issue}
          key={issue.id}
          onOpen={() => onSelectedIssueIdChange(issue.id)}
          profiles={profiles}
        />
      ))}
    </div>
  );
}
