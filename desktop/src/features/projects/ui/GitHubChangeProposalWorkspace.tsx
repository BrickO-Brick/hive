import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  FolderGit2,
  GitBranch,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  TestTube2,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import {
  addChangeProposalScenario,
  approveChangeProposal,
  buildChangeProposalApprovalMessage,
  type ChangeProposal,
  createChangeProposal,
  markChangeProposalReady,
  recordTestScenarioResult,
  removeChangeProposalScenario,
  reviseChangeProposal,
  startTestScenario,
  updateChangeProposalScenario,
  updateChangeProposalSummary,
} from "@/features/projects/lib/changeProposal";
import type { ProjectDetailAgentContext } from "@/features/projects/lib/projectDetailAgentContext";
import {
  inspectGitHubRepositoryWorkspace,
  prepareGitHubRepositoryWorkspace,
  runGitHubRepositoryTest,
  type GitHubRepositoryCommitResult,
  type GitHubRepositoryPublishResult,
  type GitHubRepositoryWorkspace,
} from "@/shared/api/githubRepositoryWorkspace";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import { ProposalFileEditor } from "./ProposalFileEditor";

type SourceRepository = NonNullable<
  ProjectDetailAgentContext["sourceRepository"]
>;
type ChangeProposalAgentContext = NonNullable<
  ProjectDetailAgentContext["changeProposal"]
>;

const GitHubPublicationGate = React.lazy(() =>
  import("@/features/projects/ui/GitHubPublicationGate").then((module) => ({
    default: module.GitHubPublicationGate,
  })),
);

function shortObjectId(value: string | null | undefined) {
  return value?.slice(0, 12) ?? "—";
}

function suggestedCommand(language: string | null) {
  const normalized = language?.toLowerCase();
  if (normalized === "rust") return "cargo test";
  if (normalized === "go") return "go test ./...";
  if (normalized === "dart") return "flutter test";
  if (normalized === "python") return "pytest";
  if (["javascript", "typescript", "vue"].includes(normalized ?? "")) {
    return "pnpm test";
  }
  return "";
}

function proposalFromWorkspace(
  repository: SourceRepository,
  workspace: GitHubRepositoryWorkspace,
) {
  const command = suggestedCommand(repository.language);
  return createChangeProposal({
    id: `${repository.owner}/${repository.name}:${workspace.baseCommit}`,
    repository: {
      owner: repository.owner,
      name: repository.name,
      url: repository.url,
    },
    baseCommit: workspace.baseCommit,
    resultTree: workspace.resultTree,
    targetBranch: workspace.branch || repository.defaultBranch,
    summary: `Review the current local changes for ${repository.owner}/${repository.name}.`,
    files: workspace.files.map(({ path, additions, deletions }) => ({
      path,
      additions,
      deletions,
    })),
    scenarios: command
      ? [
          {
            id: "TS-1",
            title: "Focused repository tests",
            command,
            given: ["The exact proposal tree is checked out locally"],
            when: ["The user explicitly runs this command"],
            expectedOutcomes: [
              "The command exits successfully without changing the proposal tree",
            ],
          },
        ]
      : [],
  });
}

function evidenceFromResult(stdout: string, stderr: string) {
  const evidence = [stdout.trim(), stderr.trim()].filter(Boolean);
  return evidence.length > 0 ? evidence : ["Command produced no output."];
}

function scenarioBadge(status: string) {
  if (status === "passed") return "success" as const;
  if (status === "failed" || status === "blocked") {
    return "destructive" as const;
  }
  if (status === "running") return "info" as const;
  if (status === "stale") return "warning" as const;
  return "secondary" as const;
}

const ProposalDiffFile = React.memo(function ProposalDiffFile({
  file,
}: {
  file: GitHubRepositoryWorkspace["files"][number];
}) {
  return (
    <details className="group overflow-hidden rounded-lg border border-border/60 bg-background">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs hover:bg-muted/30">
        <Code2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{file.path}</span>
        <span className="text-emerald-600">+{file.additions}</span>
        <span className="text-destructive">-{file.deletions}</span>
      </summary>
      <pre className="max-h-96 overflow-auto border-border/50 border-t bg-muted/10 p-3 font-mono text-xs leading-5">
        {file.patch || "No textual diff is available for this file."}
        {file.truncated ? "\n[diff truncated by Buzz]" : ""}
      </pre>
    </details>
  );
});

