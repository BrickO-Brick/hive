import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  buildAgentManagementResult,
  createInputFromRequest,
  requestTargetsEditablePersona,
  resolveAgentTarget,
  updateInputFromRequest,
  type AgentManagementRequest,
  type AgentManagementResult,
} from "./agentManagement";
import { subscribeAgentManagementRequests } from "./observerRelayStore";
import {
  managedAgentsQueryKey,
  personasQueryKey,
  useAcpRuntimesQuery,
  useCreateManagedAgentMutation,
  useCreatePersonaMutation,
  useDeleteManagedAgentMutation,
  useManagedAgentsQuery,
  usePersonasQuery,
  useRelayAgentsQuery,
  useUpdateManagedAgentMutation,
  useUpdatePersonaMutation,
} from "./hooks";
import {
  availableRuntimesForStart,
  buildInstanceInputForDefinition,
  type BackendIntent,
} from "./lib/instanceInputForDefinition";
import {
  executeAgentManagementRequest,
  originRejection,
} from "./lib/executeAgentManagementRequest";
import { deleteManagedAgentWithRules } from "./lib/managedAgentControlActions";
import { attachManagedAgentToChannel } from "./channelAgents";
import { useCreatedAgentChannelAttachment } from "./useCreatedAgentChannelAttachment";
import { classifyAgentManagementOrigin } from "./agentManagementBuffer";
import { useGlobalAgentConfig } from "./useGlobalAgentConfig";
import { isUnattendedAgentManagementEnabled } from "./unattendedAgentManagementPreference";
import { useChannelsQuery } from "@/features/channels/hooks";
import { resolveManagedAgentAvatarUrl } from "./ui/managedAgentAvatar";
import type { AgentCreateIntent } from "./ui/agentCreateIntent";
import { editPersonaDialogState } from "./ui/personaDialogState";
import { sendAgentObserverControl } from "@/shared/api/observerRelay";
import { removeChannelMember } from "@/shared/api/tauri";
import type {
  CreatePersonaInput,
  UpdatePersonaInput,
} from "@/shared/api/types";

/** Best-effort: the owner's change stands even if the agent never hears. */
async function reportResult(
  agentPubkey: string | null,
  result: AgentManagementResult,
) {
  if (!agentPubkey) return;
  try {
    await sendAgentObserverControl(agentPubkey, result);
  } catch (cause) {
    console.warn("Could not report the agent management result:", cause);
  }
}

