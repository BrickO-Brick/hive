import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/repos/$repoId")({
  component: lazyRouteComponent(
    () => import("@/features/repos/ui/RepoDetailPage"),
    "RepoDetailPage",
  ),
});
