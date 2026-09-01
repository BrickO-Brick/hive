import { createFileRoute } from "@tanstack/react-router";
import { MantapSsoPage } from "@/features/mantap-sso/ui/MantapSsoPage";

export const Route = createFileRoute("/mantul-sso")({
  component: MantapSsoPage,
});
