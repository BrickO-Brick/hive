import { useQuery } from "@tanstack/react-query";

import { listGitHubOwnerRepositories } from "@/shared/api/githubRepositoryCatalog";

export const BRICKO_GITHUB_OWNER = "BrickO-Brick";

export function useGitHubRepositoryCatalogQuery(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ["projects", "github-repository-catalog", BRICKO_GITHUB_OWNER],
    queryFn: () => listGitHubOwnerRepositories(BRICKO_GITHUB_OWNER),
    staleTime: 5 * 60_000,
    retry: false,
  });
}
