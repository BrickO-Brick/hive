import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Code2,
  ExternalLink,
  Loader2,
  LockKeyhole,
  MessageSquareText,
  RefreshCw,
} from "lucide-react";
import * as React from "react";

import {
  groupClassifiedGitHubRepositories,
  type ClassifiedGitHubRepository,
} from "@/features/projects/lib/githubRepositoryClassification";
import { matchesProjectsSearch } from "@/features/projects/lib/projectsSearch";
import type {
  ProjectsSort,
  ProjectsViewMode,
} from "@/features/projects/lib/projectsViewHelpers";
import type { GitHubRepositoryCatalogEntry } from "@/shared/api/githubRepositoryCatalog";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";
import { GitHubMark } from "./GitHubMark";

function formatCatalogUpdatedAt(updatedAt: string) {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return "Unknown activity";
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function CatalogRepositoryRow({
  repository,
  onDiscuss,
  onDevelop,
}: {
  repository: ClassifiedGitHubRepository;
  onDiscuss: (repository: GitHubRepositoryCatalogEntry) => void;
  onDevelop: (repository: GitHubRepositoryCatalogEntry) => void;
}) {
  return (
    <article
      className="group flex min-w-0 items-center gap-3 border-b border-border/45 px-3 py-3 last:border-b-0 hover:bg-muted/25"
      data-testid="github-source-repository-row"
    >
      <GitHubMark className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-sm font-medium text-foreground">
            {repository.name}
          </h3>
          {repository.private ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/65 px-1.5 py-0.5 text-2xs text-muted-foreground">
              <LockKeyhole className="h-2.5 w-2.5" />
              Private
            </span>
          ) : null}
          {repository.archived ? (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
              Archived
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {repository.description || "No repository description yet."}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground/75">
          <span>{repository.language ?? "Language not detected"}</span>
          <span>{repository.defaultBranch}</span>
          <span>Updated {formatCatalogUpdatedAt(repository.updatedAt)}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          aria-label={`Develop ${repository.name} with BrickO`}
          className="h-7 gap-1.5 px-2 text-xs"
          data-testid="github-source-develop"
          onClick={() => onDevelop(repository)}
          size="sm"
          type="button"
          variant="default"
        >
          <Code2 className="h-3.5 w-3.5" />
          Develop
        </Button>
        <Button
          aria-label={`Discuss ${repository.name} with BrickO`}
          className="h-7 gap-1.5 px-2 text-xs"
          data-testid="github-source-discuss"
          onClick={() => onDiscuss(repository)}
          size="sm"
          type="button"
          variant="outline"
        >
          <MessageSquareText className="h-3.5 w-3.5" />
          Discuss
        </Button>
        <Button
          aria-label={`Open ${repository.name} on GitHub`}
          className="h-7 w-7 px-0"
          onClick={() => void openUrl(repository.url)}
          size="icon"
          title="Open on GitHub"
          type="button"
          variant="ghost"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      </div>
    </article>
  );
}

function CatalogRepositoryCard({
  repository,
  onDiscuss,
  onDevelop,
}: {
  repository: ClassifiedGitHubRepository;
  onDiscuss: (repository: GitHubRepositoryCatalogEntry) => void;
  onDevelop: (repository: GitHubRepositoryCatalogEntry) => void;
}) {
  return (
    <article
      className="flex min-h-44 min-w-0 flex-col rounded-xl border border-border/65 bg-card p-4 shadow-xs"
      data-testid="github-source-repository-card"
    >
      <div className="flex items-center justify-between gap-3">
        <GitHubMark className="h-5 w-5 text-muted-foreground" />
        <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          {repository.private ? <LockKeyhole className="h-3 w-3" /> : null}
          {repository.private ? "Private" : "Public"}
        </div>
      </div>
      <h3 className="mt-3 truncate text-sm font-semibold text-foreground">
        {repository.name}
      </h3>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
        {repository.description || "No repository description yet."}
      </p>
      <div className="mt-auto flex items-end justify-between gap-3 pt-4">
        <div className="min-w-0 text-2xs text-muted-foreground/75">
          <div className="truncate">
            {repository.language ?? "Language not detected"} ·{" "}
            {repository.defaultBranch}
          </div>
          <div>Updated {formatCatalogUpdatedAt(repository.updatedAt)}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            aria-label={`Discuss ${repository.name} with BrickO`}
            className="h-7 w-7 px-0"
            data-testid="github-source-discuss"
            onClick={() => onDiscuss(repository)}
            size="icon"
            title="Discuss with BrickO"
            type="button"
            variant="ghost"
          >
            <MessageSquareText className="h-3.5 w-3.5" />
          </Button>
          <Button
            aria-label={`Develop ${repository.name} with BrickO`}
            className="h-7 gap-1.5 px-2 text-xs"
            data-testid="github-source-develop"
            onClick={() => onDevelop(repository)}
            size="sm"
            type="button"
            variant="default"
          >
            <Code2 className="h-3.5 w-3.5" />
            Develop
          </Button>
        </div>
      </div>
    </article>
  );
}

export function GitHubRepositoryCatalog({
  error,
  isLoading,
  onDiscuss,
  onDevelop,
  onRetry,
  repositories,
  searchQuery,
  sort,
  viewMode,
}: {
  error: Error | null;
  isLoading: boolean;
  onDiscuss: (repository: GitHubRepositoryCatalogEntry) => void;
  onDevelop: (repository: GitHubRepositoryCatalogEntry) => void;
  onRetry: () => void;
  repositories: GitHubRepositoryCatalogEntry[];
  searchQuery: string;
  sort: ProjectsSort;
  viewMode: ProjectsViewMode;
}) {
  const visibleRepositories = React.useMemo(() => {
    const matching = repositories.filter((repository) =>
      matchesProjectsSearch(searchQuery, [
        repository.name,
        repository.description,
        repository.language ?? "",
        repository.defaultBranch,
      ]),
    );
    return matching.sort((left, right) => {
      if (sort === "name") return left.name.localeCompare(right.name);
      if (sort === "created")
        return right.createdAt.localeCompare(left.createdAt);
      return right.updatedAt.localeCompare(left.updatedAt);
    });
  }, [repositories, searchQuery, sort]);
  const groups = React.useMemo(
    () => groupClassifiedGitHubRepositories(visibleRepositories),
    [visibleRepositories],
  );

  if (isLoading) {
    return (
      <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading repositories from the local GitHub session…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border p-6 text-center">
        <div>
          <p className="text-sm font-medium text-foreground">
            GitHub sources are unavailable
          </p>
          <p className="mt-1 max-w-xl text-xs text-muted-foreground">
            {error.message}
          </p>
        </div>
        <Button
          className="gap-1.5"
          onClick={onRetry}
          size="sm"
          variant="outline"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </Button>
      </div>
    );
  }
  if (visibleRepositories.length === 0) {
    return (
      <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
        {searchQuery.trim()
          ? "No source repositories match this search."
          : "No repositories are visible to this GitHub user."}
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="github-source-catalog">
      <div className="rounded-lg border border-border/55 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <strong className="font-medium text-foreground">
          {visibleRepositories.length} BrickO-Brick repositories
        </strong>{" "}
        grouped from repository metadata. Categories are discussion-ready
        proposals, not permission or ownership decisions.
      </div>
      {groups.map((group) => (
        <section key={group.category.id}>
          <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
            <div className="min-w-0">
              <h2 className="text-sm font-medium text-foreground">
                {group.category.label}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {group.category.description}
              </p>
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {group.repositories.length}
            </span>
          </div>
          <div
            className={cn(
              viewMode === "grid"
                ? "grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr))]"
                : "overflow-hidden rounded-xl border border-border/55",
            )}
          >
            {group.repositories.map((repository) =>
              viewMode === "grid" ? (
                <CatalogRepositoryCard
                  key={repository.url}
                  onDiscuss={onDiscuss}
                  onDevelop={onDevelop}
                  repository={repository}
                />
              ) : (
                <CatalogRepositoryRow
                  key={repository.url}
                  onDiscuss={onDiscuss}
                  onDevelop={onDevelop}
                  repository={repository}
                />
              ),
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
