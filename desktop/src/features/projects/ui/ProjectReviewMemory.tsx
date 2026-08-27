import {
  History,
  LoaderCircle,
  Play,
  RotateCcw,
  Search,
  Telescope,
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
import { isAtOrAfterConversationOpener } from "@/features/projects/lib/projectAgentConversation";
import type { ProjectsConversationOpener } from "@/features/projects/lib/projectAgentConversationStorage";
import {
  buildProjectReviewContextPrompt,
  parseProjectReviewContextResult,
  PROJECT_REVIEW_CONTEXT_RESULT_MARKER,
  projectReviewContextStorageKey,
  readProjectReviewContextRun,
  type ProjectReviewContextReference,
  type ProjectReviewContextResult,
  writeProjectReviewContextRun,
} from "@/features/projects/lib/projectReviewMemory";
import { pullRequestShareLink } from "@/features/projects/lib/projectShareLinks";
import type { ProjectPullRequest, Repository } from "@/features/projects/hooks";
import type { ProjectReviewAgentSelection } from "@/features/projects/ui/ProjectReviewAgentSelection";
import type { ReviewAgent } from "@/features/projects/ui/ProjectReviewDebugHarness";
import { useIdentityQuery } from "@/shared/api/hooks";
import { listManagedAgents } from "@/shared/api/tauri";
import { revalidateRelayAgents } from "@/shared/api/tauriRelayAgents";
import { sendChannelMessage } from "@/shared/api/tauriMessages";
import type { Channel, RelayEvent } from "@/shared/api/types";
import {
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
} from "@/shared/constants/kinds";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Markdown } from "@/shared/ui/markdown";

type ReviewContextStatus = "idle" | "running" | "completed" | "failed";

type ReviewContextRun = {
  agentPubkey: string | null;
  channelId?: string;
  error?: string;
  opener?: ProjectsConversationOpener;
  requestId?: string;
  result?: ProjectReviewContextResult;
  resultCreatedAt?: number;
  status: ReviewContextStatus;
  targetCommit?: string | null;
};

function isReviewContextStatus(value: unknown): value is ReviewContextStatus {
  return (
    value === "idle" ||
    value === "running" ||
    value === "completed" ||
    value === "failed"
  );
}

function normalizeStoredRun(
  value: Record<string, unknown> | null,
): ReviewContextRun | null {
  if (!value) return null;
  const status = isReviewContextStatus(value.status) ? value.status : "idle";
  const result = parseProjectReviewContextResult(
    value.result && typeof value.result === "object"
      ? `${PROJECT_REVIEW_CONTEXT_RESULT_MARKER}\n${JSON.stringify(value.result)}`
      : "",
  );
  const rawOpener =
    value.opener &&
    typeof value.opener === "object" &&
    !Array.isArray(value.opener)
      ? (value.opener as Record<string, unknown>)
      : null;
  const opener =
    rawOpener &&
    typeof rawOpener.eventId === "string" &&
    typeof rawOpener.createdAt === "number"
      ? { eventId: rawOpener.eventId, createdAt: rawOpener.createdAt }
      : undefined;
  return {
    agentPubkey:
      typeof value.agentPubkey === "string" ? value.agentPubkey : null,
    ...(typeof value.channelId === "string"
      ? { channelId: value.channelId }
      : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(opener ? { opener } : {}),
    ...(typeof value.requestId === "string"
      ? { requestId: value.requestId }
      : {}),
    ...(result ? { result } : {}),
    ...(typeof value.resultCreatedAt === "number"
      ? { resultCreatedAt: value.resultCreatedAt }
      : {}),
    status: status === "completed" && !result ? "idle" : status,
    ...(typeof value.targetCommit === "string" || value.targetCommit === null
      ? { targetCommit: value.targetCommit as string | null }
      : {}),
  };
}

function isAgentMessage(event: RelayEvent, agentPubkey: string) {
  return (
    (event.kind === KIND_STREAM_MESSAGE ||
      event.kind === KIND_STREAM_MESSAGE_V2) &&
    normalizePubkey(event.pubkey) === normalizePubkey(agentPubkey)
  );
}

function ReviewContextResultObserver({
  agentPubkey,
  channel,
  onResult,
  opener,
  requestId,
}: {
  agentPubkey: string;
  channel: Channel | null;
  onResult: (result: ProjectReviewContextResult, createdAt: number) => void;
  opener: ProjectsConversationOpener;
  requestId: string | null;
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
    const resultEvents = [
      ...(messagesQuery.data ?? []),
      ...(threadReplies.events ?? []),
    ]
      .filter(
        (event) =>
          isAgentMessage(event, agentPubkey) &&
          isAtOrAfterConversationOpener(event, opener) &&
          getThreadReference(event.tags).rootId === opener.eventId,
      )
      .sort(
        (left, right) =>
          left.created_at - right.created_at || right.id.localeCompare(left.id),
      );
    for (const event of resultEvents) {
      const result = parseProjectReviewContextResult(event.content);
      if (result && (!requestId || result.requestId === requestId)) {
        return { createdAt: event.created_at, result };
      }
    }
    return null;
  }, [
    agentPubkey,
    messagesQuery.data,
    opener,
    requestId,
    threadReplies.events,
  ]);

  React.useEffect(() => {
    if (observedResult) {
      onResult(observedResult.result, observedResult.createdAt);
    }
  }, [observedResult, onResult]);

  return null;
}