export function useAgentManagement() {
  const queryClient = useQueryClient();
  const personasQuery = usePersonasQuery();
  const managedAgentsQuery = useManagedAgentsQuery();
  const relayAgentsQuery = useRelayAgentsQuery();
  const channelsQuery = useChannelsQuery();
  const runtimesQuery = useAcpRuntimesQuery({ enabled: true });
  const { globalConfig } = useGlobalAgentConfig();
  const createPersonaMutation = useCreatePersonaMutation();
  const updatePersonaMutation = useUpdatePersonaMutation();
  const createAgentMutation = useCreateManagedAgentMutation();
  const updateAgentMutation = useUpdateManagedAgentMutation();
  const deleteAgentMutation = useDeleteManagedAgentMutation();
  const [request, setRequest] = React.useState<AgentManagementRequest | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const createdAgentAttachment = useCreatedAgentChannelAttachment();
  const seenRequestIds = React.useRef(new Set<string>());
  const pendingRequestId = React.useRef<string | null>(null);
  const sourceAgentPubkey = React.useRef<string | null>(null);
  const managedAgentsRef = React.useRef(managedAgentsQuery.data);
  const channelsRef = React.useRef(channelsQuery.data);
  const bufferedRequestsRef = React.useRef<
    Array<{ agentPubkey: string; request: AgentManagementRequest }>
  >([]);
  const unattendedQueue = React.useRef<Promise<void>>(Promise.resolve());

  const runUnattended = React.useEffectEvent(
    (agentPubkey: string, next: AgentManagementRequest) => {
      // Serialize so two requests cannot race the same persona/agent state.
      unattendedQueue.current = unattendedQueue.current
        .then(async () => {
          const result = await executeAgentManagementRequest(
            next,
            agentPubkey,
            {
              agents: managedAgentsQuery.data ?? [],
              personas: personasQuery.data ?? [],
              channels: channelsQuery.data ?? [],
              relayAgents: relayAgentsQuery.data ?? [],
              preferredRuntimeId: globalConfig.preferred_runtime,
              availableRuntimes: () => availableRuntimesForStart(runtimesQuery),
              resolveAvatarUrl: (avatarUrl, fallback) =>
                resolveManagedAgentAvatarUrl(avatarUrl, undefined, fallback),
              createPersona: createPersonaMutation.mutateAsync,
              createManagedAgent: createAgentMutation.mutateAsync,
              updatePersona: updatePersonaMutation.mutateAsync,
              updateManagedAgent: updateAgentMutation.mutateAsync,
              deleteManagedAgent: deleteAgentMutation.mutateAsync,
              attachToChannel: async (channelId, agent) => {
                await attachManagedAgentToChannel(channelId, {
                  agent,
                  role: "bot",
                  ensureRunning: true,
                });
              },
              removeFromChannel: removeChannelMember,
            },
          );
          await reportResult(agentPubkey, result);
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: personasQueryKey }),
            queryClient.invalidateQueries({ queryKey: managedAgentsQueryKey }),
          ]);
          const subject = result.agentName ?? "agent";
          if (result.status === "executed") {
            toast.success(
              next.action === "create"
                ? `An agent created ${subject}.`
                : next.action === "update"
                  ? `An agent updated ${subject}.`
                  : `An agent deleted ${subject}.`,
            );
          } else {
            toast.error(`Agent ${next.action} request not applied`, {
              description: result.error,
            });
          }
        })
        .catch((cause) => {
          console.warn("Unattended agent management failed:", cause);
        });
    },
  );

  const acceptOwnedRequest = React.useEffectEvent(
    (agentPubkey: string, next: AgentManagementRequest) => {
      if (seenRequestIds.current.has(next.requestId)) return;
      if (
        classifyAgentManagementOrigin(
          managedAgentsRef.current,
          channelsRef.current,
          agentPubkey,
          next.request.channelId,
        ) !== "accept"
      ) {
        seenRequestIds.current.add(next.requestId);
        void reportResult(
          agentPubkey,
          buildAgentManagementResult(next, "rejected", {
            error:
              "An agent can only manage agents from a channel you both belong to.",
          }),
        );
        return;
      }
      seenRequestIds.current.add(next.requestId);
      setError(null);
      if (isUnattendedAgentManagementEnabled() && next.review !== true) {
        runUnattended(agentPubkey, next);
        return;
      }
      if (pendingRequestId.current === null) {
        pendingRequestId.current = next.requestId;
        sourceAgentPubkey.current = agentPubkey;
        setRequest(next);
        void reportResult(
          agentPubkey,
          buildAgentManagementResult(next, "pending_owner_review"),
        );
      } else {
        void reportResult(
          agentPubkey,
          buildAgentManagementResult(next, "rejected", {
            error:
              "The owner is already reviewing another agent request. Try again shortly.",
          }),
        );
      }
    },
  );

  React.useEffect(() => {
    managedAgentsRef.current = managedAgentsQuery.data;
    channelsRef.current = channelsQuery.data;
    if (managedAgentsQuery.data && channelsQuery.data) {
      const buffered = bufferedRequestsRef.current.splice(0);
      for (const candidate of buffered) {
        acceptOwnedRequest(candidate.agentPubkey, candidate.request);
      }
    }
  }, [channelsQuery.data, managedAgentsQuery.data]);

  React.useEffect(
    () =>
      subscribeAgentManagementRequests((agentPubkey, next) => {
        // Observer frames are owner-scoped and authenticated. Any managed agent
        // this Desktop owns may draft a change; defer the ownership decision
        // until the managed-agent query has initialized so ephemeral requests
        // cannot disappear during startup.
        if (
          classifyAgentManagementOrigin(
            managedAgentsRef.current,
            channelsRef.current,
            agentPubkey,
            next.request.channelId,
          ) === "buffer"
        ) {
          bufferedRequestsRef.current.push({ agentPubkey, request: next });
          if (bufferedRequestsRef.current.length > 100) {
            bufferedRequestsRef.current.shift();
          }
          return;
        }
        acceptOwnedRequest(agentPubkey, next);
      }),
    [],
  );

  const targetAgent = React.useMemo(() => {
    if (request?.action !== "update" && request?.action !== "delete") {
      return null;
    }
    const resolved = resolveAgentTarget(
      managedAgentsQuery.data,
      request.request,
    );
    return resolved.ok
      ? resolved
      : { ok: false as const, error: resolved.error };
  }, [managedAgentsQuery.data, request]);

  const currentPersona = React.useMemo(() => {
    if (request?.action !== "update" || !targetAgent?.ok) return undefined;
    const personaId = targetAgent.agent.personaId;
    const persona = personaId
      ? (personasQuery.data ?? []).find(
          (candidate) => candidate.id === personaId,
        )
      : undefined;
    return requestTargetsEditablePersona(persona) ? persona : undefined;
  }, [personasQuery.data, request, targetAgent]);

  const isPending =
    createPersonaMutation.isPending ||
    updatePersonaMutation.isPending ||
    createAgentMutation.isPending ||
    updateAgentMutation.isPending ||
    deleteAgentMutation.isPending;

  function assertAgentCanActFromOrigin(channelId: string) {
    const rejection = originRejection(
      channelsQuery.data ?? [],
      sourceAgentPubkey.current ?? "",
      channelId,
    );
    if (rejection) throw new Error(rejection);
  }

  async function finish(result: AgentManagementResult) {
    await reportResult(sourceAgentPubkey.current, result);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: personasQueryKey }),
      queryClient.invalidateQueries({ queryKey: managedAgentsQueryKey }),
    ]);
    pendingRequestId.current = null;
    sourceAgentPubkey.current = null;
    setRequest(null);
  }

  async function submitCreate(
    input: CreatePersonaInput | UpdatePersonaInput,
    intent: AgentCreateIntent,
    backendIntent: BackendIntent | null,
  ): Promise<boolean> {
    if (request?.action !== "create" || "id" in input) {
      return false;
    }
    setError(null);
    try {
      assertAgentCanActFromOrigin(request.request.channelId);
      const runtimes = await availableRuntimesForStart(runtimesQuery);
      const runtime = runtimes.find(
        (candidate) => candidate.id === input.runtime,
      );
      if (!runtime) {
        throw new Error("Choose an available runtime for this agent.");
      }

      const avatarUrl = await resolveManagedAgentAvatarUrl(
        input.avatarUrl,
        undefined,
        runtime.avatarUrl,
      );
      const persona = await createPersonaMutation.mutateAsync({
        ...input,
        avatarUrl,
      });
      let agentPubkey: string | undefined;

      if (intent === "definition_start") {
        const created = await createAgentMutation.mutateAsync(
          await buildInstanceInputForDefinition(
            persona,
            runtime,
            undefined,
            backendIntent ?? undefined,
          ),
        );
        if (created.spawnError) throw new Error(created.spawnError);
        agentPubkey = created.agent.pubkey;
        const targetChannel = (channelsQuery.data ?? []).find(
          (channel) => channel.id === request.request.channelId,
        );
        await createdAgentAttachment.presentCreatedAgent(created, {
          id: request.request.channelId,
          name: targetChannel?.name ?? "this channel",
        });
      }

      await finish(
        buildAgentManagementResult(request, "executed", {
          agentPubkey,
          agentName: persona.displayName,
          personaId: persona.id,
        }),
      );
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save this agent.",
      );
      return false;
    }
  }

  async function submitUpdate(input: CreatePersonaInput | UpdatePersonaInput) {
    if (request?.action !== "update" || !("id" in input)) {
      return false;
    }
    setError(null);
    try {
      assertAgentCanActFromOrigin(request.request.channelId);
      const persona = await updatePersonaMutation.mutateAsync(input);
      await finish(
        buildAgentManagementResult(request, "executed", {
          agentPubkey: targetAgent?.ok ? targetAgent.agent.pubkey : undefined,
          agentName: persona.displayName,
          personaId: persona.id,
        }),
      );
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save this agent.",
      );
      return false;
    }
  }

  async function confirmDelete() {
    if (request?.action !== "delete" || !targetAgent?.ok) return false;
    setError(null);
    try {
      assertAgentCanActFromOrigin(request.request.channelId);
      const agent = targetAgent.agent;
      await deleteManagedAgentWithRules({
        agent,
        channels: channelsQuery.data ?? [],
        deleteManagedAgent: deleteAgentMutation.mutateAsync,
        relayAgents: relayAgentsQuery.data ?? [],
        skipRemoteDeleteConfirm: true,
      });
      await finish(
        buildAgentManagementResult(request, "executed", {
          agentPubkey: agent.pubkey,
          agentName: agent.name,
        }),
      );
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not delete this agent.",
      );
      return false;
    }
  }

  function dismiss() {
    // Read the refs, not the rendered `request`: the dialog calls
    // onOpenChange(false) from a stale closure after a successful submit, and
    // `finish` has already cleared the refs by then.
    if (request && pendingRequestId.current === request.requestId) {
      void reportResult(
        sourceAgentPubkey.current,
        buildAgentManagementResult(request, "dismissed"),
      );
    }
    pendingRequestId.current = null;
    sourceAgentPubkey.current = null;
    setRequest(null);
  }

  const createInitialValues = React.useMemo(
    () =>
      request?.action === "create" ? createInputFromRequest(request) : null,
    [request],
  );

  const editInitialValues = React.useMemo(() => {
    if (request?.action !== "update" || !currentPersona) return null;
    return updateInputFromRequest(
      request,
      editPersonaDialogState(
        currentPersona,
        targetAgent?.ok ? targetAgent.agent : undefined,
      ).initialValues as UpdatePersonaInput,
    );
  }, [currentPersona, request, targetAgent]);

  const editError = React.useMemo(() => {
    if (request?.action !== "update") return error;
    if (error) return error;
    if (targetAgent && !targetAgent.ok) return targetAgent.error;
    if (!currentPersona) {
      return "Agents can only update one of your personal agents that has an editable definition.";
    }
    return null;
  }, [currentPersona, error, request, targetAgent]);

  const deleteError = React.useMemo(() => {
    if (request?.action !== "delete") return error;
    if (error) return error;
    if (targetAgent && !targetAgent.ok) return targetAgent.error;
    return null;
  }, [error, request, targetAgent]);

  return {
    request,
    sourceAgentPubkey: sourceAgentPubkey.current,
    targetAgent: targetAgent?.ok ? targetAgent.agent : null,
    createInitialValues,
    editInitialValues,
    editError,
    deleteError,
    error,
    ...createdAgentAttachment,
    isPending,
    runtimes: runtimesQuery.data ?? [],
    runtimeCatalogStatus: runtimesQuery.isLoading
      ? ("loading" as const)
      : runtimesQuery.isError
        ? ("error" as const)
        : ("ready" as const),
    submitCreate,
    submitUpdate,
    confirmDelete,
    dismiss,
  };
}
