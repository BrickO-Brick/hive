import {
  Bot,
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  Play,
  RotateCcw,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { useStartManagedAgentMutation } from "@/features/agents/hooks";
import { isManagedAgentActive } from "@/features/agents/lib/managedAgentControlActions";
import { useChannelsQuery, useOpenDmMutation } from "@/features/channels/hooks";
import { normalizeRelayUrl } from "@/features/communities/communityStorage";
import { useCommunities } from "@/features/communities/useCommunities";
import {
  useChannelMessagesQuery,
  useChannelSubscription,
} from "@/features/messages/hooks";
import { getThreadReference } from "@/features/messages/lib/threading";
import { useThreadRepliesForRoots } from "@/features/messages/useThreadReplies";
import {
  buildProjectReviewCheckPrompt,
  DEFAULT_PROJECT_REVIEW_CHECKS,
  parseProjectReviewCheckDiffEvent,
  parseProjectReviewCheckResult,
  projectReviewChecksStorageKey,
  readProjectReviewCheckRuns,
  writeProjectReviewCheckRuns,
  type ProjectReviewCheckDefinition,
  type ProjectReviewCheckDiffProposal,
  type ProjectReviewCheckResult,
} from "@/features/projects/lib/projectReviewChecks.mjs";
import { isAtOrAfterConversationOpener } from "@/features/projects/lib/projectAgentConversation";
import type { ProjectsConversationOpener } from "@/features/projects/lib/projectAgentConversationStorage";
import { pullRequestShareLink } from "@/features/projects/lib/projectShareLinks";
import type { ProjectPullRequest, Repository } from "@/features/projects/hooks";
import { ProjectReviewCheckResultCard } from "@/features/projects/ui/ProjectReviewCheckResultCard";
import type { ProjectReviewAgentSelection } from "@/features/projects/ui/ProjectReviewAgentSelection";
import type { ReviewAgent } from "@/features/projects/ui/ProjectReviewDebugHarness";
import { useIdentityQuery } from "@/shared/api/hooks";
import { listManagedAgents } from "@/shared/api/tauri";
import { revalidateRelayAgents } from "@/shared/api/tauriRelayAgents";
import { sendChannelMessage } from "@/shared/api/tauriMessages";
import type { Channel, RelayEvent } from "@/shared/api/types";
import {
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_STREAM_MESSAGE_V2,
} from "@/shared/constants/kinds";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";

type ReviewCheckStatus = "idle" | "running" | "completed" | "failed";

type ReviewCheckRun = {
  agentPubkey: string | null;
  requestId?: string;
  status: ReviewCheckStatus;
  targetCommit?: string | null;
  channelId?: string;
  opener?: ProjectsConversationOpener;
  result?: ProjectReviewCheckResult;
  proposal?: ProjectReviewCheckDiffProposal;
  acceptedProposalEventId?: string;
  resultCreatedAt?: number;
  error?: string;
};

type ReviewCheckRuns = Record<string, ReviewCheckRun>;

function isReviewCheckStatus(value: unknown): value is ReviewCheckStatus {
  return (
    value === "idle" ||
    value === "running" ||
    value === "completed" ||
    value === "failed"
  );
}

function normalizeStoredProposal(
  value: unknown,
  agentPubkey: string | null,
): ProjectReviewCheckDiffProposal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    !agentPubkey ||
    typeof raw.eventId !== "string" ||
    typeof raw.content !== "string" ||
    typeof raw.repoUrl !== "string" ||
    typeof raw.commitSha !== "string"
  ) {
    return undefined;
  }
  const tags = [
    ["repo", raw.repoUrl],
    ["commit", raw.commitSha],
    ...(typeof raw.filePath === "string" ? [["file", raw.filePath]] : []),
    ...(typeof raw.description === "string"
      ? [["description", raw.description]]
      : []),
    ...(raw.truncated === true ? [["truncated", "true"]] : []),
  ];
  return (
    parseProjectReviewCheckDiffEvent(
      {
        id: raw.eventId,
        pubkey: agentPubkey,
        kind: KIND_STREAM_MESSAGE_DIFF,
        content: raw.content,
        tags,
      },
      {
        eventId: raw.eventId,
        agentPubkey,
        repoUrl: raw.repoUrl,
        commit: raw.commitSha,
      },
    ) ?? undefined
  );
}

