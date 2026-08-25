import * as React from "react";
import { toast } from "sonner";

import {
  setAgentManagedProfiles,
  setSharedInstructionsEnabled,
} from "@/shared/api/tauri";
import {
  listManagedAgentRuntimes,
  restartManagedAgentRuntime,
} from "@/shared/api/tauriManagedAgents";
import { desktopFeatures, useFeatureToggle } from "@/shared/features";
import type { FeatureDefinition } from "@/shared/features";
import { Button } from "@/shared/ui/button";
import { Switch } from "@/shared/ui/switch";
import { SettingsOptionGroup, SettingsOptionRow } from "./SettingsOptionGroup";
import { SettingsSectionHeader } from "./SettingsSectionHeader";

function FeatureRow({ feature }: { feature: FeatureDefinition }) {
  const [enabled, toggle] = useFeatureToggle(feature.id);
  const [restartPending, setRestartPending] = React.useState(false);
  const [restarting, setRestarting] = React.useState(false);
  const switchId = `feature-toggle-${feature.id}`;

  async function restartRunningAgents() {
    setRestarting(true);
    try {
      const running = (await listManagedAgentRuntimes()).filter(
        (runtime) => runtime.pid !== null && runtime.lifecycle !== "failed",
      );
      const results = await Promise.allSettled(
        running.map((runtime) =>
          restartManagedAgentRuntime(runtime.pubkey, runtime.relayUrl),
        ),
      );
      const failed = results.filter((result) => result.status === "rejected");
      if (failed.length > 0) {
        toast.error(
          `${failed.length} running agent${failed.length === 1 ? "" : "s"} couldn't restart. Try again from the Agents page.`,
        );
        return;
      }
      setRestartPending(false);
      toast.success(
        running.length === 0
          ? "No agents are currently running."
          : `Restarted ${running.length} running agent${running.length === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Running agents couldn't be restarted.",
      );
    } finally {
      setRestarting(false);
    }
  }

  return (
    <SettingsOptionRow>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium" id={`${switchId}-label`}>
          {feature.name}
        </p>
        <p className="text-xs text-muted-foreground/70" data-settings-subcopy>
          {feature.description}
        </p>
        {feature.id === "sharedInstructions" && restartPending ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className="text-xs text-muted-foreground">
              Running agents keep their current context until restarted.
            </p>
            <Button
              data-testid="restart-shared-instructions-agents"
              disabled={restarting}
              onClick={() => void restartRunningAgents()}
              size="sm"
              variant="outline"
            >
              {restarting ? "Restarting…" : "Restart running agents"}
            </Button>
          </div>
        ) : null}
      </div>
      <Switch
        aria-labelledby={`${switchId}-label`}
        checked={enabled}
        data-testid={switchId}
        onCheckedChange={(value) => {
          toggle(value);
          if (feature.id === "agentManagedProfiles") {
            void setAgentManagedProfiles(value).catch((error) => {
              console.error(
                "Failed to apply agent-managed profiles setting:",
                error,
              );
            });
          }
          if (feature.id === "sharedInstructions") {
            void setSharedInstructionsEnabled(value)
              .then(() => setRestartPending(true))
              .catch((error) => {
                console.error(
                  "Failed to apply shared instructions setting:",
                  error,
                );
                toggle(!value);
                setRestartPending(false);
                toast.error("Shared instructions couldn't be updated.");
              });
          }
        }}
      />
    </SettingsOptionRow>
  );
}

export function ExperimentalFeaturesCard() {
  // Manifest is preview-only by definition; every desktop entry is a preview
  // feature.
  const previewFeatures = desktopFeatures;

  return (
    <section className="min-w-0" data-testid="settings-experimental">
      <SettingsSectionHeader
        title="Experiments"
        description={
          <>
            These features are functional but still being refined. Enable them
            to try new capabilities early.
          </>
        }
      />

      <SettingsOptionGroup title="Features">
        {previewFeatures.map((f) => (
          <FeatureRow feature={f} key={f.id} />
        ))}
      </SettingsOptionGroup>
    </section>
  );
}
