import type { AcpCommandCandidate } from "@/shared/api/acpCommands";
import type { PersonaDropdownOption } from "./agentConfigOptions";

export const CUSTOM_ACP_COMMAND_VALUE = "__custom_acp_command__";
export const DEFAULT_ACP_COMMAND_VALUE = "buzz-acp";

export function acpCommandPickerState(
  command: string,
  candidates: readonly AcpCommandCandidate[],
): {
  isPreset: boolean;
  options: PersonaDropdownOption[];
  selectValue: string;
} {
  const isPreset =
    command === DEFAULT_ACP_COMMAND_VALUE ||
    candidates.some((candidate) => candidate.command === command);
  return {
    isPreset,
    options: [
      { label: "Buzz ACP (default)", value: DEFAULT_ACP_COMMAND_VALUE },
      ...candidates.map((candidate) => ({
        label: candidate.command,
        value: candidate.command,
      })),
      { label: "Custom command", value: CUSTOM_ACP_COMMAND_VALUE },
    ],
    selectValue: isPreset ? command : CUSTOM_ACP_COMMAND_VALUE,
  };
}

export function acpCommandSelectionToValue({
  currentCommand,
  isPreset,
  selection,
}: {
  currentCommand: string;
  isPreset: boolean;
  selection: string;
}): string {
  if (selection !== CUSTOM_ACP_COMMAND_VALUE) return selection;
  return isPreset ? "" : currentCommand;
}
