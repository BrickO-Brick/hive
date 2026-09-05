import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/mantul-sso")({
  component: lazyRouteComponent(
    () => import("@/features/mantap-sso/ui/MantapSsoPage"),
    "MantapSsoPage",
  ),
});