function ReviewContextStatusBadge({
  isPending,
  isStale,
  run,
}: {
  isPending: boolean;
  isStale: boolean;
  run: ReviewContextRun;
}) {
  if (isPending || run.status === "running") {
    return (
      <Badge className="gap-1" variant="info">
        <LoaderCircle className="h-3 w-3 animate-spin" /> Searching
      </Badge>
    );
  }
  if (run.status === "failed") {
    return <Badge variant="destructive">Couldn’t run</Badge>;
  }
  if (isStale) return <Badge variant="outline">Outdated</Badge>;
  if (run.status === "completed") {
    return <Badge variant="success">Context found</Badge>;
  }
  return null;
}

function ContextReference({
  reference,
}: {
  reference: ProjectReviewContextReference;
}) {
  return (
    <article
      className="rounded-lg border border-border/55 bg-background/60 p-3"
      data-testid="project-review-context-reference"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h5 className="min-w-0 flex-1 text-sm font-medium text-foreground">
          {reference.title}
        </h5>
        {reference.channel ? (
          <Badge variant="outline">#{reference.channel}</Badge>
        ) : null}
      </div>
      <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
        {reference.summary}
      </p>
      <Markdown
        className="mt-2 text-xs font-medium"
        content={`[Open source](${reference.sourceUrl})`}
        linkPreviewsSuppressed
      />
    </article>
  );
}

function ContextLane({
  empty,
  eyebrow,
  references,
  title,
  type,
}: {
  empty: string;
  eyebrow: string;
  references: ProjectReviewContextReference[];
  title: string;
  type: "prior-art" | "future-vision";
}) {
  const Icon = type === "prior-art" ? History : Telescope;
  return (
    <section
      className="min-w-0 rounded-xl border border-border/60 bg-muted/15 p-3"
      data-context-lane={type}
      data-testid="project-review-context-lane"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            {eyebrow}
          </span>
          <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        </span>
      </div>
      <div className="mt-3 space-y-2">
        {references.length > 0 ? (
          references.map((reference) => (
            <ContextReference
              key={`${reference.sourceUrl}:${reference.title}`}
              reference={reference}
            />
          ))
        ) : (
          <p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-xs leading-5 text-muted-foreground">
            {empty}
          </p>
        )}
      </div>
    </section>
  );
}

