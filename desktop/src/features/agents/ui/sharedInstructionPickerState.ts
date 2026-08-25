import type { SharedInstructionCover } from "@/shared/api/tauriPersonas";

export function toggleSharedInstructionCoordinate(
  selected: readonly string[],
  skill: SharedInstructionCover,
): string[] {
  if (!skill.compatible) return [...selected];

  return selected.includes(skill.coordinate)
    ? selected.filter((coordinate) => coordinate !== skill.coordinate)
    : [...selected, skill.coordinate];
}
