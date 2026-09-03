import { invokeTauri } from "@/shared/api/tauri";

type RawWorkspaceDiffFile = {
  path: string;
  additions: number;
  deletions: number;
  patch: string;
  truncated: boolean;
};

type RawGitHubRepositoryWorkspace = {
  owner: string;
  name: string;
  path: string;
  branch: string;
  base_commit: string;
  base_tree: string;
  result_tree: string;
  dirty: boolean;
  additions: number;
  deletions: number;
  files: RawWorkspaceDiffFile[];
};

type RawGitHubRepositoryTestResult = {
  exit_code: number | null;
  passed: boolean;
  duration_ms: number;
  stdout: string;
  stderr: string;
  tested_tree: string;
  finished_tree: string;
  tree_changed: boolean;
};

type RawGitHubRepositoryPublicationIdentity = {
  git_name: string | null;
  git_email: string | null;
  github_login: string | null;
  local_commit_ready: boolean;
  remote_publication_ready: boolean;
  blockers: string[];
};

type RawGitHubRepositoryCommitResult = {
  branch: string;
  commit: string;
  result_tree: string;
  author_name: string;
  author_email: string;
  signed_off_by: string;
  checked_out: boolean;
  index_synchronized: boolean;
  warning: string | null;
};

type RawGitHubRepositoryPublishResult = {
  branch: string;
  commit: string;
  base_branch: string;
  github_login: string;
  pull_request_number: number;
  pull_request_url: string;
  draft: boolean;
  branch_pushed: boolean;
};

export type GitHubRepositoryWorkspace = {
  owner: string;
  name: string;
  path: string;
  branch: string;
  baseCommit: string;
  baseTree: string;
  resultTree: string;
  dirty: boolean;
  additions: number;
  deletions: number;
  files: RawWorkspaceDiffFile[];
};

export type GitHubRepositoryTestResult = {
  exitCode: number | null;
  passed: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  testedTree: string;
  finishedTree: string;
  treeChanged: boolean;
};

export type GitHubRepositoryPublicationIdentity = {
  gitName: string | null;
  gitEmail: string | null;
  githubLogin: string | null;
  localCommitReady: boolean;
  remotePublicationReady: boolean;
  blockers: string[];
};

export type GitHubRepositoryCommitResult = {
  branch: string;
  commit: string;
  resultTree: string;
  authorName: string;
  authorEmail: string;
  signedOffBy: string;
  checkedOut: boolean;
  indexSynchronized: boolean;
  warning: string | null;
};

export type GitHubRepositoryPublishResult = {
  branch: string;
  commit: string;
  baseBranch: string;
  githubLogin: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  draft: boolean;
  branchPushed: boolean;
};

function fromRawWorkspace(
  workspace: RawGitHubRepositoryWorkspace,
): GitHubRepositoryWorkspace {
  return {
    owner: workspace.owner,
    name: workspace.name,
    path: workspace.path,
    branch: workspace.branch,
    baseCommit: workspace.base_commit,
    baseTree: workspace.base_tree,
    resultTree: workspace.result_tree,
    dirty: workspace.dirty,
    additions: workspace.additions,
    deletions: workspace.deletions,
    files: workspace.files,
  };
}

export async function inspectGitHubRepositoryWorkspace(input: {
  owner: string;
  name: string;
  reposDir?: string | null;
  workspaceId: string;
}): Promise<GitHubRepositoryWorkspace | null> {
  const workspace = await invokeTauri<RawGitHubRepositoryWorkspace | null>(
    "inspect_github_repository_workspace",
    {
      owner: input.owner,
      name: input.name,
      reposDir: input.reposDir ?? null,
      workspaceId: input.workspaceId,
    },
  );
  return workspace ? fromRawWorkspace(workspace) : null;
}

export async function prepareGitHubRepositoryWorkspace(input: {
  owner: string;
  name: string;
  reposDir?: string | null;
  workspaceId: string;
  baseRef: string;
}): Promise<GitHubRepositoryWorkspace> {
  const workspace = await invokeTauri<RawGitHubRepositoryWorkspace>(
    "prepare_github_repository_workspace",
    {
      owner: input.owner,
      name: input.name,
      reposDir: input.reposDir ?? null,
      workspaceId: input.workspaceId,
      baseRef: input.baseRef,
    },
  );
  return fromRawWorkspace(workspace);
}

