import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { usePreviewFeatureWarning } from "@/shared/features";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

export const Route = createFileRoute("/workflows/$workflowId")({
  component: WorkflowEditorRouteComponent,
  validateSearch: (search: Record<string, unknown>) => ({
    view: search.view === "duplicate" ? search.view : undefined,
  }),
});

const WorkflowsRouteScreen = React.lazy(async () => {
  const module = await import("./WorkflowsRouteScreen");
  return { default: module.WorkflowsRouteScreen };
});

function WorkflowEditorRouteComponent() {
  usePreviewFeatureWarning("workflows");
  const { workflowId } = Route.useParams();
  const { view } = Route.useSearch();

  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="workflows" />}>
      <WorkflowsRouteScreen
        editor={{
          mode: view === "duplicate" ? "duplicate" : "edit",
          workflowId,
        }}
      />
    </React.Suspense>
  );
}
