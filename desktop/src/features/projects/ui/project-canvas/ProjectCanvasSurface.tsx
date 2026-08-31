import { Maximize2 } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ProjectCanvasHost } from "./ProjectCanvasHost";
import type { ProjectCanvasSnapshots } from "./projectCanvasProtocol";

export function ProjectCanvasSurface({
  communityId,
  full,
  onShowFullCanvas,
  projectId,
  projectName,
  projectNames,
  snapshots,
}: {
  communityId: string | null;
  full: boolean;
  onShowFullCanvas: () => void;
  projectId: string;
  projectName: string;
  projectNames: readonly string[];
  snapshots: ProjectCanvasSnapshots;
}) {
  return (
    // The canvas deliberately rejects native file drops before they reach the
    // surrounding message-composer drop target.
    // biome-ignore lint/a11y/noStaticElementInteractions: drag handlers only define an event boundary; they do not expose an interaction.
    <div
      className={cn(
        "relative flex min-h-0 flex-col overflow-hidden bg-background",
        full
          ? "flex-1"
          : "h-[25.2rem] shrink-0 border-b border-border md:h-[28.8rem]",
      )}
      data-canvas-mode={full ? "full" : "preview"}
      data-testid="project-canvas-surface"
      onDragEnter={(event) => event.stopPropagation()}
      onDragLeave={(event) => event.stopPropagation()}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="min-h-0 flex-1">
        <ProjectCanvasHost
          communityId={communityId}
          full={full}
          projectId={projectId}
          projectName={projectName}
          projectNames={projectNames}
          snapshots={snapshots}
        />
      </div>
      {full ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-[25.2rem] z-30 flex items-center gap-3 px-3 md:top-[28.8rem]"
          data-testid="project-canvas-preview-boundary"
        >
          <div className="h-px flex-1 border-t border-dotted border-primary/65" />
          <span className="rounded-sm bg-background/90 px-2 py-0.5 text-3xs font-medium text-muted-foreground shadow-sm backdrop-blur-sm">
            Chat preview boundary
          </span>
          <div className="h-px flex-1 border-t border-dotted border-primary/65" />
        </div>
      ) : null}
      {!full ? (
        <div className="absolute inset-x-0 bottom-3 z-30 flex justify-center px-4">
          <Button
            className="border-border/80 bg-background/95 shadow-sm backdrop-blur-sm"
            data-testid="project-canvas-show-full"
            onClick={onShowFullCanvas}
            size="sm"
            type="button"
            variant="outline"
          >
            <Maximize2 className="h-4 w-4" />
            Show full canvas
          </Button>
        </div>
      ) : null}
    </div>
  );
}
