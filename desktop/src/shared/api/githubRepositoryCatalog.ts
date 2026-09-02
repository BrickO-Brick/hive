import { invokeTauri } from "@/shared/api/tauri";

type RawGitHubRepositoryCatalogEntry = {
  owner: string;
  name: string;
  description: string;
  url: string;
  clone_url: string;
  default_branch: string;
  language: string | null;
  archived: boolean;
  private: boolean;
  created_at: string;
  updated_at: string;
};

export type GitHubRepositoryCatalogEntry = {
  owner: string;
  name: string;
  description: string;
  url: string;
  cloneUrl: string;
  defaultBranch: string;
  language: string | null;
  archived: boolean;
  private: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * Reads repository metadata through the publishing user's local `gh` session.
 * No GitHub token is returned to, or stored by, the renderer or relay.
 */
export async function listGitHubOwnerRepositories(
  owner: string,
): Promise<GitHubRepositoryCatalogEntry[]> {
  const repositories = await invokeTauri<RawGitHubRepositoryCatalogEntry[]>(
    "list_github_owner_repositories",
    { owner },
  );
  return repositories.map((repository) => ({
    owner: repository.owner,
    name: repository.name,
    description: repository.description,
    url: repository.url,
    cloneUrl: repository.clone_url,
    defaultBranch: repository.default_branch,
    language: repository.language,
    archived: repository.archived,
    private: repository.private,
    createdAt: repository.created_at,
    updatedAt: repository.updated_at,
  }));
}
