import {
  DownloadCloud,
  ExternalLink,
  FileCode2,
  GitCommitHorizontal,
  GitPullRequest,
  Loader2,
  MessageCircle,
  RefreshCw,
  SquareTerminal,
  UploadCloud,
  Users,
} from "lucide-react";
import type * as React from "react";

import type {
  Project,
  ProjectPullRequest,
  ProjectRepoContributor,
  ProjectRepoFile,
  ProjectRepoSnapshot,
  Repository,
} from "@/features/projects/hooks";
import {
  LANGUAGE_DOT_CLASSES,
  languageForPath,
  topLanguagesFromCounts,
} from "@/features/projects/lib/projectLanguages";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { RightAuxiliaryPane } from "@/features/channels/ui/RightAuxiliaryPane";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import {
  RepoSourceDropdown,
  type RepoSourceHeaderControls,
  RepositoryBranchDropdown,
} from "./ProjectRepositorySource";
import { ProjectRepositoryManagement } from "./ProjectRepositoryManagement";

type ProjectRepositoryActionsPanelProps = {
  canResetWidth: boolean;
  contributors: ProjectRepoContributor[];
  files: ProjectRepoFile[];
  identityPubkey?: string;
  onOpenTerminal: () => void;
  onRepositoryChange: (repositoryId: string) => void;
  onResetWidth: () => void;
  onResizeStart: (event: React.PointerEvent<HTMLButtonElement>) => void;
  profiles?: UserProfileLookup;
  pullRequests: ProjectPullRequest[];
  project: Project;
  projects: Project[];
  repository: Repository;
  snapshot: ProjectRepoSnapshot | null | undefined;
  sourceControls: RepoSourceHeaderControls;
  terminalTitle?: string;
  widthPx: number;
};

function topLanguages(files: ProjectRepoFile[]) {
  const counts: Record<string, number> = {};
  for (const file of files) {
    const language = languageForPath(file.path);
    if (language) counts[language] = (counts[language] ?? 0) + 1;
  }
  return topLanguagesFromCounts(counts);
}

function RepositoryPanelSection({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <section className="space-y-2.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function RepositoryActionButton({
  children,
  disabled,
  onClick,
  title,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <Button
      className="h-8 justify-start gap-2 text-sm"
      disabled={disabled}
      onClick={onClick}
      size="sm"
      title={title}
      type="button"
      variant="outline"
    >
      {children}
    </Button>
  );
}

