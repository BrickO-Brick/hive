import {
  buildAgentManagementResult,
  createInputFromRequest,
  resolveAgentTarget,
  updateInputFromRequest,
  type AgentManagementCreateRequest,
  type AgentManagementDeleteRequest,
  type AgentManagementRequest,
  type AgentManagementResult,
  type AgentManagementUpdateRequest,
} from "../agentManagement";
import { deleteManagedAgentWithRules } from "./managedAgentControlActions";
import {
  buildInstanceInputForDefinition,
  resolveStartRuntimeForDefinition,
} from "./instanceInputForDefinition";
import { editPersonaDialogState } from "../ui/personaDialogState";
import { personaManagedAgentUpdate } from "@/features/profile/ui/UserProfilePanelUtils";
import type {
  AcpRuntime,
  AgentPersona,
  Channel,
  CreateManagedAgentInput,
  CreateManagedAgentResponse,
  CreatePersonaInput,
  ManagedAgent,
  RelayAgent,
  UpdateManagedAgentInput,
  UpdatePersonaInput,
} from "@/shared/api/types";

/**
 * Everything the unattended executor touches, injected so the decision logic
 * can be exercised without React Query or Tauri.
 */
export type AgentManagementExecutorDeps = {
  agents: readonly ManagedAgent[];
  personas: readonly AgentPersona[];
  channels: readonly Channel[];
  relayAgents: readonly RelayAgent[];
  preferredRuntimeId: string | null;
  availableRuntimes: () => Promise<AcpRuntime[]>;
  resolveAvatarUrl: (
    avatarUrl: string | undefined,
    fallbackAvatarUrl: string | null | undefined,
  ) => Promise<string | undefined>;
  createPersona: (input: CreatePersonaInput) => Promise<AgentPersona>;
  createManagedAgent: (
    input: CreateManagedAgentInput,
  ) => Promise<CreateManagedAgentResponse>;
  updatePersona: (input: UpdatePersonaInput) => Promise<AgentPersona>;
  updateManagedAgent: (
    input: UpdateManagedAgentInput,
  ) => Promise<{ agent: ManagedAgent; profileSyncError: string | null }>;
  deleteManagedAgent: (input: {
    pubkey: string;
    forceRemoteDelete?: boolean;
  }) => Promise<unknown>;
  attachToChannel: (channelId: string, agent: ManagedAgent) => Promise<void>;
  removeFromChannel: (channelId: string, pubkey: string) => Promise<void>;
};

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * The requesting agent may only act from a channel it shares with the owner.
 * Returns a human-readable reason when the request must be refused.
 */
export function originRejection(
  channels: readonly Pick<Channel, "id" | "isMember" | "memberPubkeys">[],
  requesterPubkey: string,
  channelId: string,
): string | null {
  const channel = channels.find((candidate) => candidate.id === channelId);
  const requester = requesterPubkey.toLowerCase();
  if (
    !channel?.isMember ||
    !channel.memberPubkeys.some((pubkey) => pubkey.toLowerCase() === requester)
  ) {
    return "An agent can only manage agents from a channel you both belong to.";
  }
  return null;
}

async function executeCreate(
  request: AgentManagementCreateRequest,
  deps: AgentManagementExecutorDeps,
): Promise<AgentManagementResult> {
  const fields = request.request;
  const runtimes = await deps.availableRuntimes();
  let runtime: AcpRuntime | undefined;
  if (fields.runtime) {
    runtime = runtimes.find((candidate) => candidate.id === fields.runtime);
    if (!runtime) {
      return buildAgentManagementResult(request, "rejected", {
        error: `Runtime "${fields.runtime}" is not available on the owner's machine.`,
      });
    }
  }

  const input = createInputFromRequest(request);
  let persona: AgentPersona;
  try {
    persona = await deps.createPersona({
      ...input,
      avatarUrl: await deps.resolveAvatarUrl(
        input.avatarUrl,
        runtime?.avatarUrl,
      ),
    });
  } catch (cause) {
    return buildAgentManagementResult(request, "failed", {
      error: errorMessage(cause, "Could not create the agent definition."),
    });
  }

  if (fields.start === false) {
    return buildAgentManagementResult(request, "executed", {
      agentName: persona.displayName,
      personaId: persona.id,
    });
  }

  try {
    const startRuntime =
      runtime ??
      resolveStartRuntimeForDefinition(
        persona,
        runtimes,
        deps.preferredRuntimeId,
      ).runtime;
    const created = await deps.createManagedAgent(
      await buildInstanceInputForDefinition(persona, startRuntime),
    );
    const details = {
      agentPubkey: created.agent.pubkey,
      agentName: created.agent.name,
      personaId: persona.id,
    };
    if (created.spawnError) {
      return buildAgentManagementResult(request, "failed", {
        ...details,
        error: `The agent was created but did not start: ${created.spawnError}`,
      });
    }
    try {
      await deps.attachToChannel(fields.channelId, created.agent);
    } catch (cause) {
      return buildAgentManagementResult(request, "failed", {
        ...details,
        error: `The agent was created but could not join the channel: ${errorMessage(cause, "unknown error")}`,
      });
    }
    return buildAgentManagementResult(request, "executed", details);
  } catch (cause) {
    return buildAgentManagementResult(request, "failed", {
      agentName: persona.displayName,
      personaId: persona.id,
      error: `The definition was saved but no agent was started: ${errorMessage(cause, "unknown error")}`,
    });
  }
}