const ProposalScenarioEditor = React.memo(function ProposalScenarioEditor({
  disabled,
  onRemove,
  onRun,
  onUpdate,
  scenario,
}: {
  disabled: boolean;
  onRemove: () => void;
  onRun: () => void;
  onUpdate: (input: {
    title: string;
    command: string;
    expectedOutcomes: string[];
  }) => void;
  scenario: ChangeProposal["scenarios"][number];
}) {
  const titleRef = React.useRef<HTMLInputElement | null>(null);
  const commandRef = React.useRef<HTMLInputElement | null>(null);
  const expectedRef = React.useRef<HTMLInputElement | null>(null);
  const commitEdits = React.useCallback(() => {
    const title = titleRef.current?.value.trim() ?? "";
    const command = commandRef.current?.value.trim() ?? "";
    const expected = expectedRef.current?.value.trim() ?? "";
    if (
      title === scenario.title &&
      command === scenario.command &&
      expected === (scenario.expectedOutcomes[0] ?? "")
    ) {
      return;
    }
    onUpdate({
      title,
      command,
      expectedOutcomes: expected ? [expected] : [],
    });
  }, [onUpdate, scenario.command, scenario.expectedOutcomes, scenario.title]);

  return (
    <div
      className="space-y-3 rounded-xl border border-border/60 bg-background p-3"
      data-testid="github-proposal-test-scenario"
    >
      <div className="flex items-center gap-2">
        <TestTube2 className="h-4 w-4 text-muted-foreground" />
        <span className="text-2xs font-medium uppercase tracking-[0.15em] text-muted-foreground">
          {scenario.id}
        </span>
        <Badge className="ml-auto" variant={scenarioBadge(scenario.status)}>
          {scenario.status}
        </Badge>
      </div>
      <Input
        aria-label={`${scenario.id} title`}
        defaultValue={scenario.title}
        disabled={disabled}
        onBlur={commitEdits}
        ref={titleRef}
      />
      <Input
        aria-label={`${scenario.id} command`}
        className="font-mono text-xs"
        defaultValue={scenario.command}
        disabled={disabled}
        onBlur={commitEdits}
        placeholder="Command recommended in the BrickO discussion"
        ref={commandRef}
      />
      <Input
        aria-label={`${scenario.id} expected result`}
        defaultValue={scenario.expectedOutcomes[0] ?? ""}
        disabled={disabled}
        onBlur={commitEdits}
        placeholder="Expected observable result"
        ref={expectedRef}
      />
      {scenario.actual ? (
        <div className="rounded-lg bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Actual:</span>{" "}
          {scenario.actual}
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <Button
          aria-label={`Remove ${scenario.id}`}
          className="h-8 w-8"
          disabled={disabled}
          onClick={onRemove}
          size="icon"
          type="button"
          variant="ghost"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          className="gap-1.5"
          data-testid="github-proposal-run-test"
          disabled={disabled || !scenario.command.trim()}
          onClick={onRun}
          size="sm"
          type="button"
          variant="outline"
        >
          {scenario.status === "running" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Run once
        </Button>
      </div>
    </div>
  );
});

export function GitHubChangeProposalWorkspace({
  approverPubkey,
  onContextChange,
  onRecordApproval,
  repository,
  reposDir,
  workspaceId,
}: {
  approverPubkey: string | null;
  onContextChange: (context: ChangeProposalAgentContext | null) => void;
  onRecordApproval: (content: string) => Promise<void>;
  repository: SourceRepository;
  reposDir?: string | null;
  workspaceId: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [proposal, setProposal] = React.useState<ChangeProposal | null>(null);
  const [committedProposal, setCommittedProposal] =
    React.useState<ChangeProposal | null>(null);
  const [commitResult, setCommitResult] =
    React.useState<GitHubRepositoryCommitResult | null>(null);
  const [publicationResult, setPublicationResult] =
    React.useState<GitHubRepositoryPublishResult | null>(null);
  const [fileEditorDirty, setFileEditorDirty] = React.useState(false);
  const [isRecordingApproval, setIsRecordingApproval] = React.useState(false);
  const scenarioSequence = React.useRef(2);
  const queryClient = useQueryClient();
  const queryKey = React.useMemo(
    () => [
      "github-source-workspace",
      repository.owner,
      repository.name,
      reposDir ?? "default",
      workspaceId,
    ],
    [repository.name, repository.owner, reposDir, workspaceId],
  );
  const workspaceQuery = useQuery({
    queryKey,
    queryFn: () =>
      inspectGitHubRepositoryWorkspace({
        owner: repository.owner,
        name: repository.name,
        reposDir,
        workspaceId,
      }),
    staleTime: 5_000,
    retry: false,
  });
  const prepareMutation = useMutation({
    mutationFn: () =>
      prepareGitHubRepositoryWorkspace({
        owner: repository.owner,
        name: repository.name,
        reposDir,
        workspaceId,
        baseRef: repository.defaultBranch,
      }),
    onSuccess: (workspace) => {
      queryClient.setQueryData(queryKey, workspace);
      toast.success(
        workspace.dirty
          ? "Local workspace is ready with existing changes."
          : "Local workspace is ready for BrickO.",
      );
    },
  });
  const runTestMutation = useMutation({
    mutationFn: (input: { command: string; resultTree: string }) =>
      runGitHubRepositoryTest({
        owner: repository.owner,
        name: repository.name,
        reposDir,
        workspaceId,
        command: input.command,
        expectedResultTree: input.resultTree,
      }),
  });
  const refetchWorkspace = workspaceQuery.refetch;
  const runTest = runTestMutation.mutateAsync;
  const workspace = workspaceQuery.data ?? null;

  React.useEffect(() => {
    if (!workspace) {
      setProposal(null);
      return;
    }
    setProposal((current) => {
      if (!workspace.dirty) {
        if (
          current?.status === "approved" &&
          workspace.baseTree === current.resultTree
        ) {
          return current;
        }
        return null;
      }
      if (!current || current.baseCommit !== workspace.baseCommit) {
        return proposalFromWorkspace(repository, workspace);
      }
      if (current.resultTree === workspace.resultTree) return current;
      return reviseChangeProposal(current, {
        expectedVersion: current.version,
        resultTree: workspace.resultTree,
        files: workspace.files.map(({ path, additions, deletions }) => ({
          path,
          additions,
          deletions,
        })),
      });
    });
  }, [repository, workspace]);

  React.useEffect(() => {
    if (
      commitResult &&
      proposal &&
      proposal.resultTree !== commitResult.resultTree
    ) {
      setCommitResult(null);
      setCommittedProposal(null);
      setPublicationResult(null);
    }
  }, [commitResult, proposal]);

  React.useEffect(() => {
    if (!workspace) {
      onContextChange(null);
      return;
    }
    onContextChange({
      workspacePath: workspace.path,
      baseCommit: workspace.baseCommit,
      resultTree: workspace.resultTree,
      summary: proposal?.summary ?? "No local changes yet.",
      files: workspace.files.map(({ path, additions, deletions }) => ({
        path,
        additions,
        deletions,
      })),
      scenarios:
        proposal?.scenarios.map((scenario) => ({
          title: scenario.title,
          command: scenario.command,
          status: scenario.status,
          testedTree: scenario.testedTree,
        })) ?? [],
      commit: commitResult
        ? {
            branch: commitResult.branch,
            commit: commitResult.commit,
            authorName: commitResult.authorName,
            indexSynchronized: commitResult.indexSynchronized,
          }
        : undefined,
      publication: publicationResult
        ? {
            githubLogin: publicationResult.githubLogin,
            pullRequestUrl: publicationResult.pullRequestUrl,
            draft: publicationResult.draft,
          }
        : undefined,
    });
  }, [commitResult, onContextChange, proposal, publicationResult, workspace]);

  const refreshWorkspace = React.useCallback(async () => {
    const result = await refetchWorkspace();
    if (result.data) toast.success("Proposal refreshed from the local tree.");
  }, [refetchWorkspace]);

  const recordFileSave = React.useCallback(
    (nextWorkspace: GitHubRepositoryWorkspace) => {
      setFileEditorDirty(false);
      queryClient.setQueryData(queryKey, nextWorkspace);
    },
    [queryClient, queryKey],
  );

  const updateScenario = React.useCallback(
    (
      scenarioId: string,
      input: { title: string; command: string; expectedOutcomes: string[] },
    ) => {
      setProposal((current) =>
        current
          ? updateChangeProposalScenario(current, {
              expectedVersion: current.version,
              scenarioId,
              ...input,
            })
          : current,
      );
    },
    [],
  );

  const runScenario = React.useCallback(
    async (scenarioId: string) => {
      const current = proposal;
      const scenario = current?.scenarios.find(
        (candidate) => candidate.id === scenarioId,
      );
      if (!current || !scenario || !workspace) return;
      const running = startTestScenario(current, {
        expectedVersion: current.version,
        scenarioId,
        resultTree: current.resultTree,
      });
      setProposal(running);
      try {
        const result = await runTest({
          command: scenario.command,
          resultTree: current.resultTree,
        });
        if (result.treeChanged) {
          await refetchWorkspace();
          toast.warning(
            "The test changed the workspace. Previous evidence is stale; review the new tree.",
          );
          return;
        }
        setProposal((latest) => {
          if (
            !latest ||
            latest.version !== running.version ||
            latest.resultTree !== result.testedTree
          ) {
            return latest;
          }
          return recordTestScenarioResult(latest, {
            expectedVersion: latest.version,
            scenarioId,
            resultTree: result.testedTree,
            status: result.passed ? "passed" : "failed",
            expected:
              scenario.expectedOutcomes.join("; ") ||
              "Command exits successfully.",
            actual: `Exit ${result.exitCode ?? "signal"} after ${(result.durationMs / 1_000).toFixed(1)}s.`,
            evidence: evidenceFromResult(result.stdout, result.stderr),
          });
        });
      } catch (error) {
        setProposal((latest) => {
          if (!latest || latest.resultTree !== running.resultTree)
            return latest;
          return recordTestScenarioResult(latest, {
            expectedVersion: latest.version,
            scenarioId,
            resultTree: latest.resultTree,
            status: "blocked",
            expected:
              scenario.expectedOutcomes.join("; ") ||
              "Command exits successfully.",
            actual:
              error instanceof Error ? error.message : "Test could not run.",
            evidence: [],
          });
        });
      }
    },
    [proposal, refetchWorkspace, runTest, workspace],
  );

  const recordApproval = React.useCallback(async () => {
    if (!proposal || !workspace || !approverPubkey) return;
    setIsRecordingApproval(true);
    try {
      const ready = markChangeProposalReady(proposal, proposal.version);
      const approved = approveChangeProposal(ready, {
        expectedVersion: ready.version,
        resultTree: workspace.resultTree,
        approverPubkey,
        approvedAt: Math.floor(Date.now() / 1_000),
        scope: "commit",
      });
      await onRecordApproval(buildChangeProposalApprovalMessage(approved));
      setProposal(approved);
      toast.success(
        "Exact-tree approval was signed into the BrickO discussion.",
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Approval could not be recorded.",
      );
    } finally {
      setIsRecordingApproval(false);
    }
  }, [approverPubkey, onRecordApproval, proposal, workspace]);

  const recordLocalCommit = React.useCallback(
    (result: GitHubRepositoryCommitResult) => {
      setCommitResult(result);
      setCommittedProposal(proposal);
      setPublicationResult(null);
      if (!result.checkedOut) return;
      queryClient.setQueryData<GitHubRepositoryWorkspace | null>(
        queryKey,
        (current) =>
          current
            ? {
                ...current,
                branch: result.branch,
                baseCommit: result.commit,
                baseTree: result.resultTree,
                resultTree: result.resultTree,
                dirty: false,
                additions: 0,
                deletions: 0,
                files: [],
              }
            : current,
      );
    },
    [proposal, queryClient, queryKey],
  );

  const allScenariosPassed = Boolean(
    proposal &&
      proposal.scenarios.length > 0 &&
      proposal.scenarios.every(
        (scenario) =>
          scenario.status === "passed" &&
          scenario.testedTree === proposal.resultTree,
      ),
  );
  const lifecycleProposal = proposal ?? committedProposal;
  const publicationGate =
    lifecycleProposal?.status === "approved" ? (
      <React.Suspense
        fallback={
          <div className="flex items-center gap-2 rounded-xl border border-border/60 p-4 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading user publication controls…
          </div>
        }
      >
        <GitHubPublicationGate
          commit={commitResult}
          defaultBranch={repository.defaultBranch}
          onCommitted={recordLocalCommit}
          onPublished={setPublicationResult}
          onRecordLifecycle={onRecordApproval}
          proposal={lifecycleProposal}
          publication={publicationResult}
          reposDir={reposDir}
          workspaceId={workspaceId}
        />
      </React.Suspense>
    ) : null;

  return (
    <div
      className="mx-3 mb-3 rounded-xl border border-border/60 bg-muted/20 p-3"
      data-testid="github-change-proposal-launcher"
    >
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">
            Local change proposal
          </p>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            {workspaceQuery.isLoading
              ? "Inspecting the local workspace…"
              : !workspace
                ? "Prepare a private local checkout for BrickO."
                : workspace.dirty
                  ? `${workspace.files.length} changed files · tree ${shortObjectId(workspace.resultTree)}`
                  : `Ready at ${shortObjectId(workspace.baseCommit)} · no local changes yet`}
          </p>
        </div>
        <Dialog
          onOpenChange={(nextOpen) => {
            if (!nextOpen && fileEditorDirty) {
              toast.warning("Save or discard the current file before closing.");
              return;
            }
            setOpen(nextOpen);
          }}
          open={open}
        >
          <DialogTrigger asChild>
            <Button
              className="h-7 px-2 text-xs"
              data-testid="github-change-proposal-open"
              size="sm"
              type="button"
              variant="outline"
            >
              Open
            </Button>
          </DialogTrigger>
          <DialogContent
            className="flex h-[min(52rem,calc(100vh-2rem))] max-w-5xl flex-col gap-0 overflow-hidden p-0"
            data-testid="github-change-proposal-dialog"
          >
            <DialogHeader className="border-border/60 border-b px-6 py-5 pr-14">
              <DialogTitle className="text-lg">
                Develop {repository.owner}/{repository.name}
              </DialogTitle>
              <DialogDescription>
                BrickO can edit the local checkout. Tests and approval remain
                bound to one exact result tree; remote publication is separate.
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {workspaceQuery.isLoading ? (
                <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Inspecting local workspace…
                </div>
              ) : workspaceQuery.error ? (
                <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center">
                  <AlertTriangle className="h-6 w-6 text-destructive" />
                  <p className="max-w-xl text-sm text-muted-foreground">
                    {workspaceQuery.error.message}
                  </p>
                  <Button onClick={() => void workspaceQuery.refetch()}>
                    Retry inspection
                  </Button>
                </div>
              ) : !workspace ? (
                <div className="flex min-h-64 flex-col items-center justify-center gap-4 text-center">
                  <FolderGit2 className="h-9 w-9 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      Prepare a local workspace
                    </p>
                    <p className="mt-1 max-w-lg text-xs text-muted-foreground">
                      Buzz uses the user&apos;s local GitHub CLI login to clone
                      this repository. No branch, commit, PR, or release is
                      published.
                    </p>
                  </div>
                  <Button
                    className="gap-1.5"
                    data-testid="github-workspace-prepare"
                    disabled={prepareMutation.isPending}
                    onClick={() => prepareMutation.mutate()}
                  >
                    {prepareMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <FolderGit2 className="h-4 w-4" />
                    )}
                    Prepare workspace
                  </Button>
                  {prepareMutation.error ? (
                    <p className="max-w-xl text-xs text-destructive">
                      {prepareMutation.error.message}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-6">
                  <section className="rounded-xl border border-border/60 bg-muted/15 p-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <GitBranch className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">
                        {workspace.branch || "Detached HEAD"}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        base {shortObjectId(workspace.baseCommit)}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        tree {shortObjectId(workspace.resultTree)}
                      </span>
                      <Button
                        className="ml-auto gap-1.5"
                        disabled={workspaceQuery.isFetching}
                        onClick={() => void refreshWorkspace()}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <RefreshCw
                          className={`h-3.5 w-3.5 ${workspaceQuery.isFetching ? "animate-spin" : ""}`}
                        />
                        Refresh after BrickO update
                      </Button>
                    </div>
                    <p
                      className="mt-2 truncate text-2xs text-muted-foreground"
                      title={workspace.path}
                    >
                      {workspace.path}
                    </p>
                  </section>

                  {commitResult && committedProposal ? (
                    publicationGate
                  ) : !workspace.dirty || !proposal ? (
                    <section className="rounded-xl border border-dashed border-border p-6 text-center">
                      <CheckCircle2 className="mx-auto h-7 w-7 text-muted-foreground" />
                      <p className="mt-3 text-sm font-medium">
                        No proposed code changes yet
                      </p>
                      <p className="mx-auto mt-1 max-w-xl text-xs text-muted-foreground">
                        Close this dialog and ask BrickO to implement the agreed
                        update. The agent context now contains the verified
                        local workspace path; refresh here afterward.
                      </p>
                    </section>
                  ) : (
                    <>
                      <section className="space-y-2">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <h3 className="text-sm font-semibold">
                              Recommendation
                            </h3>
                            <p className="text-xs text-muted-foreground">
                              Edit the proposal summary before approving it.
                            </p>
                          </div>
                          <Badge
                            variant={
                              proposal.status === "approved"
                                ? "success"
                                : "secondary"
                            }
                          >
                            {proposal.status}
                          </Badge>
                        </div>
                        <Textarea
                          aria-label="Change proposal summary"
                          defaultValue={proposal.summary}
                          disabled={proposal.status === "approved"}
                          key={`${proposal.baseCommit}:summary`}
                          onBlur={(event) => {
                            const summary = event.currentTarget.value.trim();
                            if (summary === proposal.summary) return;
                            setProposal((current) =>
                              current
                                ? updateChangeProposalSummary(current, {
                                    expectedVersion: current.version,
                                    summary,
                                  })
                                : current,
                            );
                          }}
                        />
                      </section>

                      <section className="space-y-3">
                        <div className="flex items-end justify-between gap-3">
                          <div>
                            <h3 className="text-sm font-semibold">
                              Changed files
                            </h3>
                            <p className="text-xs text-muted-foreground">
                              {workspace.files.length} files · +
                              {workspace.additions} −{workspace.deletions}
                            </p>
                          </div>
                        </div>
                        <ProposalFileEditor
                          disabled={proposal.status === "approved"}
                          files={workspace.files}
                          name={repository.name}
                          onDirtyChange={setFileEditorDirty}
                          onSaved={recordFileSave}
                          owner={repository.owner}
                          reposDir={reposDir}
                          resultTree={workspace.resultTree}
                          workspaceId={workspaceId}
                        />
                        <p className="text-2xs text-muted-foreground">
                          Save writes one text file atomically. The resulting
                          Git tree invalidates prior test evidence and approval.
                          Binary, symlinked, and oversized files stay
                          external-IDE only.
                        </p>
                        <div
                          className="space-y-2"
                          data-testid="github-proposal-diff"
                        >
                          {workspace.files.map((file) => (
                            <ProposalDiffFile file={file} key={file.path} />
                          ))}
                        </div>
                      </section>

                      <section className="space-y-3">
                        <div className="flex items-end justify-between gap-3">
                          <div>
                            <h3 className="text-sm font-semibold">
                              Test scenarios
                            </h3>
                            <p className="text-xs text-muted-foreground">
                              Commands run locally once, with zero automatic
                              retries.
                            </p>
                          </div>
                          <Button
                            className="gap-1.5"
                            disabled={proposal.status === "approved"}
                            onClick={() => {
                              const id = `TS-${scenarioSequence.current++}`;
                              setProposal((current) =>
                                current
                                  ? addChangeProposalScenario(current, {
                                      expectedVersion: current.version,
                                      scenario: {
                                        id,
                                        title: "Acceptance scenario",
                                        command: "",
                                        given: [],
                                        when: ["The user runs the command"],
                                        expectedOutcomes: [],
                                      },
                                    })
                                  : current,
                              );
                            }}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            Add scenario
                          </Button>
                        </div>
                        <div className="grid gap-3 lg:grid-cols-2">
                          {proposal.scenarios.map((scenario) => (
                            <ProposalScenarioEditor
                              disabled={
                                proposal.status === "approved" ||
                                runTestMutation.isPending
                              }
                              key={scenario.id}
                              onRemove={() =>
                                setProposal((current) =>
                                  current
                                    ? removeChangeProposalScenario(current, {
                                        expectedVersion: current.version,
                                        scenarioId: scenario.id,
                                      })
                                    : current,
                                )
                              }
                              onRun={() => void runScenario(scenario.id)}
                              onUpdate={(input) =>
                                updateScenario(scenario.id, input)
                              }
                              scenario={scenario}
                            />
                          ))}
                        </div>
                      </section>

                      <section className="flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/15 p-4 sm:flex-row sm:items-center">
                        <ShieldCheck className="h-5 w-5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">
                            Human approval gate
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            Approval is signed into the BrickO discussion for
                            this exact result tree. It authorizes a local commit
                            only—not push, PR, release, or deployment.
                          </p>
                        </div>
                        <Button
                          className="gap-1.5"
                          data-testid="github-proposal-approve"
                          disabled={
                            !allScenariosPassed ||
                            fileEditorDirty ||
                            !approverPubkey ||
                            isRecordingApproval ||
                            proposal.status === "approved"
                          }
                          onClick={() => void recordApproval()}
                          type="button"
                        >
                          {isRecordingApproval ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ShieldCheck className="h-4 w-4" />
                          )}
                          {proposal.status === "approved"
                            ? "Approved"
                            : "Approve exact tree"}
                        </Button>
                      </section>

                      {publicationGate}
                    </>
                  )}
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
