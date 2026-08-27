import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { usePreviewFeatureWarning } from "@/shared/features";

const CollectionDetailScreen = React.lazy(async () => {
  const module = await import(
    "@/features/collections/ui/CollectionDetailScreen"
  );
  return { default: module.CollectionDetailScreen };
});

export const Route = createFileRoute("/collections/$collectionId")({
  component: CollectionDetailRouteComponent,
});

function CollectionDetailRouteComponent() {
  usePreviewFeatureWarning("collections");
  const { collectionId } = Route.useParams();
  return (
    <React.Suspense fallback={<div className="p-6">Loading collection…</div>}>
      <CollectionDetailScreen collectionId={collectionId} />
    </React.Suspense>
  );
}
