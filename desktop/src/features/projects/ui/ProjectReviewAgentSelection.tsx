import * as React from "react";

import {
  useManagedAgentsQuery,
  useRelayAgentsQuery,
} from "@/features/agents/hooks";
import {
  getMentionableAgentPubkeys,
  getSharedChannelIds,
} from "@/features/agents/lib/agentAutocompleteEligibility";
import { isManagedAgentActive } from "@/features/agents/lib/managedAgentControlActions";
import { useChannelsQuery } from "@/features/channels/hooks";
import {
  ProjectReviewDebugHarness,
  type ReviewAgent,
} from "@/features/projects/ui/ProjectReviewDebugHarness";
import { useIdentityQuery } from "@/shared/api/hooks";
import { normalizePubkey } from "@/shared/lib/pubkey";

export type ProjectReviewAgentSelection = {
  candidates: ReviewAgent[];
  isError: boolean;
  isLoading: boolean;
  select: (pubkey: string) => void;
  selected: ReviewAgent | null;
};

export function useProjectReviewAgentSelection(): ProjectReviewAgentSelection {
  const identityQuery = useIdentityQuery();
  const managedAgentsQuery = useManagedAgentsQuery();
  const relayAgentsQuery = useRelayAgentsQuery();
  const channelsQuery = useChannelsQuery();
  const [selectedAgentPubkey, setSelectedAgentPubkey] = React.useState<
    string | null
  >(null);

  const candidates = React.useMemo(() => {
    const managedAgents = managedAgentsQuery.data ?? [];
    const managedByPubkey = new Map(
      managedAgents.map((agent) => [normalizePubkey(agent.pubkey), agent]),
    );
    const relayAgents = relayAgentsQuery.data ?? [];
    const allowedPubkeys = getMentionableAgentPubkeys({
      currentPubkey: identityQuery.data?.pubkey,
      eligibilityScope: { type: "community" },
      managedAgentPubkeys: managedByPubkey.keys(),
      relayAgents,
      sharedChannelIds: getSharedChannelIds(channelsQuery.data),
    });
    const available: ReviewAgent[] = managedAgents.map((agent) => ({
      pubkey: normalizePubkey(agent.pubkey),
      name: agent.name,
      isManaged: true,
      isActive: isManagedAgentActive(agent),
    }));
    for (const relayAgent of relayAgents) {
      const pubkey = normalizePubkey(relayAgent.pubkey);
      if (managedByPubkey.has(pubkey) || !allowedPubkeys.has(pubkey)) continue;
      available.push({
        pubkey,
        name: relayAgent.name,
        isManaged: false,
        isActive: relayAgent.status !== "offline",
      });
    }
    return available.sort((left, right) => {
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
  const activeCandidates = candidates.filter((candidate) => candidate.isActive);
  const defaultAgent = activeCandidates[0] ?? null;
  const selected = selectedAgentPubkey
    ? (activeCandidates.find(
        (candidate) =>
          normalizePubkey(candidate.pubkey) ===
          normalizePubkey(selectedAgentPubkey),
      ) ?? defaultAgent)
    : defaultAgent;
  const isLoading =
    identityQuery.isLoading ||
    managedAgentsQuery.isLoading ||
    relayAgentsQuery.isLoading ||
    channelsQuery.isLoading;
  const isError = managedAgentsQuery.isError || relayAgentsQuery.isError;
  return React.useMemo(
    () => ({
      candidates,
      isError,
      isLoading,
      select: setSelectedAgentPubkey,
      selected,
    }),
    [candidates, isError, isLoading, selected],
  );
}

export function ProjectReviewAgentSelectionHarness({
  selection,
}: {
  selection: ProjectReviewAgentSelection;
}) {
  return (
    <ProjectReviewDebugHarness
      candidates={selection.candidates}
      hasError={selection.isError}
      isLoading={selection.isLoading}
      onSelect={selection.select}
      selected={selection.selected}
    />
  );
}
