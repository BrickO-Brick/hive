import type { AgentPersona } from "@/shared/api/types";

function getAvailablePersonaIds(personas: AgentPersona[]): Set<string> {
  return new Set(personas.map((persona) => persona.id));
}

export function copySelectedPersonaIds(personaIds: string[]): string[] {
  return [...personaIds];
}

/**
 * Tells you if the submit button in the team dialog is enabled.
 *
 * The team must have a name. The team does not need a member. An empty roster
 * is correct.
 *
 * An empty roster is necessary. It is the only way to delete a team. The
 * `delete_team` command stops if an agent points to the team. The agent delete
 * command stops if the agent is in a team. Thus you must first remove all the
 * members from the team. Then you can delete the team.
 *
 * The Rust code permits a team that has no members. The `update_team` command
 * does not count the members. The `apply_team_membership_delta` function clears
 * the `team_id` field of each member that you remove. Only the import of a
 * snapshot needs one member or more.
 *
 * This is a separate function because a test can then read the rule. Before,
 * the rule was in a JSX `disabled` expression, where a test cannot read it.
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
