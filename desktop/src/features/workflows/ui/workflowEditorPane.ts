export type WorkflowEditorPane =
  | { type: "trigger" }
  | { type: "step"; index: number }
  | null;

const STEP_PANE_PATTERN = /^step-(0|[1-9]\d*)$/;

export function parseWorkflowEditorPane(value: unknown): WorkflowEditorPane {
  if (value === "trigger") return { type: "trigger" };
  if (typeof value !== "string") return null;

  const match = STEP_PANE_PATTERN.exec(value);
  if (!match) return null;

  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? { type: "step", index } : null;
}

export function serializeWorkflowEditorPane(
  pane: WorkflowEditorPane,
): string | undefined {
  if (pane === null) return undefined;
  return pane.type === "trigger" ? "trigger" : `step-${pane.index}`;
}