export async function runGitHubRepositoryTest(input: {
  owner: string;
  name: string;
  reposDir?: string | null;
  workspaceId: string;
  command: string;
  expectedResultTree: string;
  timeoutSeconds?: number;
}): Promise<GitHubRepositoryTestResult> {
  const result = await invokeTauri<RawGitHubRepositoryTestResult>(
    "run_github_repository_test",
    {
      owner: input.owner,
      name: input.name,
      reposDir: input.reposDir ?? null,
      workspaceId: input.workspaceId,
      command: input.command,
      expectedResultTree: input.expectedResultTree,
      timeoutSeconds: input.timeoutSeconds ?? 300,
    },
  );
  return {
    exitCode: result.exit_code,
    passed: result.passed,
    durationMs: result.duration_ms,
    stdout: result.stdout,
    stderr: result.stderr,
    testedTree: result.tested_tree,
    finishedTree: result.finished_tree,
    treeChanged: result.tree_changed,
  };
}

export async function getGitHubRepositoryPublicationIdentity(input: {
  owner: string;
  name: string;
  reposDir?: string | null;
  workspaceId: string;
}): Promise<GitHubRepositoryPublicationIdentity> {
  const result = await invokeTauri<RawGitHubRepositoryPublicationIdentity>(
    "get_github_repository_publication_identity",
    {
      owner: input.owner,
      name: input.name,
      reposDir: input.reposDir ?? null,
      workspaceId: input.workspaceId,
    },
  );
  return {
    gitName: result.git_name,
    gitEmail: result.git_email,
    githubLogin: result.github_login,
    localCommitReady: result.local_commit_ready,
    remotePublicationReady: result.remote_publication_ready,
    blockers: result.blockers,
  };
}

export async function commitGitHubRepositoryChange(input: {
  owner: string;
  name: string;
  reposDir?: string | null;
  workspaceId: string;
  expectedBaseCommit: string;
  expectedResultTree: string;
  branchName: string;
  message: string;
}): Promise<GitHubRepositoryCommitResult> {
  const result = await invokeTauri<RawGitHubRepositoryCommitResult>(
    "commit_github_repository_change",
    {
      owner: input.owner,
      name: input.name,
      reposDir: input.reposDir ?? null,
      workspaceId: input.workspaceId,
      expectedBaseCommit: input.expectedBaseCommit,
      expectedResultTree: input.expectedResultTree,
      branchName: input.branchName,
      message: input.message,
    },
  );
  return {
    branch: result.branch,
    commit: result.commit,
    resultTree: result.result_tree,
    authorName: result.author_name,
    authorEmail: result.author_email,
    signedOffBy: result.signed_off_by,
    checkedOut: result.checked_out,
    indexSynchronized: result.index_synchronized,
    warning: result.warning,
  };
}

export async function publishGitHubRepositoryChange(input: {
  owner: string;
  name: string;
  reposDir?: string | null;
  workspaceId: string;
  expectedCommit: string;
  expectedResultTree: string;
  branchName: string;
  baseBranch: string;
  expectedGitHubLogin: string;
  remotePublicationAuthorized: boolean;
  title: string;
  body: string;
}): Promise<GitHubRepositoryPublishResult> {
  const result = await invokeTauri<RawGitHubRepositoryPublishResult>(
    "publish_github_repository_change",
    {
      owner: input.owner,
      name: input.name,
      reposDir: input.reposDir ?? null,
      workspaceId: input.workspaceId,
      expectedCommit: input.expectedCommit,
      expectedResultTree: input.expectedResultTree,
      branchName: input.branchName,
      baseBranch: input.baseBranch,
      expectedGithubLogin: input.expectedGitHubLogin,
      remotePublicationAuthorized: input.remotePublicationAuthorized,
      title: input.title,
      body: input.body,
    },
  );
  return {
    branch: result.branch,
    commit: result.commit,
    baseBranch: result.base_branch,
    githubLogin: result.github_login,
    pullRequestNumber: result.pull_request_number,
    pullRequestUrl: result.pull_request_url,
    draft: result.draft,
    branchPushed: result.branch_pushed,
  };
}
