import type { AgentPersona } from "@/shared/api/types";

function getAvailablePersonaIds(personas: AgentPersona[]): Set<string> {
  return new Set(personas.map((persona) => persona.id));
}

export function copySelectedPersonaIds(personaIds: string[]): string[] {
  return [...personaIds];
}

/**
 * Whether the team dialog's submit button should be enabled.
 *
 * A team name is required; an **empty roster is deliberately allowed**. Emptying
 * a team is the only way out of the delete deadlock — `delete_team` refuses
 * while agents still reference the team, and agent deletion refuses because the
 * agent belongs to a team. "Remove every member, then delete the team" is the
 * escape hatch, so the editor must be able to save a zero-member team. The Rust
 * side already supports it (`update_team` has no minimum-member check and
 * `apply_team_membership_delta` detaches the removed members' instances); the
 * min-1 rule that remains applies to snapshot *import* only.
 *
 * Extracted as a pure function so the "empty roster is submittable" contract is
 * covered by a test rather than living in a JSX `disabled` expression.
 */
export function canSubmitTeamDialog({
  name,
  isPending,
}: {
  name: string;
  isPending: boolean;
}): boolean {
  return name.trim().length > 0 && !isPending;
}

export function countMissingPersonaIds(
  personaIds: string[],
  personas: AgentPersona[],
): number {
  const availablePersonaIds = getAvailablePersonaIds(personas);
  return personaIds.filter((personaId) => !availablePersonaIds.has(personaId))
    .length;
}

export function filterAvailablePersonaIds(
  personaIds: string[],
  personas: AgentPersona[],
): string[] {
  const availablePersonaIds = getAvailablePersonaIds(personas);
  return personaIds.filter((personaId) => availablePersonaIds.has(personaId));
}

export function orderPersonasByInitiallySelected(
  personas: AgentPersona[],
  initialSelectedPersonaIds: string[],
): AgentPersona[] {
  const selectedIds = new Set(initialSelectedPersonaIds);
  const selected: AgentPersona[] = [];
  const unselected: AgentPersona[] = [];

  for (const persona of personas) {
    if (selectedIds.has(persona.id)) {
      selected.push(persona);
    } else {
      unselected.push(persona);
    }
  }

  return [...selected, ...unselected];
}
