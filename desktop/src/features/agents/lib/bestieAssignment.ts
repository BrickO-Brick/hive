/**
 * Stored Bestie role assignment.
 *
 * The role is a *class* an agent occupies, not the agent's name: once assigned,
 * every surface refers to the agent by its own name. Assignment is stored by
 * pubkey so an agent can be renamed without losing the role, and scoped by
 * relay so a role never leaks across communities.
 *
 * Prototype persistence: local storage. This is the seam that becomes a signed,
 * inspectable role record once the platform decision lands.
 */

import {
  DEFAULT_BESTIE_CAPABILITIES,
  type BestieCapabilityState,
} from "./bestieCapabilities";

const STORAGE_KEY = "buzz.bestie.assignment.v1";

export type BestieAssignment = {
  agentPubkey: string;
  /** Canonical relay this assignment belongs to. */
  relayUrl: string;
  capabilities: BestieCapabilityState;
  additionalInstructions: string;
  assignedAt: string;
};

type AssignmentStore = Record<string, BestieAssignment>;

function readStore(): AssignmentStore {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AssignmentStore) : {};
  } catch {
    return {};
  }
}

function writeStore(store: AssignmentStore) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export function readBestieAssignment(
  relayUrl: string | null,
): BestieAssignment | null {
  if (!relayUrl) return null;
  const stored = readStore()[relayUrl];
  if (!stored) return null;
  return {
    ...stored,
    capabilities: {
      ...DEFAULT_BESTIE_CAPABILITIES,
      ...stored.capabilities,
    },
  };
}

export function writeBestieAssignment(assignment: BestieAssignment) {
  const store = readStore();
  store[assignment.relayUrl] = assignment;
  writeStore(store);
}

export function clearBestieAssignment(relayUrl: string) {
  const store = readStore();
  delete store[relayUrl];
  writeStore(store);
}
