import { createRootRoute } from "@tanstack/react-router";

import { AppShell } from "@/app/AppShell";
import { HuddlePresenceProvider } from "@/features/huddle/HuddlePresenceContext";

function RootRoute() {
  return (
    <HuddlePresenceProvider>
      <AppShell />
    </HuddlePresenceProvider>
  );
}

export const Route = createRootRoute({
  component: RootRoute,
});
