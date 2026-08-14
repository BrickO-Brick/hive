import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import {
  parseWorkflowEditorPane,
  serializeWorkflowEditorPane,
} from "@/features/workflows/ui/workflowEditorPane";
import { usePreviewFeatureWarning } from "@/shared/features";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";
import { LazyWorkflowsRouteScreen } from "./lazyWorkflowsRouteScreen";

export const Route = createFileRoute("/workflows")({
  component: WorkflowsRouteComponent,
  validateSearch: (search: Record<string, unknown>) => ({
    pane: serializeWorkflowEditorPane(parseWorkflowEditorPane(search.pane)),
    view: search.view === "create" ? search.view : undefined,
  }),
});

function WorkflowsRouteComponent() {
  usePreviewFeatureWarning("workflows");
  const navigate = Route.useNavigate();
  const { pane, view } = Route.useSearch();

  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="workflows" />}>
      <LazyWorkflowsRouteScreen
        editor={
          view === "create"
            ? { mode: "create", pane: parseWorkflowEditorPane(pane) }
            : null
        }
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
