import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/repos/$repoId/blob/$")({
  component: lazyRouteComponent(
    () => import("@/features/repos/ui/RepoBlobViewer"),
    "RepoBlobPage",
  ),
});
