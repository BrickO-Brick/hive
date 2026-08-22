import type { ToolRunGroupViewState } from "./agentSessionToolRunViewState";

/**
 * Per-group presentation state, keyed by a group's stable identity.
 *
 * This lives outside React because a group's React identity is not stable
 * across regrouping: a same-kind run that later absorbs a differing tool call
 * becomes a mixed burst with a different summary id, which remounts the card.
 * Without this store, a reader's deliberate choice to open a group would be
 * silently reverted by the agent emitting one more tool call.
 *
 * Community-scoped like every other transcript cache — see
 * `resetCommunityState()` in `features/communities/useCommunityInit.ts`.
 */
const groupViewStates = new Map<string, ToolRunGroupViewState>();

export function readToolRunGroupViewState(
  groupKey: string,
): ToolRunGroupViewState | undefined {
  return groupViewStates.get(groupKey);
}

export function writeToolRunGroupViewState(
  groupKey: string,
  state: ToolRunGroupViewState,
): void {
  groupViewStates.set(groupKey, state);
}

/** Clear all remembered group state (community switch / test isolation). */
export function resetAgentSessionToolRunViewState(): void {
  groupViewStates.clear();
}