function normalizeStoredRuns(value: Record<string, unknown>): ReviewCheckRuns {
  const runs: ReviewCheckRuns = {};
  for (const [checkId, candidate] of Object.entries(value)) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      continue;
    }
    const raw = candidate as Record<string, unknown>;
    const agentPubkey =
      typeof raw.agentPubkey === "string" ? raw.agentPubkey : null;
    const proposal = normalizeStoredProposal(raw.proposal, agentPubkey);
    const status = isReviewCheckStatus(raw.status) ? raw.status : "idle";
    const parsedResult = parseProjectReviewCheckResult(
      raw.result && typeof raw.result === "object"
        ? `BUZZ_CHECK_RESULT_V1\n${JSON.stringify(raw.result)}`
        : "",
    );
    const opener =
      raw.opener &&
      typeof raw.opener === "object" &&
      typeof (raw.opener as Record<string, unknown>).eventId === "string" &&
      typeof (raw.opener as Record<string, unknown>).createdAt === "number"
        ? {
            eventId: (raw.opener as { eventId: string }).eventId,
            createdAt: (raw.opener as { createdAt: number }).createdAt,
          }
        : undefined;
    runs[checkId] = {
      agentPubkey,
      status: status === "completed" && !parsedResult ? "idle" : status,
      ...(typeof raw.targetCommit === "string" || raw.targetCommit === null
        ? { targetCommit: raw.targetCommit as string | null }
        : {}),
      ...(typeof raw.channelId === "string"
        ? { channelId: raw.channelId }
        : {}),
      ...(typeof raw.requestId === "string"
        ? { requestId: raw.requestId }
        : {}),
      ...(opener ? { opener } : {}),
      ...(parsedResult ? { result: parsedResult } : {}),
      ...(proposal ? { proposal } : {}),
      ...(proposal && raw.acceptedProposalEventId === proposal.eventId
        ? { acceptedProposalEventId: proposal.eventId }
        : {}),
      ...(typeof raw.resultCreatedAt === "number"
        ? { resultCreatedAt: raw.resultCreatedAt }
        : {}),
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    };
  }
  return runs;
}

function useProjectReviewCheckDefinitions() {
  // Future project-owned definitions can be loaded from the target branch here.
  // Keep the prototype synchronous and local so opening Checks never clones a repo.
  return DEFAULT_PROJECT_REVIEW_CHECKS;
}

function isAgentMessage(event: RelayEvent, agentPubkey: string) {
  return (
    (event.kind === KIND_STREAM_MESSAGE ||
      event.kind === KIND_STREAM_MESSAGE_V2) &&
    normalizePubkey(event.pubkey) === normalizePubkey(agentPubkey)
  );
}

function ReviewCheckResultObserver({
  agentPubkey,
  channel,
  checkId,
  onResult,
  opener,
  repoUrl,
  requestId,
  targetCommit,
}: {
  agentPubkey: string;
  channel: Channel | null;
  checkId: string;
  onResult: (
    checkId: string,
    result: ProjectReviewCheckResult,
    createdAt: number,
    proposal?: ProjectReviewCheckDiffProposal,
  ) => void;
  opener: ProjectsConversationOpener;
  repoUrl: string | null;
  requestId: string | null;
  targetCommit: string | null;
}) {
  useChannelSubscription(channel);
  const messagesQuery = useChannelMessagesQuery(channel);
  const threadRootIds = React.useMemo(
    () =>
      (messagesQuery.data ?? [])
        .filter(
          (event) =>
            isAtOrAfterConversationOpener(event, opener) &&
            getThreadReference(event.tags).parentId === null,
        )
        .map((event) => event.id),
    [messagesQuery.data, opener],
  );
  const threadReplies = useThreadRepliesForRoots(channel, threadRootIds);
  const observedResult = React.useMemo(() => {
    const agentEvents = [
      ...(messagesQuery.data ?? []),
      ...(threadReplies.events ?? []),
    ].filter(
      (event) =>
        normalizePubkey(event.pubkey) === normalizePubkey(agentPubkey) &&
        isAtOrAfterConversationOpener(event, opener) &&
        getThreadReference(event.tags).rootId === opener.eventId,
    );
    const resultEvents = agentEvents
      .filter((event) => isAgentMessage(event, agentPubkey))
      .sort(
        (left, right) =>
          left.created_at - right.created_at || right.id.localeCompare(left.id),
      );
    for (const event of resultEvents) {
      const result = parseProjectReviewCheckResult(event.content);
      if (result && (!requestId || result.requestId === requestId)) {
        let proposal: ProjectReviewCheckDiffProposal | undefined;
        if (result.diffEventId) {
          if (!repoUrl) continue;
          const diffEvent = agentEvents.find(
            (candidate) =>
              candidate.kind === KIND_STREAM_MESSAGE_DIFF &&
              candidate.id.toLowerCase() === result.diffEventId,
          );
          proposal = diffEvent
            ? (parseProjectReviewCheckDiffEvent(diffEvent, {
                eventId: result.diffEventId,
                agentPubkey,
                repoUrl,
                commit: targetCommit,
              }) ?? undefined)
            : undefined;
          // The agent is instructed to publish the native diff before its
          // result. Keep observing if relay delivery arrives out of order.
          if (!proposal) continue;
        }
        return { createdAt: event.created_at, proposal, result };
      }
    }
    return null;
  }, [
    agentPubkey,
    messagesQuery.data,
    opener,
    repoUrl,
    requestId,
    targetCommit,
    threadReplies.events,
  ]);

  React.useEffect(() => {
    if (observedResult) {
      onResult(
        checkId,
        observedResult.result,
        observedResult.createdAt,
        observedResult.proposal,
      );
    }
  }, [checkId, observedResult, onResult]);

  return null;
}

