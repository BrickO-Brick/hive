import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

const NotesScreen = React.lazy(async () => {
  const module = await import("@/features/notes/ui/NotesScreen");
  return { default: module.NotesScreen };
});

export const Route = createFileRoute("/notes")({
  component: NotesRouteComponent,
});

function NotesRouteComponent() {
  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="notes" />}>
      <NotesScreen />
    </React.Suspense>
  );
}
