import {
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  LoaderCircle,
  Play,
  RotateCcw,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";

import {
  useManagedAgentsQuery,
  useRelayAgentsQuery,
  useStartManagedAgentMutation,
} from "@/features/agents/hooks";
import {
  getMentionableAgentPubkeys,
  getSharedChannelIds,
} from "@/features/agents/lib/agentAutocompleteEligibility";
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
  parseProjectReviewCheckResult,
  parseProjectReviewChecksConfig,
  PROJECT_REVIEW_CHECKS_CONFIG_PATH,
  projectReviewChecksStorageKey,
  readProjectReviewCheckRuns,
  writeProjectReviewCheckRuns,
  type ProjectReviewCheckDefinition,
  type ProjectReviewCheckResult,
} from "@/features/projects/lib/projectReviewChecks.mjs";
import { isAtOrAfterConversationOpener } from "@/features/projects/lib/projectAgentConversation";
import type { ProjectsConversationOpener } from "@/features/projects/lib/projectAgentConversationStorage";
import { pullRequestShareLink } from "@/features/projects/lib/projectShareLinks";
import type { ProjectPullRequest, Repository } from "@/features/projects/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import { listManagedAgents } from "@/shared/api/tauri";
import { revalidateRelayAgents } from "@/shared/api/tauriRelayAgents";
import { sendChannelMessage } from "@/shared/api/tauriMessages";
import { getProjectRepoFileContent } from "@/shared/api/projectGit";
import type { Channel, RelayEvent } from "@/shared/api/types";
import {
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
} from "@/shared/constants/kinds";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

type ReviewCheckStatus = "idle" | "running" | "completed" | "failed";

type ReviewCheckRun = {
  agentPubkey: string | null;
  requestId?: string;
  status: ReviewCheckStatus;
  targetCommit?: string | null;
  channelId?: string;
  opener?: ProjectsConversationOpener;
  result?: ProjectReviewCheckResult;
  resultCreatedAt?: number;
  error?: string;
};

type ReviewCheckRuns = Record<string, ReviewCheckRun>;

type ReviewCheckAgent = {
  pubkey: string;
  name: string;
  isManaged: boolean;
  isActive: boolean;
};

function isReviewCheckStatus(value: unknown): value is ReviewCheckStatus {
  return (
    value === "idle" ||
    value === "running" ||
    value === "completed" ||
    value === "failed"
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
      ...(typeof raw.resultCreatedAt === "number"
        ? { resultCreatedAt: raw.resultCreatedAt }
        : {}),
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    };
  }
  return runs;
}

/** Local managed agents can run on this dev build; relay agents must pass the
 * active identity's community-level respond-to policy. */
