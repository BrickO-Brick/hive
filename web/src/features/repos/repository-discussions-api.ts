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
  status: "active" | "cleanup_pending" | "closed";
  completionEvidence: string | null;
  closedBy: string | null;
  closedAt: string | null;
  workspaceCleanedAt: string | null;
  mirrorCleaned: boolean;
};

export type WorkspaceFileSummary = {
  path: string;
  status: string | null;
};

export type DiscussionWorkspace = {
  discussionId: string;
  currentHeadSha: string;
  dirty: boolean;
  files: WorkspaceFileSummary[];
  changes: WorkspaceFileSummary[];
  totalFiles: number;
  hasMoreFiles: boolean;
};

export type DiscussionWorkspaceFileSearch = {
  files: WorkspaceFileSummary[];
  totalMatches: number;
  hasMoreFiles: boolean;
};

export type DiscussionWorkspaceFile = {
  path: string;
  content: string;
  digest: string;
};

export type DiscussionWorkspaceDiff = {
  currentHeadSha: string;
  diff: string;
  additions: number;
  deletions: number;
  changedFiles: number;
};

const endpoint = () =>
  `${relayHttpBaseUrl().replace(/\/+$/, "")}/api/onebrick/repository-discussions`;

export const repositoryDiscussionsQueryKey = [
  "onebrick-repository-discussions",
] as const;

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return payload;
}

async function signedGet<T>(url: string): Promise<T> {
  const authorization = await makeNip98AuthHeader(url, "GET");
  const response = await fetch(url, {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(20_000),
  });
  return parseResponse<T>(response);
}

async function signedPost<T>(url: string, payload: unknown): Promise<T> {
  const body = JSON.stringify(payload);
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
  return parseResponse<T>(response);
}

const workspaceEndpoint = (discussionId: string, suffix = "") =>
  `${endpoint()}/${encodeURIComponent(discussionId)}/workspace${suffix}`;

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
    queryKey: repositoryDiscussionsQueryKey,
    queryFn: fetchRepositoryDiscussions,
    enabled,
    retry: false,
    staleTime: 15_000,
  });
}

export function fetchDiscussionWorkspace(
  discussionId: string,
): Promise<DiscussionWorkspace> {
  return signedGet(workspaceEndpoint(discussionId));
}

export function readDiscussionWorkspaceFile(
  discussionId: string,
  path: string,
): Promise<DiscussionWorkspaceFile> {
  return signedPost(workspaceEndpoint(discussionId, "/file/read"), { path });
}

export function searchDiscussionWorkspaceFiles(
  discussionId: string,
  query: string,
): Promise<DiscussionWorkspaceFileSearch> {
  return signedPost(workspaceEndpoint(discussionId, "/files/search"), {
    query,
  });
}

export function writeDiscussionWorkspaceFile(
  discussionId: string,
  input: { path: string; content: string; expectedDigest: string },
): Promise<DiscussionWorkspaceFile> {
  return signedPost(workspaceEndpoint(discussionId, "/file/write"), input);
}

export function fetchDiscussionWorkspaceDiff(
  discussionId: string,
): Promise<DiscussionWorkspaceDiff> {
  return signedGet(workspaceEndpoint(discussionId, "/diff"));
}

export function commitDiscussionWorkspace(
  discussionId: string,
  input: { message: string; expectedHeadSha: string },
): Promise<RepositoryDiscussion> {
  return signedPost(workspaceEndpoint(discussionId, "/commit"), input);
}

export function closeRepositoryDiscussion(
  discussionId: string,
  input: { expectedHeadSha: string; completionEvidence?: string },
): Promise<RepositoryDiscussion> {
  return signedPost(`${endpoint()}/${encodeURIComponent(discussionId)}/close`, {
    expectedHeadSha: input.expectedHeadSha,
    completionEvidence: input.completionEvidence || null,
  });
}
