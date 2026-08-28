import type { ManagedAgent, RuntimeConfigSurface } from "@/shared/api/types";
import { PERSONA_LABEL_OPTIONAL_CLASS } from "./agentConfigOptions";
import {
  effortPickerState,
  effortSelectionToPersistedValue,
} from "./effortPicker";
import { PersonaDropdownField } from "./PersonaDropdownField";

/**
 * Thinking-effort write control for the edit dialog.
 *
 * Local-only by construction: the persisted value flows into
 * `persistAgentEffortLevel`, which the Rust command rejects for non-local
 * backends (remote effort is set at deploy time via `policy_env`). So the
 * control renders only for a local backend AND once the adapter has advertised
 * a `thought_level` configId (discovered from the running session — absent
 * pre-first-session and for runtimes/models without effort support). The
 * read-only configured-vs-running two-facts display lives in `AgentConfigPanel`;
 * this is the write control.
 *
 * Save-gated, not direct-write: the control is fully controlled by the parent
 * dialog (`value`/`onChange`) and owns no mutation. The dialog persists the
 * selection through a standalone setter on Save alone (mirroring
 * `setManagedAgentAutoRestart`), so the write can never race the dialog's own
 * locked `update_managed_agent` save or survive a Cancel/failed Save.
 */
export function EffortPickerField({
  agent,
  config,
  disabled,
  value,
  onChange,
}: {
  agent: ManagedAgent;
  config: RuntimeConfigSurface | undefined;
  disabled: boolean;
  /** The pending persisted effort form (`null` = adapter default). */
  value: string | null;
  onChange: (level: string | null) => void;
}) {
  const { visible, options, selectValue } = effortPickerState({
    backend: agent.backend,
    effortConfigId: config?.effortConfigId,
    effortOptions: config?.effortOptions,
    currentEffort: value,
  });

  if (!visible) {
    return null;
  }

  return (
    <div className="space-y-1.5">
      <label
        className="text-sm font-medium text-foreground"
        htmlFor="edit-agent-effort"
      >
        Thinking effort
        <span className={PERSONA_LABEL_OPTIONAL_CLASS}>Optional</span>
      </label>
      <PersonaDropdownField
        disabled={disabled}
        id="edit-agent-effort"
        onValueChange={(next) =>
          onChange(effortSelectionToPersistedValue(next))
        }
        options={options}
        placeholder="Adapter default"
        value={selectValue}
      />
      <p className="text-xs text-muted-foreground">
        Applied at the next session start.
      </p>
    </div>
  );
}
