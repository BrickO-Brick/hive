import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { usePreviewFeatureWarning } from "@/shared/features";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

export const Route = createFileRoute("/workflows")({
  component: WorkflowsRouteComponent,
  validateSearch: (search: Record<string, unknown>) => ({
    view: search.view === "create" ? search.view : undefined,
  }),
});

const WorkflowsRouteScreen = React.lazy(async () => {
  const module = await import("./WorkflowsRouteScreen");
  return { default: module.WorkflowsRouteScreen };
});

function WorkflowsRouteComponent() {
  usePreviewFeatureWarning("workflows");
  const { view } = Route.useSearch();

  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="workflows" />}>
      <WorkflowsRouteScreen
        editor={view === "create" ? { mode: "create" } : null}
      />
    </React.Suspense>
  );
}
