import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  channelsQueryKey,
  upsertCachedChannel,
} from "@/features/channels/hooks";
import { type Project, projectsQueryKey } from "@/features/projects/hooks";
import {
  createProject,
  type CreateProjectInput,
  type CreateProjectResult,
  type CreateProjectResumeState,
} from "@/features/projects/createProject";
import { addProjectToSidebar } from "@/features/projects/lib/projectSidebarMembership";
import type { Channel } from "@/shared/api/types";
import { getCachedRelayOrigin } from "@/shared/lib/mediaUrl";

export type { CreateProjectInput, CreateProjectResult };

/** Mutation that creates a project home and inserts it into the caches. */
export function useCreateProjectMutation() {
  const queryClient = useQueryClient();
  const resumeRef = React.useRef<CreateProjectResumeState>({
    channels: new Map(),
    projectIds: new Set(),
  });

  return useMutation({
    mutationFn: (input: CreateProjectInput) =>
      createProject(input, resumeRef.current),
    onSuccess: ({ channel, project }) => {
      addProjectToSidebar(
        project.projectAddress,
        getCachedRelayOrigin(),
        project.owner,
      );
      queryClient.setQueryData<Project[]>(projectsQueryKey, (current = []) => [
        project,
        ...current.filter(
          (candidate) =>
            candidate.id !== project.id &&
            !(
              candidate.legacy &&
              candidate.owner === project.owner &&
              candidate.dtag === project.dtag
            ),
        ),
      ]);
      if (channel) {
        queryClient.setQueryData(
          channelsQueryKey,
          (current: Channel[] | undefined) =>
            upsertCachedChannel(current, channel),
        );
        void queryClient.invalidateQueries({
          queryKey: channelsQueryKey,
          refetchType: "none",
        });
      }
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
  });
}