function useReviewCheckAgents() {
  const identityQuery = useIdentityQuery();
  const managedAgentsQuery = useManagedAgentsQuery();
  const relayAgentsQuery = useRelayAgentsQuery();
  const channelsQuery = useChannelsQuery();

  const candidates = React.useMemo(() => {
    const managedAgents = managedAgentsQuery.data ?? [];
    const managedByPubkey = new Map(
      managedAgents.map((agent) => [normalizePubkey(agent.pubkey), agent]),
    );
    const relayAgents = relayAgentsQuery.data ?? [];
    const sharedChannelIds = getSharedChannelIds(channelsQuery.data);
    const allowedPubkeys = getMentionableAgentPubkeys({
      currentPubkey: identityQuery.data?.pubkey,
      eligibilityScope: { type: "community" },
      managedAgentPubkeys: managedByPubkey.keys(),
      relayAgents,
      sharedChannelIds,
    });
    const assigned: ReviewCheckAgent[] = managedAgents.map((agent) => ({
      pubkey: normalizePubkey(agent.pubkey),
      name: agent.name,
      isManaged: true,
      isActive: isManagedAgentActive(agent),
    }));
    for (const relayAgent of relayAgents) {
      const pubkey = normalizePubkey(relayAgent.pubkey);
      if (managedByPubkey.has(pubkey) || !allowedPubkeys.has(pubkey)) continue;
      assigned.push({
        pubkey,
        name: relayAgent.name,
        isManaged: false,
        isActive: relayAgent.status !== "offline",
      });
    }
    return assigned.sort((left, right) => {
      if (left.isActive !== right.isActive) return left.isActive ? -1 : 1;
      if (left.isManaged !== right.isManaged) return left.isManaged ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }, [
    channelsQuery.data,
    identityQuery.data?.pubkey,
    managedAgentsQuery.data,
    relayAgentsQuery.data,
  ]);

  return {
    candidates,
    isLoading:
      identityQuery.isLoading ||
      managedAgentsQuery.isLoading ||
      relayAgentsQuery.isLoading ||
      channelsQuery.isLoading,
    isError: managedAgentsQuery.isError || relayAgentsQuery.isError,
  };
}

function useProjectReviewCheckDefinitions(project: Repository) {
  const cloneUrl = project.cloneUrls[0] ?? null;
  const configQuery = useQuery({
    queryKey: [
      "project-review-checks",
      project.id,
      cloneUrl ?? "no-clone-url",
      project.defaultBranch,
    ],
    enabled: Boolean(cloneUrl),
    queryFn: async () => {
      if (!cloneUrl) return null;
      const content = await getProjectRepoFileContent({
        cloneUrl,
        defaultBranch: project.defaultBranch,
        path: PROJECT_REVIEW_CHECKS_CONFIG_PATH,
      });
      return content
        ? {
            checks: parseProjectReviewChecksConfig(content),
            source: "project" as const,
          }
        : {
            checks: DEFAULT_PROJECT_REVIEW_CHECKS,
            source: "starter" as const,
          };
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  if (!cloneUrl) {
    return {
      checks: DEFAULT_PROJECT_REVIEW_CHECKS,
      error: null,
      isLoading: false,
      source: "starter" as const,
    };
  }
  return {
    checks: configQuery.data?.checks ?? [],
    error: configQuery.error,
    isLoading: configQuery.isLoading,
    source: configQuery.data?.source ?? null,
  };
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
  requestId,
}: {
  agentPubkey: string;
  channel: Channel | null;
  checkId: string;
  onResult: (
    checkId: string,
    result: ProjectReviewCheckResult,
    createdAt: number,
  ) => void;
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
    const events = [
      ...(messagesQuery.data ?? []),
      ...(threadReplies.events ?? []),
    ]
      .filter(
        (event) =>
          isAgentMessage(event, agentPubkey) &&
          isAtOrAfterConversationOpener(event, opener),
      )
      .sort(
        (left, right) =>
          left.created_at - right.created_at || right.id.localeCompare(left.id),
      );
    for (const event of events) {
      const result = parseProjectReviewCheckResult(event.content);
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
      onResult(checkId, observedResult.result, observedResult.createdAt);
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

function ReviewCheckResultCard({
  result,
}: {
  result: ProjectReviewCheckResult;
}) {
  const isApproved = result.conclusion === "approved";
  const findingCount = result.findings.length;
  const title = isApproved
    ? "Approved"
    : findingCount === 0
      ? "Fix recommended"
      : `${findingCount} ${findingCount === 1 ? "fix" : "fixes"} recommended`;

  return (
    <section
      className="overflow-hidden rounded-xl border border-border/70 bg-background/70"
      data-testid="project-review-check-result"
    >
      <div className="flex items-start gap-3 px-4 py-3.5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted/70">
          {isApproved ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
          ) : (
            <CircleAlert className="h-5 w-5 text-amber-500" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h5 className="text-sm font-semibold text-foreground">{title}</h5>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {result.summary}
          </p>
        </div>
      </div>
      {findingCount > 0 ? (
        <div className="divide-y divide-border/55 border-t border-border/55">
          {result.findings.map((finding) => (
            <article
              className="px-4 py-3"
              data-testid="project-review-check-finding"
              key={JSON.stringify(finding)}
            >
              <div className="flex items-start justify-between gap-4">
                <p className="min-w-0 flex-1 text-xs font-medium text-foreground">
                  {finding.title}
                </p>
                {finding.file ? (
                  <span
                    className="max-w-[45%] truncate font-mono text-2xs text-muted-foreground"
                    title={`${finding.file}${finding.line ? `:${finding.line}` : ""}`}
                  >
                    {finding.file}
                    {finding.line ? `:${finding.line}` : ""}
                  </span>
                ) : null}
              </div>
              {finding.detail ? (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {finding.detail}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function AgentPicker({
  candidates,
  disabled,
  onSelect,
  selected,
}: {
  candidates: ReviewCheckAgent[];
  disabled: boolean;
  onSelect: (pubkey: string) => void;
  selected: ReviewCheckAgent | null;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="min-w-44 justify-between"
          data-testid="project-review-check-agent-picker"
          disabled={disabled}
          size="sm"
          type="button"
          variant="outline"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <Bot className="h-3.5 w-3.5" />
            <span className="truncate">
              {selected?.name ?? "Assign an agent"}
            </span>
          </span>
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        <DropdownMenuRadioGroup
          onValueChange={onSelect}
          value={selected?.pubkey ?? ""}
        >
          {candidates.map((candidate) => (
            <DropdownMenuRadioItem
              className="flex items-center justify-between gap-3"
              key={candidate.pubkey}
              value={candidate.pubkey}
            >
              <span className="truncate">{candidate.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {candidate.isManaged
                  ? candidate.isActive
                    ? "Running here"
                    : "Can start here"
                  : candidate.isActive
                    ? "Online on relay"
                    : "Offline"}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ProjectReviewChecks({
  project,
  pullRequest,
}: {
  project: Repository;
  pullRequest: ProjectPullRequest;
}) {
  const { activeCommunity } = useCommunities();
  const identityQuery = useIdentityQuery();
  const channelsQuery = useChannelsQuery();
  const openDmMutation = useOpenDmMutation();
  const startAgentMutation = useStartManagedAgentMutation();
  const reviewCheckAgents = useReviewCheckAgents();
  const checkDefinitions = useProjectReviewCheckDefinitions(project);
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

  const assignAgent = React.useCallback(
    (checkId: string, pubkey: string) => {
      if (!storageKey) return;
      updateRun(storageKey, checkId, () => ({
        agentPubkey: normalizePubkey(pubkey),
        status: "idle",
      }));
    },
    [storageKey, updateRun],
  );

  const recordResult = React.useCallback(
    (checkId: string, result: ProjectReviewCheckResult, createdAt: number) => {
      const expectedStorageKey = storageKeyRef.current;
      if (!expectedStorageKey) return;
      updateRun(expectedStorageKey, checkId, (current) => ({
        ...current,
        error: undefined,
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

  const runCheck = React.useCallback(
    async (check: ProjectReviewCheckDefinition, agent: ReviewCheckAgent) => {
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
          reviewId: pullRequest.id,
          reviewLink: pullRequestShareLink(pullRequest) ?? "unavailable",
          reviewTitle: pullRequest.title,
          requestId,
          commit: targetCommit,
          branchName: pullRequest.branchName,
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
        updateRun(expectedStorageKey, check.id, (current) => ({
          ...current,
          error: message,
          result: undefined,
          status: "failed",
          targetCommit,
        }));
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
  const defaultAgent =
    reviewCheckAgents.candidates.find((candidate) => candidate.isActive) ??
    null;

  return (
    <div className="-mx-6" data-testid="project-review-checks">
      <div className="border-b border-border/55 px-6 pb-3 text-xs text-muted-foreground">
        The first running agent is selected automatically; you can choose a
        different local managed agent or relay agent authorized for your
        signed-in identity. Definitions come from the target branch
        {checkDefinitions.source === "project"
          ? ` (${PROJECT_REVIEW_CHECKS_CONFIG_PATH})`
          : checkDefinitions.source === "starter"
            ? " (starter checks)"
            : ""}
        ; assignments and results are local to this dev build.
      </div>
      <div className="divide-y divide-border/55">
        {checkDefinitions.checks.map((check) => {
          const run = runs[check.id] ?? {
            agentPubkey: null,
            status: "idle" as const,
          };
          const selectedAgent = run.agentPubkey
            ? (reviewCheckAgents.candidates.find(
                (candidate) =>
                  normalizePubkey(candidate.pubkey) ===
                  normalizePubkey(run.agentPubkey ?? ""),
              ) ?? null)
            : defaultAgent;
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
                  <AgentPicker
                    candidates={reviewCheckAgents.candidates}
                    disabled={isPending || run.status === "running"}
                    onSelect={(pubkey) => assignAgent(check.id, pubkey)}
                    selected={selectedAgent}
                  />
                  <Button
                    disabled={
                      !selectedAgent ||
                      isPending ||
                      run.status === "running" ||
                      !storageKey
                    }
                    onClick={() => {
                      if (selectedAgent) void runCheck(check, selectedAgent);
                    }}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    {run.status === "completed" || run.status === "failed" ? (
                      <RotateCcw />
                    ) : isPending || run.status === "running" ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <Play />
                    )}
                    {run.status === "completed" || run.status === "failed"
                      ? "Run again"
                      : "Run"}
                  </Button>
                </div>
              </div>
              {run.status === "running" ? (
                <p className="text-xs text-muted-foreground">
                  Waiting for {selectedAgent?.name ?? "the assigned agent"} to
                  return a structured conclusion…
                </p>
              ) : null}
              {run.error ? (
                <p className="text-xs text-destructive">{run.error}</p>
              ) : null}
              {run.result ? (
                <ReviewCheckResultCard result={run.result} />
              ) : null}
              {run.status === "running" && run.opener && run.agentPubkey ? (
                <ReviewCheckResultObserver
                  agentPubkey={run.agentPubkey}
                  channel={observerChannel}
                  checkId={check.id}
                  onResult={recordResult}
                  opener={run.opener}
                  requestId={run.requestId ?? null}
                />
              ) : null}
            </article>
          );
        })}
      </div>
      {checkDefinitions.isLoading ? (
        <div className="flex items-center gap-2 px-6 py-4 text-xs text-muted-foreground">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Loading project
          checks…
        </div>
      ) : null}
      {checkDefinitions.error ? (
        <div className="px-6 py-4 text-xs text-destructive">
          {checkDefinitions.error instanceof Error
            ? checkDefinitions.error.message
            : `Could not load ${PROJECT_REVIEW_CHECKS_CONFIG_PATH}.`}
        </div>
      ) : null}
      {!reviewCheckAgents.isLoading &&
      reviewCheckAgents.candidates.length === 0 ? (
        <div className="border-t border-border/55 px-6 py-3 text-xs text-muted-foreground">
          {reviewCheckAgents.isError
            ? "Local managed agents or the relay agent directory could not be loaded."
            : "No local managed or authorized relay agents are available."}
        </div>
      ) : null}
    </div>
  );
}
