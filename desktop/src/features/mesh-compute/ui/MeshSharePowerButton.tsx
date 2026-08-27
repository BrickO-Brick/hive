import * as React from "react";
import { Power } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import {
  meshStartNode,
  meshStopNode,
  openMeshBuddyWindow,
} from "@/shared/api/tauriMesh";
import { Button } from "@/shared/ui/button";
import { classifyModelRef } from "../classifyModelRef";
import { useMeshNodeStatus } from "../hooks/useMeshNodeStatus";
import {
  MESH_SHARE_MAX_VRAM_STORAGE_KEY,
  MESH_SHARE_MODEL_STORAGE_KEY,
  readMeshShareDraft,
} from "../sharePreferences";
import { deriveMeshShareToggle } from "../shareToggleState";

const POWER_BUTTON_CLASS =
  "h-[28px] w-[28px] shrink-0 rounded-[4px] text-sidebar-foreground/55 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";

function readSavedStartRequest(): {
  modelId: string;
  maxVramGb?: number;
} | null {
  const modelId = readMeshShareDraft(MESH_SHARE_MODEL_STORAGE_KEY).trim();
  if (classifyModelRef(modelId).kind === "unknown") return null;

  const rawMaxVram = readMeshShareDraft(MESH_SHARE_MAX_VRAM_STORAGE_KEY).trim();
  if (rawMaxVram === "") return { modelId };
  const maxVramGb = Number.parseFloat(rawMaxVram);
  return Number.isNaN(maxVramGb) ? { modelId } : { modelId, maxVramGb };
}

export function MeshSharePowerButton() {
  const { status, error, refresh } = useMeshNodeStatus();
  const [actionInFlight, setActionInFlight] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const { isSharing, isConsuming, slotOccupied } =
    deriveMeshShareToggle(status);
  const state = status?.state;
  const isFailed = state === "failed" || actionError !== null;
  const isTransitioning = state === "starting" || state === "stopping";
  const unknownOccupant = slotOccupied && !isSharing && !isConsuming;
  const unavailable = error?.includes("mesh-llm feature not enabled");

  if (unavailable || status === null) return null;

  const label =
    state === "starting"
      ? "Starting shared compute"
      : state === "stopping"
        ? "Stopping shared compute"
        : isSharing
          ? isFailed
            ? "Reset shared compute"
            : "Stop sharing compute"
          : "Start sharing compute";
  const disabled = actionInFlight || isTransitioning || unknownOccupant;
  const title =
    actionError ??
    error ??
    (unknownOccupant ? "Another mesh operation is using this machine" : label);

  async function handleClick() {
    if (disabled) return;
    setActionError(null);
    setActionInFlight(true);
    try {
      if (isSharing) {
        await meshStopNode();
      } else {
        const request = readSavedStartRequest();
        if (!request) {
          throw new Error("Choose a sharing model in Settings first");
        }
        await openMeshBuddyWindow();
        await meshStartNode({ mode: "serve", ...request });
      }
      refresh();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionInFlight(false);
    }
  }

  return (
    <Button
      aria-label={label}
      aria-pressed={isSharing}
      className={cn(
        POWER_BUTTON_CLASS,
        isSharing && !isFailed && "text-emerald-500 hover:text-emerald-400",
        isFailed && "text-destructive hover:text-destructive",
        (actionInFlight || isTransitioning) &&
          "animate-pulse text-amber-500 hover:text-amber-400",
      )}
      data-testid="mesh-share-power"
      disabled={disabled}
      onClick={handleClick}
      size="icon"
      title={title}
      type="button"
      variant="ghost"
    >
      <Power />
    </Button>
  );
}
