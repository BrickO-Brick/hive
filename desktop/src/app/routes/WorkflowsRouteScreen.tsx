import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { useChannelsQuery } from "@/features/channels/hooks";
import {
  type WorkflowEditorRoute,
  WorkflowsScreen,
} from "@/features/workflows/ui/WorkflowsScreen";

type WorkflowsRouteScreenProps = {
  editor?: WorkflowEditorRoute | null;
};

export function WorkflowsRouteScreen({
  editor = null,
}: WorkflowsRouteScreenProps) {
  const {
    closeWorkflowEditor,
    goDuplicateWorkflow,
    goNewWorkflow,
    goWorkflow,
  } = useAppNavigation();
  const channelsQuery = useChannelsQuery();
  const channels = channelsQuery.data ?? [];
  const memberChannels = channels.filter((channel) => channel.isMember);

  return (
    <WorkflowsScreen
      channels={memberChannels}
      editor={editor}
      onCloseEditor={closeWorkflowEditor}
      onCreateWorkflow={() => {
        void goNewWorkflow();
      }}
      onDuplicateWorkflow={(workflowId) => {
        void goDuplicateWorkflow(workflowId);
      }}
      onEditWorkflow={(workflowId) => {
        void goWorkflow(workflowId);
      }}
    />
  );
}
