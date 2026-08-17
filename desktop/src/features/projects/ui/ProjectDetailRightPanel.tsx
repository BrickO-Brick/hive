import type * as React from "react";

import type { ProjectDetailAgentContext } from "@/features/projects/lib/projectDetailAgentContext";
import { ProjectAgentChatPanel } from "./ProjectAgentChatPanel";
import { ProjectRepositoryActionsPanel } from "./ProjectRepositoryActionsPanel";
import type { ProjectRightPanelMode } from "./ProjectRightPanelControls";

type RepositoryPanelProps = React.ComponentProps<
  typeof ProjectRepositoryActionsPanel
>;

export function ProjectDetailRightPanel({
  context,
  detachedRepository = false,
  mode,
  onClose,
  ...repositoryProps
}: RepositoryPanelProps & {
  context: ProjectDetailAgentContext;
  detachedRepository?: boolean;
  mode: ProjectRightPanelMode;
  onClose: () => void;
}) {
  if (mode === "chat") {
    return (
      <ProjectAgentChatPanel
        canResetWidth={repositoryProps.canResetWidth}
        constrainToAvailableSpace={false}
        context={context}
        key={context.repoAddress}
        onClose={onClose}
        onResetWidth={repositoryProps.onResetWidth}
        onResizeStart={repositoryProps.onResizeStart}
        widthPx={repositoryProps.widthPx}
      />
    );
  }
  return (
    <ProjectRepositoryActionsPanel
      detached={detachedRepository}
      {...repositoryProps}
    />
  );
}
