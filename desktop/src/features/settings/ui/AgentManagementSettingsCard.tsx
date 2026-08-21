import {
  setUnattendedAgentManagementEnabled,
  useUnattendedAgentManagement,
} from "@/features/agents/unattendedAgentManagementPreference";
import { Switch } from "@/shared/ui/switch";
import { SettingsOptionGroup, SettingsOptionRow } from "./SettingsOptionGroup";

export function AgentManagementSettingsCard() {
  const enabled = useUnattendedAgentManagement();

  return (
    <SettingsOptionGroup
      data-testid="agents-management-card"
      title="Agents managing agents"
    >
      <SettingsOptionRow>
        <div className="min-w-0">
          <label
            className="text-sm font-medium"
            htmlFor="unattended-agent-management-switch"
          >
            Let my agents manage agents without review
          </label>
          <p
            className="text-sm font-normal text-muted-foreground/70"
            data-settings-subcopy
          >
            When on, an agent you own can create, update, or delete your agents
            from a channel you both belong to, and Buzz applies the change
            immediately. When off, each request opens a review dialog and
            nothing changes until you save it.
          </p>
        </div>
        <Switch
          checked={enabled}
          data-testid="unattended-agent-management-toggle"
          id="unattended-agent-management-switch"
          onCheckedChange={setUnattendedAgentManagementEnabled}
        />
      </SettingsOptionRow>
    </SettingsOptionGroup>
  );
}
