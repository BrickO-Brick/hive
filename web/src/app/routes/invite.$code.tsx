import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

const InvitePage = lazyRouteComponent(
  () => import("@/features/invite/ui/InvitePage"),
  "InvitePage",
);

export const Route = createFileRoute("/invite/$code")({
  component: InvitePageRoute,
});

function InvitePageRoute() {
  const { code } = Route.useParams();
  return <InvitePage code={code} />;
}
