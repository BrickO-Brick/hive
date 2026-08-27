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
  status: ReviewCheckStatus;
  targetCommit?: string | null;
  channelId?: string;
  opener?: ProjectsConversationOpener;
  result?: ProjectReviewCheckResult;
  resultCreatedAt?: number;
  error?: string;
};

type ReviewCheckRuns = Record<string, ReviewCheckRun>;

type RelayAssignedAgent = {
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

/**
 * A strict relay-backed candidate list. Unlike the general Projects assistant
 * picker, this does not add machine-local agents that the active identity
 * cannot also resolve through the relay directory.
 */
function useRelayAssignedAgents() {
  const identityQuery = useIdentityQuery();
  const managedAgentsQuery = useManagedAgentsQuery();
  const relayAgentsQuery = useRelayAgentsQuery();
  const channelsQuery = useChannelsQuery();

  const candidates = React.useMemo(() => {
    const managedByPubkey = new Map(
      (managedAgentsQuery.data ?? []).map((agent) => [
        normalizePubkey(agent.pubkey),
        agent,
      ]),
    );
    const relayAgents = relayAgentsQuery.data ?? [];
    const sharedChannelIds = getSharedChannelIds(channelsQuery.data);
    const allowedPubkeys = getMentionableAgentPubkeys({
      currentPubkey: identityQuery.data?.pubkey,
      eligibilityScope: { type: "community" },
      managedAgentPubkeys: [],
      relayAgents,
      sharedChannelIds,
    });
    const seen = new Set<string>();
    const assigned: RelayAssignedAgent[] = [];
    for (const relayAgent of relayAgents) {
      const pubkey = normalizePubkey(relayAgent.pubkey);
      if (seen.has(pubkey) || !allowedPubkeys.has(pubkey)) continue;
      seen.add(pubkey);
      const managedAgent = managedByPubkey.get(pubkey);
      assigned.push({
        pubkey,
        name: relayAgent.name,
        isManaged: Boolean(managedAgent),
        isActive: managedAgent
          ? isManagedAgentActive(managedAgent)
          : relayAgent.status !== "offline",
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
    isError: relayAgentsQuery.isError,
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
      if (result) return { createdAt: event.created_at, result };
    }
    return null;
  }, [agentPubkey, messagesQuery.data, opener, threadReplies.events]);

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

function AgentPicker({
  candidates,
  disabled,
  onSelect,
  selected,
}: {
  candidates: RelayAssignedAgent[];
  disabled: boolean;
  onSelect: (pubkey: string) => void;
  selected: RelayAssignedAgent | null;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="min-w-44 justify-between"
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
                    ? "On this Mac"
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
  const relayAssignedAgents = useRelayAssignedAgents();
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
    async (check: ProjectReviewCheckDefinition, agent: RelayAssignedAgent) => {
      const expectedStorageKey = storageKey;
      if (!expectedStorageKey || !relayScope || !signerScope) return;
      if (!agent.isManaged && !agent.isActive) {
        toast.error(
          `${agent.name} is offline and cannot be started from this dev build.`,
        );
        return;
      }
      setPendingCheckIds((current) => new Set(current).add(check.id));
      try {
        if (agent.isManaged && !agent.isActive) {
          await startAgentMutation.mutateAsync({
            pubkey: agent.pubkey,
            expectedRelayUrl: relayScope,
            expectedSignerPubkey: signerScope,
          });
        }
        const channel = await openDmMutation.mutateAsync({
          pubkeys: [agent.pubkey],
          expectedRelayUrl: relayScope,
          expectedSignerPubkey: signerScope,
        });
        // DMs represent every participant as a regular member, so authorization
        // comes from the selected agent's relay-signed assignment elsewhere in
        // the community rather than treating this transport channel as proof.
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
        const prompt = buildProjectReviewCheckPrompt({
          check,
          projectName: project.name,
          repoAddress: pullRequest.repoAddress ?? project.repoAddress,
          reviewId: pullRequest.id,
          reviewLink: pullRequestShareLink(pullRequest) ?? "unavailable",
          reviewTitle: pullRequest.title,
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

  return (
    <div className="-mx-6" data-testid="project-review-checks">
      <div className="border-b border-border/55 px-6 pb-3 text-xs text-muted-foreground">
        Agents are limited to identities the relay directory authorizes for your
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
          const selectedAgent =
            relayAssignedAgents.candidates.find(
              (candidate) =>
                normalizePubkey(candidate.pubkey) ===
                normalizePubkey(run.agentPubkey ?? ""),
            ) ?? null;
          const isPending = pendingCheckIds.has(check.id);
          const isStale =
            run.status === "completed" && run.targetCommit !== targetCommit;
          const observerChannel = run.channelId
            ? (channelsById.get(run.channelId) ?? null)
            : null;
          return (
            <article className="space-y-3 px-6 py-4" key={check.id}>
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
                    candidates={relayAssignedAgents.candidates}
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
                <div className="rounded-lg border border-border/55 bg-muted/25 p-3">
                  <p className="text-sm text-foreground">
                    {run.result.summary}
                  </p>
                  {run.result.findings.length > 0 ? (
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                      {run.result.findings.map((finding) => (
                        <li key={finding}>{finding}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {run.status === "running" && run.opener && run.agentPubkey ? (
                <ReviewCheckResultObserver
                  agentPubkey={run.agentPubkey}
                  channel={observerChannel}
                  checkId={check.id}
                  onResult={recordResult}
                  opener={run.opener}
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
      {!relayAssignedAgents.isLoading &&
      relayAssignedAgents.candidates.length === 0 ? (
        <div className="border-t border-border/55 px-6 py-3 text-xs text-muted-foreground">
          {relayAssignedAgents.isError
            ? "The relay agent directory could not be loaded."
            : "No agents are currently assigned to this identity by the relay."}
        </div>
      ) : null}
    </div>
  );
}
