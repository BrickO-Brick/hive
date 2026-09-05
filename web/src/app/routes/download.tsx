import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/download")({
  component: lazyRouteComponent(
    () => import("@/features/download/ui/DownloadPage"),
    "DownloadPage",
  ),
});