export function ProjectRepositoryActionsPanel({
  canResetWidth,
  contributors,
  files,
  identityPubkey,
  onOpenTerminal,
  onRepositoryChange,
  onResetWidth,
  onResizeStart,
  profiles,
  pullRequests,
  project,
  projects,
  repository,
  snapshot,
  sourceControls,
  terminalTitle,
  widthPx,
}: ProjectRepositoryActionsPanelProps) {
  const people = [
    ...new Set(
      [repository.owner, ...repository.contributors]
        .filter(Boolean)
        .map(normalizePubkey),
    ),
  ];
  const languages = topLanguages(files);
  const latestCommit = snapshot?.latestCommit ?? null;
  const cloneAction = sourceControls.localDisabled
    ? sourceControls.onCloneLocal
    : undefined;
  const fetchAction =
    sourceControls.source === "local" ||
    sourceControls.remoteKind !== "external"
      ? sourceControls.onFetch
      : undefined;
  const pullAction = sourceControls.canPull ? sourceControls.onPull : undefined;
  const pushAction = sourceControls.canPush ? sourceControls.onPush : undefined;

  return (
    <RightAuxiliaryPane
      canResetWidth={canResetWidth}
      onResetWidth={onResetWidth}
      onResizeStart={onResizeStart}
      testId="project-repository-actions-panel"
      widthPx={widthPx}
    >
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
        <RepositoryPanelSection title="Working copy">
          <div className="grid gap-2 [&_button]:w-full [&_button]:justify-between [&_button]:text-sm">
            <RepoSourceDropdown controls={sourceControls} />
            <RepositoryBranchDropdown
              branch={sourceControls.branch}
              branchOptions={sourceControls.branchOptions}
              createBranchDisabled={sourceControls.createBranchDisabled}
              createBranchTitle={sourceControls.createBranchTitle}
              deleteBranchDisabled={sourceControls.deleteBranchDisabled}
              deleteBranchTitle={sourceControls.deleteBranchTitle}
              onBranchChange={sourceControls.onBranchChange}
              onCreateBranch={sourceControls.onCreateBranch}
              onDeleteBranch={sourceControls.onDeleteBranch}
              onTagChange={sourceControls.onTagChange}
              selectedTag={sourceControls.selectedTag}
              tagOptions={sourceControls.tagOptions}
            />
          </div>
        </RepositoryPanelSection>

        <RepositoryPanelSection title="Actions">
          <div className="grid gap-2">
            {cloneAction ? (
              <RepositoryActionButton
                disabled={sourceControls.clonePending}
                onClick={cloneAction}
              >
                {sourceControls.clonePending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <DownloadCloud className="h-3.5 w-3.5" />
                )}
                {sourceControls.clonePending ? "Cloning…" : "Clone"}
              </RepositoryActionButton>
            ) : null}
            {sourceControls.remoteUnavailableReason === "access" &&
            sourceControls.onAskForAccess ? (
              <RepositoryActionButton
                onClick={sourceControls.onAskForAccess}
                title="Open project chat to ask for repository access"
              >
                <MessageCircle className="h-3.5 w-3.5" />
                Ask for access
              </RepositoryActionButton>
            ) : null}
            {fetchAction ? (
              <RepositoryActionButton
                disabled={sourceControls.fetchPending}
                onClick={fetchAction}
                title={sourceControls.fetchTitle}
              >
                {sourceControls.fetchPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Fetch
              </RepositoryActionButton>
            ) : null}
            {pullAction ? (
              <RepositoryActionButton
                disabled={sourceControls.pullDisabled}
                onClick={pullAction}
                title={sourceControls.pullTitle}
              >
                {sourceControls.pullPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <DownloadCloud className="h-3.5 w-3.5" />
                )}
                Pull
                {sourceControls.behindCount
                  ? ` ${sourceControls.behindCount}`
                  : ""}
              </RepositoryActionButton>
            ) : null}
            {pushAction ? (
              <RepositoryActionButton
                disabled={sourceControls.pushDisabled}
                onClick={pushAction}
                title={sourceControls.pushTitle}
              >
                {sourceControls.pushPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <UploadCloud className="h-3.5 w-3.5" />
                )}
                Push
                {sourceControls.aheadCount
                  ? ` ${sourceControls.aheadCount}`
                  : ""}
              </RepositoryActionButton>
            ) : null}
            <RepositoryActionButton
              onClick={onOpenTerminal}
              title={terminalTitle ?? "Open terminal"}
            >
              <SquareTerminal className="h-3.5 w-3.5" />
              Terminal
            </RepositoryActionButton>
            {sourceControls.externalUrl ? (
              <Button
                asChild
                className="h-8 justify-start gap-2 text-sm"
                size="sm"
                variant="outline"
              >
                <a
                  href={sourceControls.externalUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open
                </a>
              </Button>
            ) : null}
          </div>
          <div className="grid gap-2 [&_button]:h-8 [&_button]:w-full [&_button]:justify-start [&_button]:text-sm">
            <ProjectRepositoryManagement
              identityPubkey={identityPubkey}
              onChange={onRepositoryChange}
              project={project}
              projects={projects}
              repository={repository}
            />
          </div>
        </RepositoryPanelSection>

        <RepositoryPanelSection title="People">
          <div className="flex flex-wrap gap-1.5">
            {people.slice(0, 18).map((person) => {
              const profile = profiles?.[person];
              const label =
                profile?.displayName?.trim() ||
                profile?.nip05Handle?.trim() ||
                person;
              return (
                <UserAvatar
                  accent={profile?.isAgent === true}
                  avatarUrl={profile?.avatarUrl ?? null}
                  displayName={label}
                  key={person}
                  size="sm"
                />
              );
            })}
          </div>
        </RepositoryPanelSection>

        <RepositoryPanelSection title="Top languages">
          {languages.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {languages.map(([language], index) => (
                <span
                  className="inline-flex h-5 items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2 text-xs text-muted-foreground"
                  key={language}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      LANGUAGE_DOT_CLASSES[index % LANGUAGE_DOT_CLASSES.length]
                    }`}
                  />
                  {language}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No language data available.
            </p>
          )}
        </RepositoryPanelSection>

        <RepositoryPanelSection title="Repository details">
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <GitPullRequest className="h-3.5 w-3.5" />
                Reviews
              </dt>
              <dd className="font-medium text-foreground">
                {pullRequests.length}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <GitCommitHorizontal className="h-3.5 w-3.5" />
                Latest
              </dt>
              <dd className="font-mono text-xs text-foreground">
                {latestCommit ? latestCommit.hash.slice(0, 7) : "—"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <FileCode2 className="h-3.5 w-3.5" />
                Files
              </dt>
              <dd
                className="font-medium text-foreground"
                data-testid="project-repository-file-count"
              >
                {snapshot ? files.length : "—"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <Users className="h-3.5 w-3.5" />
                Contributors
              </dt>
              <dd className="font-medium text-foreground">
                {snapshot ? contributors.length : "—"}
              </dd>
            </div>
          </dl>
        </RepositoryPanelSection>
      </div>
    </RightAuxiliaryPane>
  );
}
