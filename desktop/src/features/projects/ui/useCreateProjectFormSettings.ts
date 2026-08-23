import * as React from "react";

import type { CreateChannelManagedAgentInput } from "@/features/agents/channelAgents";
import {
  useAvailableAcpRuntimes,
  usePersonasQuery,
} from "@/features/agents/hooks";
import { getActivePersonas } from "@/features/agents/lib/catalog";
import { resolvePersonaRuntime } from "@/features/agents/lib/resolvePersonaRuntime";
import type { ProjectListingVisibility } from "@/features/projects/projectCreation";
import type { ChannelVisibility } from "@/shared/api/types";

export function useCreateProjectFormSettings(active: boolean) {
  const personasQuery = usePersonasQuery({ enabled: active });
  const runtimesQuery = useAvailableAcpRuntimes({ enabled: active });
  const [channelVisibility, setChannelVisibility] =
    React.useState<ChannelVisibility>("open");
  const [projectVisibility, setProjectVisibility] =
    React.useState<ProjectListingVisibility>("listed");
  const [agentPersonaId, setAgentPersonaId] = React.useState("");

  const personas = React.useMemo(
    () => getActivePersonas(personasQuery.data ?? []),
    [personasQuery.data],
  );

  React.useEffect(() => {
    if (!active) return;
    setChannelVisibility("open");
    setProjectVisibility("listed");
    setAgentPersonaId("");
  }, [active]);

  React.useEffect(() => {
    if (
      agentPersonaId &&
      !personas.some((persona) => persona.id === agentPersonaId)
    ) {
      setAgentPersonaId("");
    }
  }, [agentPersonaId, personas]);

  const buildAgents =
    React.useCallback((): CreateChannelManagedAgentInput[] => {
      if (!agentPersonaId) return [];
      const persona = personas.find((entry) => entry.id === agentPersonaId);
      if (!persona) {
        throw new Error("Choose an agent that still exists.");
      }
      const defaultRuntime = runtimesQuery.data[0] ?? null;
      const resolved = resolvePersonaRuntime(
        persona.runtime,
        runtimesQuery.data,
        defaultRuntime,
        false,
      );
      if (!resolved.runtime) {
        throw new Error(
          resolved.warnings[0] ??
            "No agent runtimes are available. Install a runtime to add an agent.",
        );
      }
      return [
        {
          runtime: resolved.runtime,
          name: persona.displayName,
          personaId: persona.id,
          harnessOverride: false,
          systemPrompt: persona.systemPrompt,
          avatarUrl: persona.avatarUrl ?? undefined,
          model: persona.model ?? undefined,
          role: "bot",
          backend: { type: "local" },
        },
      ];
    }, [agentPersonaId, personas, runtimesQuery.data]);

  return {
    agentPersonaId,
    buildAgents,
    channelVisibility,
    personas,
    projectVisibility,
    runtimesAvailable: runtimesQuery.data.length > 0,
    setAgentPersonaId,
    setChannelVisibility,
    setProjectVisibility,
  };
}

export type CreateProjectFormSettingsState = ReturnType<
  typeof useCreateProjectFormSettings
>;