function directAgentUpdate(
  agent: ManagedAgent,
  request: AgentManagementUpdateRequest,
  runtimes: readonly AcpRuntime[],
): UpdateManagedAgentInput | string {
  const changes = request.request;
  const input: UpdateManagedAgentInput = { pubkey: agent.pubkey };
  if (changes.displayName !== undefined) input.name = changes.displayName;
  if (changes.systemPrompt !== undefined) {
    input.systemPrompt = changes.systemPrompt;
  }
  if (changes.model !== undefined) input.model = changes.model;
  if (changes.provider !== undefined) input.provider = changes.provider;
  if (changes.respondTo !== undefined) {
    input.respondTo = changes.respondTo;
    input.respondToAllowlist = [];
  }
  if (changes.runtime !== undefined) {
    const runtime = runtimes.find(
      (candidate) => candidate.id === changes.runtime,
    );
    if (!runtime) {
      return `Runtime "${changes.runtime}" is not available on the owner's machine.`;
    }
    input.agentCommand = runtime.command;
    input.harnessOverride = true;
    input.mcpCommand = runtime.mcpCommand ?? "";
  }
  return input;
}

async function executeUpdate(
  request: AgentManagementUpdateRequest,
  deps: AgentManagementExecutorDeps,
): Promise<AgentManagementResult> {
  const target = resolveAgentTarget(deps.agents, request.request);
  if (!target.ok) {
    return buildAgentManagementResult(request, "rejected", {
      error: target.error,
    });
  }
  const { agent } = target;
  const details = { agentPubkey: agent.pubkey, agentName: agent.name };
  const persona = agent.personaId
    ? deps.personas.find((candidate) => candidate.id === agent.personaId)
    : undefined;
  if (persona?.sourceTeam) {
    return buildAgentManagementResult(request, "rejected", {
      ...details,
      error: "Team-provided agents can only be edited in their team directory.",
    });
  }
  const runtimes = await deps.availableRuntimes();
  if (
    request.request.runtime !== undefined &&
    !runtimes.some((candidate) => candidate.id === request.request.runtime)
  ) {
    return buildAgentManagementResult(request, "rejected", {
      ...details,
      error: `Runtime "${request.request.runtime}" is not available on the owner's machine.`,
    });
  }

  try {
    if (persona) {
      const updated = await deps.updatePersona(
        updateInputFromRequest(
          request,
          editPersonaDialogState(persona, agent)
            .initialValues as UpdatePersonaInput,
        ),
      );
      const agentUpdate = personaManagedAgentUpdate(agent, updated, {
        previousPersona: persona,
        runtimes,
      });
      const result = agentUpdate
        ? await deps.updateManagedAgent(agentUpdate)
        : null;
      return buildAgentManagementResult(request, "executed", {
        agentPubkey: agent.pubkey,
        agentName: result?.agent.name ?? updated.displayName,
        personaId: updated.id,
      });
    }
    const direct = directAgentUpdate(agent, request, runtimes);
    if (typeof direct === "string") {
      return buildAgentManagementResult(request, "rejected", {
        ...details,
        error: direct,
      });
    }
    const result = await deps.updateManagedAgent(direct);
    return buildAgentManagementResult(request, "executed", {
      agentPubkey: result.agent.pubkey,
      agentName: result.agent.name,
    });
  } catch (cause) {
    return buildAgentManagementResult(request, "failed", {
      ...details,
      error: errorMessage(cause, "Could not update the agent."),
    });
  }
}

async function executeDelete(
  request: AgentManagementDeleteRequest,
  requesterPubkey: string,
  deps: AgentManagementExecutorDeps,
): Promise<AgentManagementResult> {
  const target = resolveAgentTarget(deps.agents, request.request);
  if (!target.ok) {
    return buildAgentManagementResult(request, "rejected", {
      error: target.error,
    });
  }
  const { agent } = target;
  const details = { agentPubkey: agent.pubkey, agentName: agent.name };
  if (agent.pubkey.toLowerCase() === requesterPubkey.toLowerCase()) {
    return buildAgentManagementResult(request, "rejected", {
      ...details,
      error: "An agent cannot delete itself.",
    });
  }
  try {
    await deleteManagedAgentWithRules({
      agent,
      channels: deps.channels,
      deleteManagedAgent: deps.deleteManagedAgent,
      relayAgents: deps.relayAgents,
      skipRemoteDeleteConfirm: true,
    });
    const relayAgent = deps.relayAgents.find(
      (candidate) =>
        candidate.pubkey.toLowerCase() === agent.pubkey.toLowerCase(),
    );
    await Promise.allSettled(
      (relayAgent?.channelIds ?? []).map((channelId) =>
        deps.removeFromChannel(channelId, agent.pubkey),
      ),
    );
    return buildAgentManagementResult(request, "executed", details);
  } catch (cause) {
    return buildAgentManagementResult(request, "failed", {
      ...details,
      error: errorMessage(cause, "Could not delete the agent."),
    });
  }
}

/**
 * Apply an accepted request on the owner's behalf and describe the outcome.
 * Never throws: every failure becomes a `rejected`/`failed` result so the
 * requesting agent always hears back.
 */
export async function executeAgentManagementRequest(
  request: AgentManagementRequest,
  requesterPubkey: string,
  deps: AgentManagementExecutorDeps,
): Promise<AgentManagementResult> {
  const rejection = originRejection(
    deps.channels,
    requesterPubkey,
    request.request.channelId,
  );
  if (rejection) {
    return buildAgentManagementResult(request, "rejected", {
      error: rejection,
    });
  }
  switch (request.action) {
    case "create":
      return executeCreate(request, deps);
    case "update":
      return executeUpdate(request, deps);
    case "delete":
      return executeDelete(request, requesterPubkey, deps);
  }
}
