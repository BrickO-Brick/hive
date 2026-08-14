import * as React from "react";

import type { Channel } from "@/shared/api/types";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";
import type { WorkflowEditorPane } from "./workflowEditorPane";

const WorkflowsView = React.lazy(async () => {
  const module = await import("@/features/workflows/ui/WorkflowsView");
  return { default: module.WorkflowsView };
});

export type WorkflowEditorRoute =
  | { mode: "create"; pane: WorkflowEditorPane }
  | {
      mode: "duplicate" | "edit";
      pane: WorkflowEditorPane;
      workflowId: string;
    };

type WorkflowsScreenProps = {
  channels: Channel[];
  editor: WorkflowEditorRoute | null;
  onCloseEditor: () => void;
  onCreateWorkflow: () => void;
  onDuplicateWorkflow: (workflowId: string) => void;
  onEditWorkflow: (workflowId: string) => void;
  onEditorPaneChange: (pane: WorkflowEditorPane) => void;
};

export function WorkflowsScreen({
  channels,
  editor,
  onCloseEditor,
  onCreateWorkflow,
  onDuplicateWorkflow,
  onEditWorkflow,
  onEditorPaneChange,
}: WorkflowsScreenProps) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <React.Suspense fallback={<ViewLoadingFallback kind="workflows" />}>
        <WorkflowsView
          channels={channels}
          editor={editor}
          onCloseEditor={onCloseEditor}
          onCreateWorkflow={onCreateWorkflow}
          onDuplicateWorkflow={onDuplicateWorkflow}
          onEditWorkflow={onEditWorkflow}
          onEditorPaneChange={onEditorPaneChange}
        />
      </React.Suspense>
    </div>
  );
}