function CheckStatus({
  isPending,
  isStale,
  run,
}: {
  isPending: boolean;
  isStale: boolean;
  run: ReviewCheckRun;
}) {
  if (isPending || run.status === "running") {
    return (
      <Badge className="gap-1" variant="info">
        <LoaderCircle className="h-3 w-3 animate-spin" /> Running
      </Badge>
    );
  }
  if (run.status === "failed") {
    return <Badge variant="destructive">Couldn’t run</Badge>;
  }
  if (isStale) return <Badge variant="outline">Outdated</Badge>;
  if (run.result?.conclusion === "approved") {
    return <Badge variant="success">Approved</Badge>;
  }
  if (run.result?.conclusion === "fix-recommended") {
    return <Badge variant="warning">Fix recommended</Badge>;
  }
  return null;
}

export function ProjectReviewChecks({
  project,
  pullRequest,
  reviewAgents,
}: {
  project: Repository;
  pullRequest: ProjectPullRequest;
  reviewAgents: ProjectReviewAgentSelection;
}) {
  const { activeCommunity } = useCommunities();
  const identityQuery = useIdentityQuery();
  const channelsQuery = useChannelsQuery();
  const openDmMutation = useOpenDmMutation();
  const startAgentMutation = useStartManagedAgentMutation();
  const checkDefinitions = useProjectReviewCheckDefinitions();
  const relayScope = activeCommunity?.relayUrl
    ? normalizeRelayUrl(activeCommunity.relayUrl)
    : null;
  const signerScope = identityQuery.data?.pubkey
    ? normalizePubkey(identityQuery.data.pubkey)
    : null;
  const storageKey = projectReviewChecksStorageKey({
    relayUrl: relayScope,
    signerPubkey: signerScope,
    repoAddress: pullRequest.repoAddress ?? project.repoAddress,
    reviewId: pullRequest.id,
  });
  const storageKeyRef = React.useRef(storageKey);
  const [runs, setRuns] = React.useState<ReviewCheckRuns>({});
  const [pendingCheckIds, setPendingCheckIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const targetCommit = pullRequest.commit ?? pullRequest.initialCommit;
  const diffRepoUrl = React.useMemo(
    () =>
      [project.webUrl, ...project.cloneUrls].find(
        (url): url is string =>
          typeof url === "string" && /^https?:\/\//i.test(url),
      ) ?? null,
    [project.cloneUrls, project.webUrl],
  );

  React.useEffect(() => {
    storageKeyRef.current = storageKey;
    const stored = readProjectReviewCheckRuns(
      typeof window === "undefined" ? null : window.localStorage,
      storageKey,
    );
    setRuns(normalizeStoredRuns(stored));
    setPendingCheckIds(new Set());
  }, [storageKey]);

  const updateRun = React.useCallback(
    (
      expectedStorageKey: string,
      checkId: string,
      update: (current: ReviewCheckRun) => ReviewCheckRun,
    ) => {
      if (storageKeyRef.current !== expectedStorageKey) return;
      setRuns((current) => {
        const next = {
          ...current,
          [checkId]: update(
            current[checkId] ?? { agentPubkey: null, status: "idle" },
          ),
        };
        writeProjectReviewCheckRuns(
          typeof window === "undefined" ? null : window.localStorage,
          expectedStorageKey,
          next,
        );
        return next;
      });
    },
    [],
  );

  const recordResult = React.useCallback(
    (
      checkId: string,
      result: ProjectReviewCheckResult,
      createdAt: number,
      proposal?: ProjectReviewCheckDiffProposal,
    ) => {
      const expectedStorageKey = storageKeyRef.current;
      if (!expectedStorageKey) return;
      updateRun(expectedStorageKey, checkId, (current) => ({
        ...current,
        error: undefined,
        acceptedProposalEventId: undefined,
        proposal,
        result,
        resultCreatedAt: createdAt,
        status: "completed",
      }));
      toast.success(
        result.conclusion === "approved"
          ? "Review check approved."
          : "Review check recommends a fix.",
      );
    },
    [updateRun],
  );

  const acceptProposal = React.useCallback(
    (checkId: string, eventId: string) => {
      const expectedStorageKey = storageKeyRef.current;
      if (!expectedStorageKey) return;
      updateRun(expectedStorageKey, checkId, (current) =>
        current.proposal?.eventId === eventId
          ? { ...current, acceptedProposalEventId: eventId }
          : current,
      );
      toast.success("Proposal accepted locally. No code was changed.");
    },
    [updateRun],
  );

  const runCheck = React.useCallback(
    async (
      check: ProjectReviewCheckDefinition,
      agent: ReviewAgent,
      supersededRun?: ReviewCheckRun,
    ) => {
      const expectedStorageKey = storageKey;
      if (!expectedStorageKey || !relayScope || !signerScope) return;
      const requestId = crypto.randomUUID();
      if (!agent.isManaged && !agent.isActive) {
        toast.error(
          `${agent.name} is offline and cannot be started from this dev build.`,
        );
        return;
      }
      setPendingCheckIds((current) => new Set(current).add(check.id));
      try {
        if (agent.isManaged) {
          const managedAgent = (await listManagedAgents()).find(
            (candidate) =>
              normalizePubkey(candidate.pubkey) ===
              normalizePubkey(agent.pubkey),
          );
          if (!managedAgent) {
            throw new Error(
              `${agent.name} is no longer managed by this dev build.`,
            );
          }
          if (!isManagedAgentActive(managedAgent)) {
            await startAgentMutation.mutateAsync({
              pubkey: agent.pubkey,
              expectedRelayUrl: relayScope,
              expectedSignerPubkey: signerScope,
            });
          }
        }
        const channel = await openDmMutation.mutateAsync({
          pubkeys: [agent.pubkey],
          expectedRelayUrl: relayScope,
          expectedSignerPubkey: signerScope,
        });
        if (agent.isManaged) {
          const isStillManaged = (await listManagedAgents()).some(
            (candidate) =>
              normalizePubkey(candidate.pubkey) ===
              normalizePubkey(agent.pubkey),
          );
          if (!isStillManaged) {
            throw new Error(
              `${agent.name} is no longer managed by this dev build.`,
            );
          }
        } else {
          // DMs represent every participant as a regular member, so remote
          // authorization comes from the relay directory instead of treating
          // this transport channel as proof.
          const revalidated = await revalidateRelayAgents(
            [agent.pubkey],
            undefined,
          );
          if (
            !revalidated.some(
              (candidate) =>
                normalizePubkey(candidate.pubkey) ===
                normalizePubkey(agent.pubkey),
            )
          ) {
            throw new Error(
              `${agent.name} is no longer authorized for this identity on the relay.`,
            );
          }
        }
        const prompt = buildProjectReviewCheckPrompt({
          check,
          projectName: project.name,
          repoAddress: pullRequest.repoAddress ?? project.repoAddress,
          repoUrl: diffRepoUrl,
          channelId: channel.id,
          reviewId: pullRequest.id,
          reviewLink: pullRequestShareLink(pullRequest) ?? "unavailable",
          reviewTitle: pullRequest.title,
          requestId,
          commit: targetCommit,
          branchName: pullRequest.branchName,
          targetBranch: pullRequest.targetBranch,
          supersededRequestId: supersededRun?.requestId,
          supersededEventId: supersededRun?.opener?.eventId,
        });
        const sent = await sendChannelMessage(
          channel.id,
          prompt,
          undefined,
          undefined,
          [agent.pubkey],
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          relayScope,
          signerScope,
        );
        updateRun(expectedStorageKey, check.id, (current) => ({
          ...current,
          agentPubkey: agent.pubkey,
          channelId: channel.id,
          error: undefined,
          opener: {
            createdAt: sent.createdAt,
            eventId: sent.eventId,
          },
          requestId,
          acceptedProposalEventId: undefined,
          proposal: undefined,
          result: undefined,
          resultCreatedAt: undefined,
          status: "running",
          targetCommit,
        }));
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to run review check.";
        if (!supersededRun) {
          updateRun(expectedStorageKey, check.id, (current) => ({
            ...current,
            error: message,
            result: undefined,
            status: "failed",
            targetCommit,
          }));
        }
        toast.error(message);
      } finally {
        if (storageKeyRef.current === expectedStorageKey) {
          setPendingCheckIds((current) => {
            const next = new Set(current);
            next.delete(check.id);
            return next;
          });
        }
      }
    },
    [
      openDmMutation,
      diffRepoUrl,
      project.name,
      project.repoAddress,
      pullRequest,
      relayScope,
      signerScope,
      startAgentMutation,
      storageKey,
      targetCommit,
      updateRun,
    ],
  );

  const channelsById = React.useMemo(
    () =>
      new Map(
        (channelsQuery.data ?? []).map((channel) => [channel.id, channel]),
      ),
    [channelsQuery.data],
  );
  const selectedAgent = reviewAgents.selected;

  return (
    <div className="-mx-6" data-testid="project-review-checks">
      <div className="border-b border-border/55 px-6 pb-3 text-xs text-muted-foreground">
        Prototype definitions, assignments, and results are local to this dev
        build.
      </div>
      <div className="divide-y divide-border/55">
        {checkDefinitions.map((check) => {
          const run = runs[check.id] ?? {
            agentPubkey: null,
            status: "idle" as const,
          };
          const runningAgent =
            run.status === "running" && run.agentPubkey
              ? (reviewAgents.candidates.find(
                  (candidate) =>
                    normalizePubkey(candidate.pubkey) ===
                    normalizePubkey(run.agentPubkey ?? ""),
                ) ?? null)
              : null;
          const actionAgent =
            run.status === "running" ? runningAgent : selectedAgent;
          const rerunsCheck = run.status !== "idle";
          const actionLabel =
            run.status === "running"
              ? "Interrupt and rerun check"
              : rerunsCheck
                ? "Run check again"
                : undefined;
          const isPending = pendingCheckIds.has(check.id);
          const isStale =
            run.status === "completed" && run.targetCommit !== targetCommit;
          const observerChannel = run.channelId
            ? (channelsById.get(run.channelId) ?? null)
            : null;
          return (
            <article
              className="space-y-3 px-6 py-4"
              data-testid="project-review-check"
              key={check.id}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {run.result?.conclusion === "approved" && !isStale ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    ) : run.result?.conclusion === "fix-recommended" &&
                      !isStale ? (
                      <CircleAlert className="h-4 w-4 text-amber-500" />
                    ) : (
                      <Bot className="h-4 w-4 text-muted-foreground" />
                    )}
                    <h4 className="text-sm font-medium text-foreground">
                      {check.name}
                    </h4>
                    <CheckStatus
                      isPending={isPending}
                      isStale={isStale}
                      run={run}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {check.description}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button
                    aria-label={actionLabel}
                    disabled={!actionAgent || isPending || !storageKey}
                    onClick={() => {
                      if (actionAgent) {
                        void runCheck(
                          check,
                          actionAgent,
                          run.status === "running" ? run : undefined,
                        );
                      }
                    }}
                    size={rerunsCheck ? "icon" : "sm"}
                    title={actionLabel}
                    type="button"
                    variant="secondary"
                  >
                    {isPending ? (
                      <LoaderCircle className="animate-spin" />
                    ) : rerunsCheck ? (
                      <RotateCcw />
                    ) : (
                      <Play />
                    )}
                    {rerunsCheck ? null : "Run"}
                  </Button>
                </div>
              </div>
              {run.error ? (
                <p className="text-xs text-destructive">{run.error}</p>
              ) : null}
              {run.result ? (
                <ProjectReviewCheckResultCard
                  acceptedProposalEventId={run.acceptedProposalEventId}
                  canAcceptProposal={!isStale}
                  onAcceptProposal={(eventId) =>
                    acceptProposal(check.id, eventId)
                  }
                  proposal={run.proposal}
                  result={run.result}
                />
              ) : null}
              {run.status === "running" && run.opener && run.agentPubkey ? (
                <ReviewCheckResultObserver
                  agentPubkey={run.agentPubkey}
                  channel={observerChannel}
                  checkId={check.id}
                  onResult={recordResult}
                  opener={run.opener}
                  repoUrl={diffRepoUrl}
                  requestId={run.requestId ?? null}
                  targetCommit={run.targetCommit ?? targetCommit}
                />
              ) : null}
            </article>
          );
        })}
      </div>
      {!reviewAgents.isLoading && reviewAgents.candidates.length === 0 ? (
        <div className="border-t border-border/55 px-6 py-3 text-xs text-muted-foreground">
          {reviewAgents.isError
            ? "Local managed agents or the relay agent directory could not be loaded."
            : "No local managed or authorized relay agents are available."}
        </div>
      ) : null}
    </div>
  );
}
