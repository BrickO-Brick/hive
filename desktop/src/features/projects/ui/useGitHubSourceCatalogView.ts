import * as React from "react";

import { useGitHubRepositoryCatalogQuery } from "@/features/projects/githubRepositoryCatalog";
import type { ProjectDetailAgentContext } from "@/features/projects/lib/projectDetailAgentContext";
import { matchesProjectsSearch } from "@/features/projects/lib/projectsSearch";
import type {
  ProjectsFilter,
  ProjectsSort,
  ProjectsViewMode,
} from "@/features/projects/lib/projectsViewHelpers";
import type { GitHubRepositoryCatalogEntry } from "@/shared/api/githubRepositoryCatalog";
import { GitHubRepositoryCatalog } from "./GitHubRepositoryCatalog";

export function useGitHubSourceCatalogView(
  filter: ProjectsFilter,
  searchQuery: string,
  sort: ProjectsSort,
) {
  const query = useGitHubRepositoryCatalogQuery(filter === "sources");
  const repositories = React.useMemo(() => {
    return (query.data ?? [])
      .filter((repository) =>
        matchesProjectsSearch(searchQuery, [
          repository.name,
          repository.description,
          repository.language ?? "",
          repository.defaultBranch,
        ]),
      )
      .sort((left, right) => {
        if (sort === "name") return left.name.localeCompare(right.name);
        if (sort === "created") {
          return right.createdAt.localeCompare(left.createdAt);
        }
        return right.updatedAt.localeCompare(left.updatedAt);
      });
  }, [query.data, searchQuery, sort]);

  return { query, repositories };
}

export function useGitHubSourceRepositorySelection(
  setAgentContext: React.Dispatch<
    React.SetStateAction<ProjectDetailAgentContext | null>
  >,
) {
  const selectRepository = React.useCallback(
    (
      repository: GitHubRepositoryCatalogEntry,
      action: "Discuss" | "Develop",
    ) => {
      setAgentContext({
        projectName: repository.owner,
        repoAddress: `github:${repository.owner}/${repository.name}`,
        repositoryName: repository.name,
        sourceRepository: {
          owner: repository.owner,
          name: repository.name,
          url: repository.url,
          cloneUrl: repository.cloneUrl,
          defaultBranch: repository.defaultBranch,
          language: repository.language,
        },
        source: "remote",
        view: `${action} ${repository.name}`,
      });
    },
    [setAgentContext],
  );
  const onDiscuss = React.useCallback(
    (repository: GitHubRepositoryCatalogEntry) =>
      selectRepository(repository, "Discuss"),
    [selectRepository],
  );
  const onDevelop = React.useCallback(
    (repository: GitHubRepositoryCatalogEntry) =>
      selectRepository(repository, "Develop"),
    [selectRepository],
  );

  return { onDevelop, onDiscuss };
}

export function useGitHubSourceCatalogElement(input: {
  query: ReturnType<typeof useGitHubRepositoryCatalogQuery>;
  searchQuery: string;
  setAgentContext: React.Dispatch<
    React.SetStateAction<ProjectDetailAgentContext | null>
  >;
  sort: ProjectsSort;
  viewMode: ProjectsViewMode;
}) {
  const { onDevelop, onDiscuss } = useGitHubSourceRepositorySelection(
    input.setAgentContext,
  );
  return React.createElement(GitHubRepositoryCatalog, {
    error: input.query.error,
    isLoading: input.query.isLoading,
    onDevelop,
    onDiscuss,
    onRetry: () => void input.query.refetch(),
    repositories: input.query.data ?? [],
    searchQuery: input.searchQuery,
    sort: input.sort,
    viewMode: input.viewMode,
  });
}

export function useDefaultSourcesWhenNoProjects(input: {
  filter: ProjectsFilter;
  onFilterChange: (filter: ProjectsFilter) => void;
  projectCount: number;
  projectsLoading: boolean;
}) {
  const { filter, onFilterChange, projectCount, projectsLoading } = input;
  React.useEffect(() => {
    if (projectsLoading || projectCount > 0 || filter === "sources") return;
    onFilterChange("sources");
  }, [filter, onFilterChange, projectCount, projectsLoading]);
}
