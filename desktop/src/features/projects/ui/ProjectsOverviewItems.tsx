import type { UserProfileLookup } from "@/features/profile/lib/identity";
import type * as React from "react";
import { FolderGit2, Folders } from "lucide-react";
import type {
  Project,
  ProjectActivitySummary,
  Repository,
} from "@/features/projects/hooks";
import {
  hasLocalCheckout,
  hasLocalRepositoryCheckout,
} from "@/features/projects/lib/projectLocalRepos";
import type { ProjectRepoUnavailableReason } from "@/features/projects/lib/projectRepoAvailability";
import {
  projectShareLink,
  repositoryShareLink,
} from "@/features/projects/lib/projectShareLinks";
import {
  isProjectOwnedByCurrentUser,
  isProjectMine,
  projectPeople,
  type ProjectsFilter,
  type ProjectsViewMode,
} from "@/features/projects/lib/projectsViewHelpers";
import {
  type ProjectSelectionItem,
  selectionItemFromProject,
  selectionItemFromRepository,
} from "@/features/projects/lib/projectSelection";
import { ProjectSelectableGroup } from "@/features/projects/ui/ProjectSelectableGroup";
import {
  EmptyFilteredState,
  ProjectGridCard,
  ProjectListRow,
} from "@/features/projects/ui/ProjectCards";
import {
  RepositoryGridCard,
  RepositoryListRow,
} from "@/features/projects/ui/RepositoryCards";
import { cn } from "@/shared/lib/cn";
import { normalizePubkey } from "@/shared/lib/pubkey";

function CollectionGroup({
  children,
  icon,
  items,
  title,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  items: ProjectSelectionItem[];
  title: string;
}) {
  return (
    <ProjectSelectableGroup
      contentClassName="mt-2 space-y-0"
      count={items.length}
      groupKey={title}
      headerClassName="mx-0 gap-3 px-3"
      headerTestId="projects-collection-group-header"
      icon={icon}
      items={items}
      label={title}
      labelTestId="projects-collection-group-label"
      testId="projects-collection-group"
    >
      {children}
    </ProjectSelectableGroup>
  );
}

function repositoryIsMine(
  repository: Repository,
  currentPubkey: string | undefined,
) {
  if (!currentPubkey) return false;
  const viewer = normalizePubkey(currentPubkey);
  return (
    normalizePubkey(repository.owner) === viewer ||
    repository.contributors.some((pubkey) => normalizePubkey(pubkey) === viewer)
  );
}

function projectSelectionItems(projects: readonly Project[]) {
  return projects.map((project) =>
    selectionItemFromProject({
      channelId: project.projectChannelId,
      id: project.id,
      owner: project.owner,
      shareLink: projectShareLink(project),
      title: project.name,
    }),
  );
}

function repositorySelectionItems(
  rows: ReadonlyArray<{ project: Project; repository: Repository }>,
) {
  return rows.map((row) =>
    selectionItemFromRepository({
      channelId: row.repository.channelId ?? row.project.projectChannelId,
      id: row.repository.id,
      owner: row.repository.owner,
      shareLink: repositoryShareLink(row.repository),
      title: row.repository.name,
    }),
  );
}

