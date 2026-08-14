import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import {
  parseWorkflowEditorPane,
  serializeWorkflowEditorPane,
} from "@/features/workflows/ui/workflowEditorPane";
import { usePreviewFeatureWarning } from "@/shared/features";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

export const Route = createFileRoute("/workflows/$workflowId")({
  component: WorkflowEditorRouteComponent,
  validateSearch: (search: Record<string, unknown>) => ({
    pane: serializeWorkflowEditorPane(parseWorkflowEditorPane(search.pane)),
    view: search.view === "duplicate" ? search.view : undefined,
  }),
});

const WorkflowsRouteScreen = React.lazy(async () => {
  const module = await import("./WorkflowsRouteScreen");
  return { default: module.WorkflowsRouteScreen };
});

function WorkflowEditorRouteComponent() {
  usePreviewFeatureWarning("workflows");
  const navigate = Route.useNavigate();
  const { workflowId } = Route.useParams();
  const { pane, view } = Route.useSearch();

  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="workflows" />}>
      <WorkflowsRouteScreen
        editor={{
          mode: view === "duplicate" ? "duplicate" : "edit",
          pane: parseWorkflowEditorPane(pane),
          workflowId,
        }}
        onEditorPaneChange={(nextPane) => {
          void navigate({
            resetScroll: false,
            search: {
              pane: serializeWorkflowEditorPane(nextPane),
              view,
            },
          });
        }}
      />
    </React.Suspense>
  );
}
