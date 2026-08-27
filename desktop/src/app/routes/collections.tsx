import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { usePreviewFeatureWarning } from "@/shared/features";

const CollectionsScreen = React.lazy(async () => {
  const module = await import("@/features/collections/ui/CollectionsScreen");
  return { default: module.CollectionsScreen };
});

export const Route = createFileRoute("/collections")({
  component: CollectionsRouteComponent,
});

function CollectionsRouteComponent() {
  usePreviewFeatureWarning("collections");
  return (
    <React.Suspense fallback={<div className="p-6">Loading collections…</div>}>
      <CollectionsScreen />
    </React.Suspense>
  );
}
