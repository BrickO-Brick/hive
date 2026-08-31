import { useQueries } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { useChannelsQuery } from "@/features/channels/hooks";
import {
  CHANNEL_MEMBERS_STALE_TIME_MS,
  channelMembersQueryKey,
} from "@/features/channels/rosterFreshness";
import type { Project } from "@/features/projects/hooks";
import { useAddProjectChannelMutation } from "@/features/projects/useAddProjectChannel";
import { useAddProjectRepositoryMutation } from "@/features/projects/useAddProjectRepository";
import { AddProjectRepositoryDialog } from "@/features/projects/ui/AddProjectRepositoryDialog";
import { CreateChannelDialog } from "@/features/sidebar/ui/CreateChannelDialog";
import { getChannelMembers } from "@/shared/api/tauri";
import { canManageProjectChannels } from "@/features/projects/ui/ProjectChannelManagement";

export function ProjectsCategoryCreateDialogs({
  channelCandidateProjects,
  channelOpen,
  editableProjects,
  identityPubkey,
  onChannelOpenChange,
  onRepositoryOpenChange,
  ownerControlAgentPubkeyFor,
  repositoryOpen,
}: {
  channelCandidateProjects: Project[];
  channelOpen: boolean;
  editableProjects: Project[];
  identityPubkey?: string;
  onChannelOpenChange: (open: boolean) => void;
  onRepositoryOpenChange: (open: boolean) => void;
  ownerControlAgentPubkeyFor: (project: Project) => string | undefined;
  repositoryOpen: boolean;
}) {
  const { goChannel, goProject } = useAppNavigation();
  const homeRosterQueries = useQueries({
    queries: channelCandidateProjects.map((project) => {
      const homeChannelId = project.projectChannelId;
      return {
        enabled:
          channelOpen &&
          Boolean(homeChannelId) &&
          project.owner.toLowerCase() !== identityPubkey?.toLowerCase(),
        queryFn: () => {
          if (!homeChannelId) throw new Error("Project has no home channel.");
          return getChannelMembers(homeChannelId);
        },
        queryKey: channelMembersQueryKey(homeChannelId ?? "none"),
        staleTime: CHANNEL_MEMBERS_STALE_TIME_MS,
      };
    }),
  });
  const channelProjects = channelCandidateProjects.filter((project, index) => {
    const role = homeRosterQueries[index]?.data?.find(
      (member) => member.pubkey.toLowerCase() === identityPubkey?.toLowerCase(),
    )?.role;
    return canManageProjectChannels(project, identityPubkey, role);
  });
  const [channelProjectId, setChannelProjectId] = React.useState("");
  const channelProject =
    channelProjects.find((project) => project.id === channelProjectId) ??
    channelProjects[0];
  const createChannelMutation = useAddProjectChannelMutation();
  const createRepositoryMutation = useAddProjectRepositoryMutation();
  const channelsQuery = useChannelsQuery({ enabled: repositoryOpen });
  const repositoryAccessChannels = React.useMemo(
    () =>
      (channelsQuery.data ?? []).filter(
        (channel) =>
          channel.isMember &&
          !channel.archivedAt &&
          channel.channelType !== "dm",
      ),
    [channelsQuery.data],
  );

  return (
    <>
      <CreateChannelDialog
        channelKind={channelOpen ? "stream" : null}
        description={
          channelProject
            ? `Add another stream to ${channelProject.name}.`
            : "Choose a project for this channel."
        }
        isCreating={createChannelMutation.isPending}
        onCreate={async (input) => {
          if (!channelProject) throw new Error("Choose a project.");
          const result = await createChannelMutation.mutateAsync({
            ...input,
            project: channelProject,
          });
          toast.success(`Channel "#${result.channel.name}" created.`);
          await goChannel(result.channel.id);
        }}
        onOpenChange={onChannelOpenChange}
        testId="create-project-channel-dialog"
        title="Create a project channel"
      >
        <label className="block space-y-1.5 text-sm font-medium">
          <span>Project</span>
          <select
            className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm font-normal outline-hidden focus:ring-1 focus:ring-ring"
            data-testid="create-project-channel-project"
            disabled={createChannelMutation.isPending}
            onChange={(event) => setChannelProjectId(event.target.value)}
            value={channelProject?.id ?? ""}
          >
            {channelProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      </CreateChannelDialog>
      <AddProjectRepositoryDialog
        channels={repositoryAccessChannels}
        isCreating={createRepositoryMutation.isPending}
        onAdd={async (input) => {
          const result = await createRepositoryMutation.mutateAsync({
            ...input,
            ownerControlAgentPubkey: ownerControlAgentPubkeyFor(input.project),
          });
          toast.success(`Repository "${result.repository.name}" created.`);
          await goProject(input.project.id, {
            repositoryId: result.repository.id,
          });
        }}
        onOpenChange={onRepositoryOpenChange}
        open={repositoryOpen}
        projects={editableProjects}
      />
    </>
  );
}
