import { useMutation, useQueryClient } from "@tanstack/react-query";

import { projectsQueryKey } from "@/features/projects/hooks";
import type { Project } from "@/features/projects/projectModels";
import { removeProjectRelatedChannel } from "@/features/projects/projectRelatedChannelRevision";
import { markProjectDataAuthoritative } from "@/features/projects/projectSnapshot";

export function useRemoveProjectRelatedChannelMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      channelId,
      project,
    }: {
      channelId: string;
      project: Project;
    }) => removeProjectRelatedChannel(project, channelId),
    onSuccess: (project) => {
      markProjectDataAuthoritative(project, "local-write");
      queryClient.setQueryData<Project[]>(projectsQueryKey, (current = []) =>
        current.map((candidate) =>
          candidate.id === project.id ? project : candidate,
        ),
      );
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
  });
}
