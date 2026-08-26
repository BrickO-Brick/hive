import type { ManagedAgent } from "@/shared/api/types";

export const BESTIE_PERSONA_ID = "builtin:bestie";

const BESTIE_FALLBACK_NAMES = new Set(["bestie", "chief of staff"]);

function normalizeRelayUrl(relayUrl: string | null | undefined) {
  return relayUrl?.trim().replace(/\/+$/, "").toLowerCase() ?? null;
}

function preferredByLifecycle(agents: readonly ManagedAgent[]) {
  return (
    agents.find((agent) => agent.status === "running") ??
    agents.find((agent) => agent.status === "deployed") ??
    agents[0] ??
    null
  );
}

/**
 * Resolves the one agent that owns the Bestie product surfaces.
 *
 * The built-in persona is authoritative. The name fallback lets an existing
 * user opt into the prototype with the Chief of Staff they already deployed,
 * without mutating or duplicating that agent.
 */
export function pickBestieAgent(
  agents: readonly ManagedAgent[],
  relayUrl?: string | null,
) {
  const normalizedRelayUrl = normalizeRelayUrl(relayUrl);
  const scoped = agents.filter(
    (agent) =>
      !normalizedRelayUrl ||
      normalizeRelayUrl(agent.relayUrl) === normalizedRelayUrl,
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
