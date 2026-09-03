import { useQuery } from "@tanstack/react-query";

import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

export type OneBrickGitHubRepository = {
  owner: string;
  name: string;
  description: string;
  url: string;
  visibility: "private" | "public";
  default_branch: string;
  updated_at: string;
  archived: boolean;
  language: string | null;
};

export type OneBrickGitHubCatalog = {
  organizations: string[];
  repositories: OneBrickGitHubRepository[];
};

export class GitHubCatalogError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "GitHubCatalogError";
  }
}

async function fetchCatalog(): Promise<OneBrickGitHubCatalog> {
  const url = `${relayHttpBaseUrl().replace(/\/+$/, "")}/api/onebrick/github/repositories`;
  const authorization = await makeNip98AuthHeader(url, "GET");
  const response = await fetch(url, {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = (await response.json().catch(() => ({}))) as Partial<
    OneBrickGitHubCatalog & { error: string }
  >;
  if (!response.ok) {
    throw new GitHubCatalogError(
      String(payload.error ?? `HTTP ${response.status}`),
      response.status,
    );
  }
  if (
    !Array.isArray(payload.organizations) ||
    !payload.organizations.every((owner) => typeof owner === "string") ||
    !Array.isArray(payload.repositories)
  ) {
    throw new GitHubCatalogError("invalid_catalog_response", 502);
  }
  if (
    !payload.repositories.every(
      (repository) =>
        typeof repository === "object" &&
        repository !== null &&
        typeof (repository as { owner?: unknown }).owner === "string",
    )
  ) {
    throw new GitHubCatalogError("invalid_catalog_response", 502);
  }
  return payload as OneBrickGitHubCatalog;
}

export function useOneBrickGitHubCatalog() {
  return useQuery({
    queryKey: ["onebrick-github-repositories"],
    queryFn: fetchCatalog,
    retry: false,
    staleTime: 60_000,
  });
}
