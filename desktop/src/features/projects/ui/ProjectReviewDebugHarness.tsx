import { Bug } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";

export type ReviewCheckAgent = {
  pubkey: string;
  name: string;
  isManaged: boolean;
  isActive: boolean;
};

function agentAvailabilityLabel(agent: ReviewCheckAgent) {
  return agent.isManaged ? "Running here" : "Online on relay";
}

export function ProjectReviewDebugHarness({
  candidates,
  hasError,
  isLoading,
  onSelect,
  selected,
}: {
  candidates: ReviewCheckAgent[];
  hasError: boolean;
  isLoading: boolean;
  onSelect: (pubkey: string) => void;
  selected: ReviewCheckAgent | null;
}) {
  const activeCandidates = candidates.filter((candidate) => candidate.isActive);
  const offlineAgentCount = candidates.length - activeCandidates.length;

  return (
    <div className="fixed bottom-5 right-5 z-40">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            aria-label={`Review check debug harness${selected ? `, agent ${selected.name}` : ""}`}
            className="h-12 w-12 rounded-full p-0 shadow-lg ring-1 ring-border/60"
            data-testid="project-review-debug-harness-trigger"
            title="Review check debug harness"
            type="button"
          >
            <Bug className="h-5 w-5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-72 space-y-3"
          data-testid="project-review-debug-harness-menu"
          side="top"
          sideOffset={10}
        >
          <div className="space-y-0.5">
            <p className="text-sm font-semibold">Review debug harness</p>
            <p className="text-xs text-muted-foreground">
              Choose the agent used for new checks.
            </p>
          </div>
          <label className="block space-y-1.5 text-xs font-medium">
            <span>Agent</span>
            <select
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm font-normal outline-hidden focus:ring-1 focus:ring-ring disabled:opacity-50"
              data-testid="project-review-debug-agent-select"
              disabled={activeCandidates.length === 0}
              onChange={(event) => onSelect(event.target.value)}
              value={selected?.pubkey ?? ""}
            >
              {activeCandidates.length === 0 ? (
                <option value="">
                  {isLoading
                    ? "Loading available agents…"
                    : hasError
                      ? "Agents could not be loaded"
                      : "No running agents are available"}
                </option>
              ) : null}
              {activeCandidates.map((candidate) => (
                <option key={candidate.pubkey} value={candidate.pubkey}>
                  {candidate.name} · {agentAvailabilityLabel(candidate)}
                </option>
              ))}
            </select>
            {offlineAgentCount > 0 ? (
              <span
                className="block font-normal text-muted-foreground"
                data-testid="project-review-debug-offline-agent-count"
              >
                {offlineAgentCount} offline{" "}
                {offlineAgentCount === 1 ? "agent" : "agents"}
              </span>
            ) : null}
          </label>
        </PopoverContent>
      </Popover>
    </div>
  );
}
