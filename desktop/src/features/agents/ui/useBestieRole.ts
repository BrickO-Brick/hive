import * as React from "react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import {
  useAcpRuntimesQuery,
  useCreateManagedAgentMutation,
  useCreatePersonaMutation,
  useDeleteManagedAgentMutation,
  useManagedAgentsQuery,
  useStartManagedAgentMutation,
  useStopManagedAgentMutation,
  useUpdateManagedAgentMutation,
} from "@/features/agents/hooks";
import {
  clearBestieAssignment,
  readBestieAssignment,
  writeBestieAssignment,
} from "@/features/agents/lib/bestieAssignment";
import {
  composeBestiePrompt,
  type BestieCapabilityState,
} from "@/features/agents/lib/bestieCapabilities";
import { buildInstanceInputForDefinition } from "@/features/agents/lib/instanceInputForDefinition";
import { getDefaultPersonaRuntime } from "@/features/agents/lib/resolvePersonaRuntime";
import { canonicalRelayUrl } from "@/features/agents/managedAgentRuntimeStatus";
import { useGlobalAgentConfig } from "@/features/agents/useGlobalAgentConfig";
import { useOpenDmMutation } from "@/features/channels/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import type { AcpRuntime, RespondToMode } from "@/shared/api/types";
import type { BestieSetupSubmission } from "./BestieSetupDialog";

/**
 * Maps capability switches onto the platform controls that actually enforce
 * them. `respondTo` is the real inbound/outbound gate: `owner-only` keeps the
 * agent talking to its owner, so an agent without `speakInChannels` cannot be
 * engaged by other people in shared channels.
 */
function respondToForCapabilities(
  capabilities: BestieCapabilityState,
): RespondToMode {
  return capabilities.speakInChannels ? "anyone" : "owner-only";
}

export function useBestieRole() {
  const { goChannel } = useAppNavigation();
  const { activeCommunity } = useCommunities();
  const { globalConfig } = useGlobalAgentConfig();
  const agentsQuery = useManagedAgentsQuery();
  const runtimesQuery = useAcpRuntimesQuery({ enabled: true });
  const createPersonaMutation = useCreatePersonaMutation();
  const createAgentMutation = useCreateManagedAgentMutation();
  const updateAgentMutation = useUpdateManagedAgentMutation();
  const startAgentMutation = useStartManagedAgentMutation();
  const stopAgentMutation = useStopManagedAgentMutation();
  const deleteAgentMutation = useDeleteManagedAgentMutation();
  const openDmMutation = useOpenDmMutation();

  const relayUrl = canonicalRelayUrl(activeCommunity?.relayUrl ?? "");
  const [assignment, setAssignment] = React.useState(() =>
    readBestieAssignment(relayUrl),
  );

  // Re-read when the active community changes: the role is relay-scoped.
  const lastRelayRef = React.useRef(relayUrl);
  if (lastRelayRef.current !== relayUrl) {
    lastRelayRef.current = relayUrl;
    setAssignment(readBestieAssignment(relayUrl));
  }

  const agent =
    agentsQuery.data?.find(
      (candidate) => candidate.pubkey === assignment?.agentPubkey,
    ) ?? null;

  // An assignment whose agent no longer exists should not keep claiming a role.
  const isOrphaned = Boolean(assignment && !agentsQuery.isLoading && !agent);

  function resolveRuntime(preferredId?: string): AcpRuntime {
    const available = (runtimesQuery.data ?? []).filter(
      (runtime): runtime is AcpRuntime => runtime.availability === "available",
    );
    const chosen = preferredId?.trim()
      ? available.find((candidate) => candidate.id === preferredId.trim())
      : null;
    if (chosen) return chosen;
    const runtime = getDefaultPersonaRuntime(
      available,
      globalConfig.preferred_runtime,
    );
    if (!runtime) {
      throw new Error(
        "No agent runtime is available. Set one up in Agents and try again.",
      );
    }
    return runtime;
  }

  async function assign(submission: BestieSetupSubmission) {
    if (!relayUrl) {
      throw new Error("Join a community before setting up a bestie.");
    }

    const systemPrompt = composeBestiePrompt({
      additionalInstructions: submission.additionalInstructions,
      capabilities: submission.capabilities,
      personality: submission.personality,
    });
    const respondTo = respondToForCapabilities(submission.capabilities);

    let agentPubkey = submission.agentPubkey;

    if (submission.source === "new") {
      const runtime = resolveRuntime(submission.runtime);
      const persona = await createPersonaMutation.mutateAsync({
        behavior: { respondTo, respondToAllowlist: [] },
        displayName: submission.agentName,
        runtime: runtime.id,
        systemPrompt,
      });
      const created = await createAgentMutation.mutateAsync(
        await buildInstanceInputForDefinition(persona, runtime),
      );
      if (created.spawnError) {
        throw new Error(
          `${created.agent.name} was created, but it didn’t start: ${created.spawnError}`,
        );
      }
      agentPubkey = created.agent.pubkey;
    } else {
      if (!agentPubkey) throw new Error("Choose an agent to use.");
      // Write both on the *instance*, not the shared definition: the role
      // belongs to this one agent, and a shared persona may back others.
      // `respondTo` is the enforced access boundary, so the capability
      // switches land on a real limit rather than only in the prompt.
      await updateAgentMutation.mutateAsync({
        pubkey: agentPubkey,
        respondTo,
        respondToAllowlist: [],
        systemPrompt,
      });
    }

    if (!agentPubkey) throw new Error("Couldn’t resolve the agent to assign.");

    const next = {
      additionalInstructions: submission.additionalInstructions,
      agentPubkey,
      assignedAt: new Date().toISOString(),
      capabilities: submission.capabilities,
      relayUrl,
    };
    writeBestieAssignment(next);
    setAssignment(next);
    await agentsQuery.refetch();
  }

  /**
   * Drops the role and leaves the agent alone: it keeps its name, avatar,
   * instructions, and history, and reappears as an ordinary agent. Deliberately
   * does not restore the pre-assignment `respondTo` or prompt — we don't have a
   * snapshot of those, and silently rewriting an agent's configuration on
   * removal would be a worse surprise than leaving it as the user last saw it.
   */
  function unassign() {
    if (!relayUrl) return;
    clearBestieAssignment(relayUrl);
    setAssignment(null);
  }

  /** Drops the role and deletes the agent. Only offered for local agents. */
  async function unassignAndDelete() {
    if (!relayUrl || !agent) return;
    if (agent.status === "running" && agent.backend.type === "local") {
      await stopAgentMutation.mutateAsync(agent.pubkey);
    }
    await deleteAgentMutation.mutateAsync({ pubkey: agent.pubkey });
    clearBestieAssignment(relayUrl);
    setAssignment(null);
  }

  async function message() {
    if (!agent) return;
    if (agent.status !== "running" && agent.backend.type === "local") {
      await startAgentMutation.mutateAsync(agent.pubkey);
    }
    const dm = await openDmMutation.mutateAsync({ pubkeys: [agent.pubkey] });
    await goChannel(dm.id);
  }

  return {
    agent,
    agents: agentsQuery.data ?? [],
    runtimes: runtimesQuery.data ?? [],
    runtimesLoading: runtimesQuery.isLoading,
    assign,
    assignment,
    isAgentsLoading: agentsQuery.isLoading,
    isMessagePending: openDmMutation.isPending || startAgentMutation.isPending,
    isOrphaned,
    isRemovePending:
      stopAgentMutation.isPending || deleteAgentMutation.isPending,
    message,
    relayUrl,
    unassign,
    unassignAndDelete,
  };
}
