import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

const NotesScreen = React.lazy(async () => {
  const module = await import("@/features/notes/ui/NotesScreen");
  return { default: module.NotesScreen };
});

export const Route = createFileRoute("/notes/$author/$slug")({
  component: NoteDetailRouteComponent,
});

function NoteDetailRouteComponent() {
  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="notes" />}>
      <NotesScreen />
    </React.Suspense>
  );
}
