import type {
  SharedInstructionCover,
  ResolvedSharedInstruction,
} from "@/shared/api/tauriPersonas";
import { useFeatureEnabled } from "@/shared/features/useFeatureEnabled";
import { cn } from "@/shared/lib/cn";
import { Textarea } from "@/shared/ui/textarea";
import {
  PERSONA_FIELD_CONTROL_CLASS,
  PERSONA_FIELD_SHELL_CLASS,
} from "./agentConfigOptions";
import { SharedInstructionPicker } from "./SharedInstructionPicker";

type AgentInstructionsFieldProps = {
  assignedSharedInstructions: string[];
  disabled: boolean;
  onAssignedSharedInstructionsChange: (coordinates: string[]) => void;
  onEditSharedInstruction: (detail: ResolvedSharedInstruction | null) => void;
  publishedSharedInstructions: readonly SharedInstructionCover[];
  onSystemPromptChange: (value: string) => void;
  systemPrompt: string;
};

const textarea = (
  disabled: boolean,
  systemPrompt: string,
  onSystemPromptChange: (value: string) => void,
  className: string,
) => (
  <Textarea
    className={cn(className, PERSONA_FIELD_CONTROL_CLASS)}
    disabled={disabled}
    id="persona-system-prompt"
    onChange={(event) => onSystemPromptChange(event.target.value)}
    placeholder="Describe what this agent should do."
    value={systemPrompt}
  />
);

export function AgentInstructionsField({
  assignedSharedInstructions,
  disabled,
  onAssignedSharedInstructionsChange,
  onEditSharedInstruction,
  publishedSharedInstructions,
  onSystemPromptChange,
  systemPrompt,
}: AgentInstructionsFieldProps) {
  const sharedInstructionsEnabled = useFeatureEnabled("sharedInstructions");
  return (
    <div className="space-y-1.5">
      {sharedInstructionsEnabled ? (
        <SharedInstructionPicker
          disabled={disabled}
          label="Agent instructions"
          labelFor="persona-system-prompt"
          onChange={onAssignedSharedInstructionsChange}
          onEdit={onEditSharedInstruction}
          publishedSkills={publishedSharedInstructions}
          selected={assignedSharedInstructions}
        >
          {textarea(
            disabled,
            systemPrompt,
            onSystemPromptChange,
            "h-full min-h-28 resize-none px-3 py-3 leading-5",
          )}
        </SharedInstructionPicker>
      ) : (
        <>
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="persona-system-prompt"
          >
            Agent instructions
          </label>
          <div className={PERSONA_FIELD_SHELL_CLASS}>
            {textarea(
              disabled,
              systemPrompt,
              onSystemPromptChange,
              "min-h-40 resize-y px-3 py-3 leading-5",
            )}
          </div>
        </>
      )}
    </div>
  );
}
