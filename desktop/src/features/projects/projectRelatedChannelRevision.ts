import type { Project } from "@/features/projects/projectModels";
import { isValidProjectChannelId } from "@/features/projects/projectModels";
import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_PROJECT_REVISION } from "@/shared/constants/kinds";

export type ProjectRelatedChannelOperation =
  | "add-related-channel"
  | "remove-related-channel";

export function buildProjectRelatedChannelRevisionTemplate(
  project: Pick<
    Project,
    | "effectiveRevisionId"
    | "legacy"
    | "projectAddress"
    | "projectChannelId"
    | "relatedChannelIds"
  >,
  channelId: string,
  operation: ProjectRelatedChannelOperation,
) {
  if (project.legacy || !project.projectAddress.startsWith("30621:")) {
    throw new Error("Only explicit Projects can link related channels.");
  }
  const expectedRevision = project.effectiveRevisionId?.toLowerCase();
  if (!expectedRevision || !/^[0-9a-f]{64}$/.test(expectedRevision)) {
    throw new Error("Refresh this Project before changing its channels.");
  }
  const normalizedChannelId = channelId.trim().toLowerCase();
  if (!isValidProjectChannelId(normalizedChannelId)) {
    throw new Error("Project channel is invalid.");
  }
  if (normalizedChannelId === project.projectChannelId?.toLowerCase()) {
    throw new Error("The Project home channel cannot also be related.");
  }
  const alreadyRelated = project.relatedChannelIds.some(
    (candidate) => candidate.toLowerCase() === normalizedChannelId,
  );
  if (operation === "add-related-channel" && alreadyRelated) {
    throw new Error("That channel is already related to this Project.");
  }
  if (operation === "remove-related-channel" && !alreadyRelated) {
    throw new Error("That channel is not related to this Project.");
  }
  return {
    kind: KIND_PROJECT_REVISION,
    content: "",
    tags: [
      ["a", project.projectAddress],
      ["e", expectedRevision],
      ["op", operation],
      ["channel", normalizedChannelId],
    ],
  };
}

export async function publishProjectRelatedChannelRevision(
  project: Parameters<typeof buildProjectRelatedChannelRevisionTemplate>[0],
  channelId: string,
  operation: ProjectRelatedChannelOperation,
  deps?: {
    publishEvent?: typeof relayClient.publishEvent;
    signEvent?: typeof signRelayEvent;
  },
): Promise<RelayEvent> {
  const event = await (deps?.signEvent ?? signRelayEvent)(
    buildProjectRelatedChannelRevisionTemplate(project, channelId, operation),
  );
  await (deps?.publishEvent ?? relayClient.publishEvent.bind(relayClient))(
    event,
    "Could not confirm the Project channel change. Refresh before retrying.",
    "Could not change the Project's related channels.",
  );
  return event;
}

export async function removeProjectRelatedChannel(
  project: Project,
  channelId: string,
  deps?: Parameters<typeof publishProjectRelatedChannelRevision>[3],
): Promise<Project> {
  const revision = await publishProjectRelatedChannelRevision(
    project,
    channelId,
    "remove-related-channel",
    deps,
  );
  return {
    ...project,
    createdAt: revision.created_at,
    effectiveRevisionId: revision.id.toLowerCase(),
    relatedChannelIds: project.relatedChannelIds.filter(
      (candidate) => candidate.toLowerCase() !== channelId.toLowerCase(),
    ),
  };
}
