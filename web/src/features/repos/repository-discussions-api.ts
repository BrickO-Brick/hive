import { useQuery } from "@tanstack/react-query";

import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

export type RepositoryDiscussion = {
  id: string;
  owner: string;
  repository: string;
  title: string;
  mirrorId: string;
  worktreeId: string;
  branchRef: string;
  baseRef: string;
  baseSha: string;
  currentHeadSha: string;
  proposalRevision: string | null;
  proposalDigest: string | null;
  testEvidence: string[];
  createdBy: string;
  createdAt: string;
};

const endpoint = () =>
  `${relayHttpBaseUrl().replace(/\/+$/, "")}/api/onebrick/repository-discussions`;

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return payload;
}

export async function fetchRepositoryDiscussions(): Promise<
  RepositoryDiscussion[]
> {
  const url = endpoint();
  const authorization = await makeNip98AuthHeader(url, "GET");
  const response = await fetch(url, {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await parseResponse<{ discussions?: unknown }>(response);
  if (!Array.isArray(payload.discussions)) {
    throw new Error("invalid_discussions_response");
  }
  return payload.discussions as RepositoryDiscussion[];
}

export async function createRepositoryDiscussion(input: {
  owner: string;
  repository: string;
  title: string;
  defaultBranch: string;
}): Promise<RepositoryDiscussion> {
  const url = endpoint();
  const body = JSON.stringify({
    owner: input.owner,
    repository: input.repository,
    title: input.title,
    default_branch: input.defaultBranch,
  });
  const authorization = await makeNip98AuthHeader(url, "POST", { body });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(130_000),
  });
  return parseResponse<RepositoryDiscussion>(response);
}

export function useRepositoryDiscussions(enabled = true) {
  return useQuery({
    queryKey: ["onebrick-repository-discussions"],
    queryFn: fetchRepositoryDiscussions,
    enabled,
    retry: false,
    staleTime: 15_000,
  });
}