function ReviewContextResultCard({
  result,
}: {
  result: ProjectReviewContextResult;
}) {
  return (
    <section
      className="space-y-3 px-6 pt-4"
      data-testid="project-review-context-result"
    >
      <p className="text-sm leading-6 text-foreground">{result.summary}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <ContextLane
          empty="No directly relevant earlier reviews were found."
          eyebrow="Previous reviews"
          references={result.priorArt}
          title="Prior art"
          type="prior-art"
        />
        <ContextLane
          empty="No sourced future-direction conversations were found."
          eyebrow="Team direction"
          references={result.futureVision}
          title="Future vision"
          type="future-vision"
        />
      </div>
    </section>
  );
}

export function ProjectReviewMemory({
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
  const relayScope = activeCommunity?.relayUrl
    ? normalizeRelayUrl(activeCommunity.relayUrl)
    : null;
  const signerScope = identityQuery.data?.pubkey
    ? normalizePubkey(identityQuery.data.pubkey)
    : null;
  const storageKey = projectReviewContextStorageKey({
    relayUrl: relayScope,
    signerPubkey: signerScope,
    repoAddress: pullRequest.repoAddress ?? project.repoAddress,
    reviewId: pullRequest.id,
  });
  const storageKeyRef = React.useRef(storageKey);
  const [run, setRun] = React.useState<ReviewContextRun>({
    agentPubkey: null,
    status: "idle",
  });
  const [isPending, setIsPending] = React.useState(false);
  const targetCommit = pullRequest.commit ?? pullRequest.initialCommit;
  const repoUrl = React.useMemo(
    () =>
      [project.webUrl, ...project.cloneUrls].find(
        (url): url is string =>
          typeof url === "string" && /^https?:\/\//i.test(url),
      ) ?? null,
    [project.cloneUrls, project.webUrl],
  );

  React.useEffect(() => {
    storageKeyRef.current = storageKey;
    const stored = normalizeStoredRun(
      readProjectReviewContextRun(
        typeof window === "undefined" ? null : window.localStorage,
        storageKey,
      ),
    );
    setRun(stored ?? { agentPubkey: null, status: "idle" });
    setIsPending(false);
  }, [storageKey]);

  const updateRun = React.useCallback(
    (
      expectedStorageKey: string,
      update: (current: ReviewContextRun) => ReviewContextRun,
    ) => {
      if (storageKeyRef.current !== expectedStorageKey) return;
      setRun((current) => {
        const next = update(current);
        writeProjectReviewContextRun(
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
    (result: ProjectReviewContextResult, createdAt: number) => {
      const expectedStorageKey = storageKeyRef.current;
      if (!expectedStorageKey) return;
      updateRun(expectedStorageKey, (current) => ({
        ...current,
        error: undefined,
        result,
        resultCreatedAt: createdAt,
        status: "completed",
      }));
      toast.success("Prior art and future vision are ready.");
    },
    [updateRun],
  );

  const runDiscovery = React.useCallback(
    async (agent: ReviewAgent, supersededRun?: ReviewContextRun) => {
      const expectedStorageKey = storageKey;
      if (!expectedStorageKey || !relayScope || !signerScope) return;
      const requestId = crypto.randomUUID();
      if (!agent.isManaged && !agent.isActive) {
        toast.error(
          `${agent.name} is offline and cannot be started from this dev build.`,
        );
        return;
      }
      setIsPending(true);
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
        const prompt = buildProjectReviewContextPrompt({
          branchName: pullRequest.branchName,
          channelId: channel.id,
          commit: targetCommit,
          projectName: project.name,
          repoAddress: pullRequest.repoAddress ?? project.repoAddress,
          repoUrl,
          requestId,
          reviewId: pullRequest.id,
          reviewLink: pullRequestShareLink(pullRequest) ?? "unavailable",
          reviewTitle: pullRequest.title,
          supersededRequestId: supersededRun?.requestId,
          supersededEventId: supersededRun?.opener?.eventId,
          targetBranch: pullRequest.targetBranch,
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
        updateRun(expectedStorageKey, (current) => ({
          ...current,
          agentPubkey: agent.pubkey,
          channelId: channel.id,
          error: undefined,
          opener: { createdAt: sent.createdAt, eventId: sent.eventId },
          requestId,
          result: undefined,
          resultCreatedAt: undefined,
          status: "running",
          targetCommit,
        }));
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to discover review context.";
        if (!supersededRun) {
          updateRun(expectedStorageKey, (current) => ({
            ...current,
            error: message,
            result: undefined,
            status: "failed",
            targetCommit,
          }));
        }
        toast.error(message);
      } finally {
        if (storageKeyRef.current === expectedStorageKey) setIsPending(false);
      }
    },
    [
      openDmMutation,
      project.name,
      project.repoAddress,
      pullRequest,
      relayScope,
      repoUrl,
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
  const runningAgent =
    run.status === "running" && run.agentPubkey
      ? (reviewAgents.candidates.find(
          (candidate) =>
            normalizePubkey(candidate.pubkey) ===
            normalizePubkey(run.agentPubkey ?? ""),
        ) ?? null)
      : null;
  const actionAgent = run.status === "running" ? runningAgent : selectedAgent;
  const hasRun = run.status !== "idle";
  const isStale =
    run.status === "completed" && run.targetCommit !== targetCommit;
  const observerChannel = run.channelId
    ? (channelsById.get(run.channelId) ?? null)
    : null;

  return (
    <div className="-mx-6" data-testid="project-review-memory">
      <div className="border-b border-border/55 px-6 pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Search className="h-4 w-4 text-primary" />
              <h4 className="text-sm font-semibold text-foreground">
                Context discovery
              </h4>
              <ReviewContextStatusBadge
                isPending={isPending}
                isStale={isStale}
                run={run}
              />
            </div>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              An agent finds the previous reviews that explain how the team got
              here and the channel conversations that describe where it wants to
              go. This context informs the review; it is not a merge gate.
            </p>
          </div>
          <Button
            aria-label={
              run.status === "running"
                ? "Interrupt and find context again"
                : hasRun
                  ? "Find context again"
                  : "Find context"
            }
            disabled={!actionAgent || isPending || !storageKey}
            onClick={() => {
              if (actionAgent) {
                void runDiscovery(
                  actionAgent,
                  run.status === "running" ? run : undefined,
                );
              }
            }}
            size={hasRun ? "icon" : "sm"}
            title={hasRun ? "Find context again" : undefined}
            type="button"
            variant="secondary"
          >
            {isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : hasRun ? (
              <RotateCcw />
            ) : (
              <Play />
            )}
            {hasRun ? null : "Find context"}
          </Button>
        </div>
        {run.error ? (
          <p className="mt-2 text-xs text-destructive">{run.error}</p>
        ) : null}
      </div>
      {run.result ? <ReviewContextResultCard result={run.result} /> : null}
      {run.status === "idle" ? (
        <div className="px-6 pt-4">
          <div className="grid gap-3 md:grid-cols-2">
            <ContextLane
              empty="Run context discovery to find earlier reviews and the decisions they preserve."
              eyebrow="Previous reviews"
              references={[]}
              title="Prior art"
              type="prior-art"
            />
            <ContextLane
              empty="Run context discovery to find sourced direction in project-linked conversations."
              eyebrow="Team direction"
              references={[]}
              title="Future vision"
              type="future-vision"
            />
          </div>
        </div>
      ) : null}
      {run.status === "running" && run.opener && run.agentPubkey ? (
        <ReviewContextResultObserver
          agentPubkey={run.agentPubkey}
          channel={observerChannel}
          onResult={recordResult}
          opener={run.opener}
          requestId={run.requestId ?? null}
        />
      ) : null}
    </div>
  );
}
