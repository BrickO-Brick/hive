import { useProjectsQuery } from "@/features/projects/hooks";

export function isProjectHomeChannel(
  channelId: string | null | undefined,
  projects: ReadonlyArray<{ projectChannelId: string | null }>,
): boolean {
  if (!channelId) return false;
  return projects.some((project) => project.projectChannelId === channelId);
}

export function useIsProjectHomeChannel(channelId: string | null | undefined) {
  const projectsQuery = useProjectsQuery();
  return isProjectHomeChannel(channelId, projectsQuery.data ?? []);
}
