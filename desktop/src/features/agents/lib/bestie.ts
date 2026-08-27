import type { ManagedAgent } from "@/shared/api/types";
import { canonicalRelayUrl } from "../managedAgentRuntimeStatus.ts";

export const BESTIE_PERSONA_ID = "builtin:bestie";

/**
 * Hides the seeded Bestie persona from the general agent library and catalog.
 *
 * The role is set up through the Bestie section, which composes its own prompt
 * from the capability controls. Leaving the raw persona in the catalog would let
 * someone create a second agent literally named "Bestie" outside that flow —
 * the duplicate-default-agent problem the role model exists to avoid.
 */
export function withoutBestiePersona<T extends { id: string }>(
  personas: readonly T[],
): T[] {
  return personas.filter((persona) => persona.id !== BESTIE_PERSONA_ID);
}

const BESTIE_FALLBACK_NAMES = new Set(["bestie", "chief of staff"]);

function preferredByLifecycle(agents: readonly ManagedAgent[]) {
  return (
    agents.find((agent) => agent.status === "running") ??
    agents.find((agent) => agent.status === "deployed") ??
    agents[0] ??
    null
  );
}

/** Resolves the agent that owns Bestie product surfaces. */
export function pickBestieAgent(
  agents: readonly ManagedAgent[],
  relayUrl?: string | null,
) {
  const normalizedRelayUrl = canonicalRelayUrl(relayUrl ?? "");
  if (normalizedRelayUrl === null) return null;
  const scoped = agents.filter(
    (agent) => canonicalRelayUrl(agent.relayUrl) === normalizedRelayUrl,
  );
  const builtIn = scoped.filter(
    (agent) => agent.personaId === BESTIE_PERSONA_ID,
  );
  if (builtIn.length > 0) return preferredByLifecycle(builtIn);

  return preferredByLifecycle(
    scoped.filter((agent) =>
      BESTIE_FALLBACK_NAMES.has(agent.name.trim().toLowerCase()),
    ),
  );
}