export function ProjectsOverviewProjectItems({
  currentPubkey,
  deleteDisabled,
  filter,
  localRepoNames,
  onDelete,
  onOpen,
  onOpenTerminal,
  profiles,
  repositoryUnavailableReasonFor,
  summaries,
  viewMode,
  visibleProjects,
}: {
  currentPubkey: string | undefined;
  deleteDisabled: boolean;
  filter: ProjectsFilter;
  localRepoNames: Set<string>;
  onDelete: (project: Project) => void;
  onOpen: (project: Project) => void;
  onOpenTerminal: (project: Project) => void;
  profiles?: UserProfileLookup;
  repositoryUnavailableReasonFor: (
    project: Project,
  ) => ProjectRepoUnavailableReason | undefined;
  summaries?: Record<string, ProjectActivitySummary>;
  viewMode: ProjectsViewMode;
  visibleProjects: Project[];
}) {
  if (visibleProjects.length === 0) {
    return <EmptyFilteredState />;
  }
  const groups = [
    {
      items: visibleProjects.filter((project) =>
        isProjectMine(project, currentPubkey),
      ),
      title: "Mine",
    },
    {
      items: visibleProjects.filter(
        (project) => !isProjectMine(project, currentPubkey),
      ),
      title: "Other projects",
    },
  ].filter((group) => group.items.length > 0);
  if (viewMode === "grid") {
    return (
      <div className="space-y-0">
        {groups.map((group) => (
          <CollectionGroup
            icon={<Folders className="h-4 w-4" />}
            items={projectSelectionItems(group.items)}
            key={group.title}
            title={group.title}
          >
            <div
              className={cn(
                "grid gap-3 md:grid-cols-2",
                filter !== "all" && "xl:grid-cols-3",
              )}
            >
              {group.items.map((project) => {
                const summary = summaries?.[project.id];
                return (
                  <ProjectGridCard
                    canDelete={isProjectOwnedByCurrentUser(
                      project,
                      currentPubkey,
                    )}
                    deleteDisabled={deleteDisabled}
                    hasLocal={hasLocalCheckout(project, localRepoNames)}
                    key={project.id}
                    onDelete={onDelete}
                    onOpen={onOpen}
                    onOpenTerminal={onOpenTerminal}
                    people={projectPeople(project, summary)}
                    profiles={profiles}
                    project={project}
                    repositoryUnavailableReason={repositoryUnavailableReasonFor(
                      project,
                    )}
                    summary={summary}
                  />
                );
              })}
            </div>
          </CollectionGroup>
        ))}
      </div>
    );
  }
  const selectionRangeItems = projectSelectionItems(visibleProjects);
  return (
    <div className="space-y-0" data-testid="projects-list-container">
      {groups.map((group) => (
        <CollectionGroup
          icon={<Folders className="h-4 w-4" />}
          items={projectSelectionItems(group.items)}
          key={group.title}
          title={group.title}
        >
          <div>
            {group.items.map((project) => {
              const summary = summaries?.[project.id];
              return (
                <ProjectListRow
                  canDelete={isProjectOwnedByCurrentUser(
                    project,
                    currentPubkey,
                  )}
                  deleteDisabled={deleteDisabled}
                  hasLocal={hasLocalCheckout(project, localRepoNames)}
                  key={project.id}
                  onDelete={onDelete}
                  onOpen={onOpen}
                  onOpenTerminal={onOpenTerminal}
                  people={projectPeople(project, summary)}
                  profiles={profiles}
                  project={project}
                  repositoryUnavailableReason={repositoryUnavailableReasonFor(
                    project,
                  )}
                  selectionRangeItems={selectionRangeItems}
                  summary={summary}
                />
              );
            })}
          </div>
        </CollectionGroup>
      ))}
    </div>
  );
}

export function ProjectsOverviewRepositoryItems({
  currentPubkey,
  localRepoNames,
  onOpen,
  onOpenTerminal,
  profiles,
  summaries,
  viewMode,
  visibleRepositories,
}: {
  currentPubkey: string | undefined;
  localRepoNames: Set<string>;
  onOpen: (project: Project, repository: Repository) => void;
  onOpenTerminal: (repository: Repository) => void;
  profiles?: UserProfileLookup;
  summaries?: Record<string, ProjectActivitySummary>;
  viewMode: ProjectsViewMode;
  visibleRepositories: Array<{ project: Project; repository: Repository }>;
}) {
  if (visibleRepositories.length === 0) {
    return <EmptyFilteredState />;
  }
  const groups = [
    {
      items: visibleRepositories.filter(({ repository }) =>
        repositoryIsMine(repository, currentPubkey),
      ),
      title: "Mine",
    },
    {
      items: visibleRepositories.filter(
        ({ repository }) => !repositoryIsMine(repository, currentPubkey),
      ),
      title: "Other repositories",
    },
  ].filter((group) => group.items.length > 0);
  if (viewMode === "grid") {
    return (
      <div className="space-y-0">
        {groups.map((group) => (
          <CollectionGroup
            icon={<FolderGit2 className="h-4 w-4" />}
            items={repositorySelectionItems(group.items)}
            key={group.title}
            title={group.title}
          >
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {group.items.map(({ project, repository }) => (
                <RepositoryGridCard
                  hasLocal={hasLocalRepositoryCheckout(
                    repository,
                    localRepoNames,
                  )}
                  key={repository.repoAddress}
                  onOpen={onOpen}
                  onOpenTerminal={onOpenTerminal}
                  profiles={profiles}
                  project={project}
                  repository={repository}
                  summary={summaries?.[repository.repoAddress]}
                />
              ))}
            </div>
          </CollectionGroup>
        ))}
      </div>
    );
  }
  const selectionRangeItems = repositorySelectionItems(visibleRepositories);
  return (
    <div className="space-y-0" data-testid="projects-list-container">
      {groups.map((group) => (
        <CollectionGroup
          icon={<FolderGit2 className="h-4 w-4" />}
          items={repositorySelectionItems(group.items)}
          key={group.title}
          title={group.title}
        >
          <div>
            {group.items.map(({ project, repository }) => (
              <RepositoryListRow
                hasLocal={hasLocalRepositoryCheckout(
                  repository,
                  localRepoNames,
                )}
                key={repository.repoAddress}
                onOpen={onOpen}
                onOpenTerminal={onOpenTerminal}
                profiles={profiles}
                project={project}
                repository={repository}
                selectionRangeItems={selectionRangeItems}
                summary={summaries?.[repository.repoAddress]}
              />
            ))}
          </div>
        </CollectionGroup>
      ))}
    </div>
  );
}
