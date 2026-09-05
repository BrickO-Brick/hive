import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/app")({
  component: lazyRouteComponent(
    () => import("@/features/chat/ui/HiveChatPage"),
    "HiveChatPage",
  ),
});
