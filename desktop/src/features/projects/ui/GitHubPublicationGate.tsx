import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  ExternalLink,
  GitCommitHorizontal,
  GitPullRequest,
  Loader2,
  LockKeyhole,
  Send,
  UserRoundCheck,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import type { ChangeProposal } from "@/features/projects/lib/changeProposal";
import {
  buildGitHubPublicationReceipt,
  buildLocalCommitReceipt,
  buildUserDraftPullRequestBody,
  defaultUserPublicationBranch,
} from "@/features/projects/lib/githubUserPublication";
import {
  commitGitHubRepositoryChange,
  getGitHubRepositoryPublicationIdentity,
  publishGitHubRepositoryChange,
  type GitHubRepositoryCommitResult,
  type GitHubRepositoryPublishResult,
} from "@/shared/api/githubRepositoryWorkspace";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";

function shortObjectId(value: string) {
  return value.slice(0, 12);
}

function mutationError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function GitHubPublicationGate({
  defaultBranch,
  commit,
  onCommitted,
  onPublished,
  onRecordLifecycle,
  publication,
  proposal,
  reposDir,
}: {
  defaultBranch: string;
  commit: GitHubRepositoryCommitResult | null;
  onCommitted: (result: GitHubRepositoryCommitResult) => void;
  onPublished: (result: GitHubRepositoryPublishResult) => void;
  onRecordLifecycle: (content: string) => Promise<void>;
  publication: GitHubRepositoryPublishResult | null;
  proposal: ChangeProposal;
  reposDir?: string | null;
}) {
  const [branchName, setBranchName] = React.useState("");
  const [branchWasEdited, setBranchWasEdited] = React.useState(false);
  const [commitMessage, setCommitMessage] = React.useState(proposal.summary);
  const [pullRequestTitle, setPullRequestTitle] = React.useState(
    proposal.summary.slice(0, 256),
  );
  const [pullRequestBody, setPullRequestBody] = React.useState("");
  const [confirmationOpen, setConfirmationOpen] = React.useState(false);
  const [remoteAuthorized, setRemoteAuthorized] = React.useState(false);

  const identityQuery = useQuery({
    queryKey: [
      "github-publication-identity",
      proposal.repository.owner,
      proposal.repository.name,
      reposDir ?? "default",
    ],
    queryFn: () =>
      getGitHubRepositoryPublicationIdentity({
        owner: proposal.repository.owner,
        name: proposal.repository.name,
        reposDir,
      }),
    enabled: proposal.status === "approved",
    retry: false,
    staleTime: 5_000,
  });
  const commitMutation = useMutation({
    mutationFn: () =>
      commitGitHubRepositoryChange({
        owner: proposal.repository.owner,
        name: proposal.repository.name,
        reposDir,
        expectedBaseCommit: proposal.baseCommit,
        expectedResultTree: proposal.resultTree,
        branchName,
        message: commitMessage,
      }),
  });
  const publishMutation = useMutation({
    mutationFn: (input: { githubLogin: string; commit: string }) =>
      publishGitHubRepositoryChange({
        owner: proposal.repository.owner,
        name: proposal.repository.name,
        reposDir,
        expectedCommit: input.commit,
        expectedResultTree: proposal.resultTree,
        branchName,
        baseBranch: defaultBranch,
        expectedGitHubLogin: input.githubLogin,
        remotePublicationAuthorized: remoteAuthorized,
        title: pullRequestTitle,
        body: pullRequestBody,
      }),
  });
  const createCommit = commitMutation.mutateAsync;
  const publish = publishMutation.mutateAsync;
  const identity = identityQuery.data;

  React.useEffect(() => {
    if (commit) {
      if (branchName !== commit.branch) setBranchName(commit.branch);
      return;
    }
    if (!identity || branchWasEdited || branchName) return;
    setBranchName(
      defaultUserPublicationBranch({
        githubLogin: identity?.githubLogin ?? null,
        repositoryName: proposal.repository.name,
        summary: proposal.summary,
      }),
    );
  }, [branchName, branchWasEdited, commit, identity, proposal]);

  React.useEffect(() => {
    if (!commit || pullRequestBody) return;
    setPullRequestBody(buildUserDraftPullRequestBody({ proposal, commit }));
  }, [commit, proposal, pullRequestBody]);

  const handleCreateCommit = React.useCallback(async () => {
    try {
      const result = await createCommit();
      onCommitted(result);
      try {
        await onRecordLifecycle(
          buildLocalCommitReceipt({ proposal, commit: result }),
        );
        toast.success("Local commit recorded in the BrickO discussion.");
      } catch (error) {
        toast.warning(
          "Commit " +
            shortObjectId(result.commit) +
            " exists, but its discussion receipt was not recorded: " +
            mutationError(error, "unknown error"),
        );
      }
      if (result.warning) toast.warning(result.warning);
    } catch (error) {
      toast.error(
        mutationError(error, "The local commit could not be created."),
      );
    }
  }, [createCommit, onCommitted, onRecordLifecycle, proposal]);

  const handlePublish = React.useCallback(async () => {
    if (!commit || !identity?.githubLogin || !remoteAuthorized) return;
    try {
      const result = await publish({
        githubLogin: identity.githubLogin,
        commit: commit.commit,
      });
      onPublished(result);
      setConfirmationOpen(false);
      setRemoteAuthorized(false);
      try {
        await onRecordLifecycle(
          buildGitHubPublicationReceipt({ proposal, publication: result }),
        );
        toast.success("Draft PR published and recorded in the discussion.");
      } catch (error) {
        toast.warning(
          "Draft PR #" +
            result.pullRequestNumber +
            " exists, but its discussion receipt was not recorded: " +
            mutationError(error, "unknown error"),
        );
      }
    } catch (error) {
      toast.error(mutationError(error, "The Draft PR could not be published."));
    }
  }, [
    commit,
    identity?.githubLogin,
    onPublished,
    onRecordLifecycle,
    proposal,
    publish,
    remoteAuthorized,
  ]);

  const canCommit = Boolean(
    identity?.localCommitReady && branchName.trim() && commitMessage.trim(),
  );
  const canPublish = Boolean(
    commit?.checkedOut &&
      commit.indexSynchronized &&
      identity?.remotePublicationReady &&
      identity.githubLogin &&
      pullRequestTitle.trim() &&
      pullRequestBody.trim() &&
      !publication,
  );

  return (
    <section
      className="space-y-4 rounded-xl border border-border/60 bg-muted/15 p-4"
      data-testid="github-publication-gate"
    >
      <div className="flex items-start gap-3">
        <UserRoundCheck className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">User-owned publication</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Local commit and GitHub publication are separate user actions with
            separately verified identities.
          </p>
        </div>
        <Badge
          variant={publication ? "success" : commit ? "info" : "secondary"}
        >
          {publication ? "Draft PR" : commit ? "Committed" : "Approved"}
        </Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border/60 bg-background p-3">
          <p className="text-2xs font-medium uppercase tracking-[0.15em] text-muted-foreground">
            Git commit author
          </p>
          <p
            className="mt-1 truncate text-sm"
            data-testid="github-commit-author"
          >
            {identity?.gitName && identity.gitEmail
              ? `${identity.gitName} <${identity.gitEmail}>`
              : "Not configured"}
          </p>
        </div>
        <div className="rounded-lg border border-border/60 bg-background p-3">
          <p className="text-2xs font-medium uppercase tracking-[0.15em] text-muted-foreground">
            GitHub publication actor
          </p>
          <p
            className="mt-1 truncate text-sm"
            data-testid="github-publication-actor"
          >
            {identity?.githubLogin
              ? `@${identity.githubLogin}`
              : "Not signed in"}
          </p>
        </div>
      </div>

      {identityQuery.isLoading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Verifying local user identities…
        </p>
      ) : null}
      {identityQuery.error ? (
        <p className="text-xs text-destructive">
          {identityQuery.error.message}
        </p>
      ) : null}
      {identity?.blockers.map((blocker) => (
        <p className="text-xs text-amber-700 dark:text-amber-300" key={blocker}>
          {blocker}
        </p>
      ))}

      <div className="space-y-3 rounded-lg border border-border/60 bg-background p-3">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-semibold">
            1
          </span>
          <GitCommitHorizontal className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm font-medium">
            Create an exact-tree local commit
          </p>
        </div>
        <Input
          aria-label="User task branch"
          data-testid="github-publication-branch"
          disabled={Boolean(commit)}
          onChange={(event) => {
            setBranchWasEdited(true);
            setBranchName(event.currentTarget.value);
          }}
          placeholder="users/account/task"
          value={branchName}
        />
        <Textarea
          aria-label="Local commit message"
          disabled={Boolean(commit)}
          onChange={(event) => setCommitMessage(event.currentTarget.value)}
          value={commitMessage}
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            Commit tree {shortObjectId(proposal.resultTree)} · a DCO
            Signed-off-by trailer uses the displayed Git identity.
          </p>
          <Button
            className="gap-1.5"
            data-testid="github-create-user-commit"
            disabled={!canCommit || commitMutation.isPending || Boolean(commit)}
            onClick={() => void handleCreateCommit()}
            type="button"
          >
            {commitMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <GitCommitHorizontal className="h-4 w-4" />
            )}
            {commit ? "Committed" : "Create user commit"}
          </Button>
        </div>
        {commit ? (
          <div className="flex items-start gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
            <p>
              <span className="font-medium">{commit.branch}</span> at{" "}
              <span className="font-mono">{shortObjectId(commit.commit)}</span>
              {commit.warning ? ` · ${commit.warning}` : " · workspace clean"}
            </p>
          </div>
        ) : null}
      </div>

      <div className="space-y-3 rounded-lg border border-border/60 bg-background p-3">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-semibold">
            2
          </span>
          <GitPullRequest className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm font-medium">Publish branch and Draft PR</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            aria-label="Draft PR base branch"
            disabled
            value={defaultBranch}
          />
          <Input
            aria-label="Draft PR title"
            disabled={!commit || Boolean(publication)}
            onChange={(event) => setPullRequestTitle(event.currentTarget.value)}
            value={pullRequestTitle}
          />
        </div>
        <Textarea
          aria-label="Draft PR body"
          className="min-h-36 font-mono text-xs"
          disabled={!commit || Boolean(publication)}
          onChange={(event) => setPullRequestBody(event.currentTarget.value)}
          placeholder="PR body is generated after the local commit."
          value={pullRequestBody}
        />
        <div className="flex items-start gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs">
          <Checkbox
            aria-label="Authorize GitHub branch push and Draft PR"
            checked={publication ? true : remoteAuthorized}
            disabled={!canPublish || publishMutation.isPending}
            id="github-remote-publication-authorization"
            onCheckedChange={(checked) => setRemoteAuthorized(checked === true)}
          />
          <label
            className="cursor-pointer"
            htmlFor="github-remote-publication-authorization"
          >
            {publication ? "Authorization used for" : "I authorize"} one
            explicit branch push and one Draft PR as{" "}
            <strong>@{identity?.githubLogin ?? "unverified"}</strong>. This does
            not authorize merge, release, deployment, or promotion.
          </label>
        </div>
        <div className="flex justify-end">
          <Button
            className="gap-1.5"
            data-testid="github-open-publication-confirmation"
            disabled={!canPublish || !remoteAuthorized}
            onClick={() => setConfirmationOpen(true)}
            type="button"
          >
            <Send className="h-4 w-4" />
            Confirm GitHub publication
          </Button>
        </div>
        {publication ? (
          <a
            className="flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-700 hover:underline dark:text-emerald-300"
            href={publication.pullRequestUrl}
            rel="noreferrer"
            target="_blank"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Draft PR #{publication.pullRequestNumber} published by @
            {publication.githubLogin}
            <ExternalLink className="ml-auto h-3.5 w-3.5" />
          </a>
        ) : null}
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-dashed border-border p-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
          3
        </span>
        <LockKeyhole className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">Release remains locked</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Release becomes a new user gate only after integration and required
            checks are independently verified. Draft PR publication never
            implies release approval.
          </p>
        </div>
      </div>

      <AlertDialog onOpenChange={setConfirmationOpen} open={confirmationOpen}>
        <AlertDialogContent data-testid="github-publication-confirmation">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Publish as @{identity?.githubLogin}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Buzz will push only {branchName} at commit{" "}
              {commit ? shortObjectId(commit.commit) : "—"} and create a Draft
              PR into {defaultBranch}. There is no automatic retry and no
              release action.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
            {proposal.repository.owner}/{proposal.repository.name} ·{" "}
            {branchName}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={publishMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                data-testid="github-publish-user-draft-pr"
                disabled={publishMutation.isPending || !remoteAuthorized}
                onClick={(event) => {
                  event.preventDefault();
                  void handlePublish();
                }}
              >
                {publishMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                Push and create Draft PR
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
