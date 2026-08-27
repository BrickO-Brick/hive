import { Bot, Trash2 } from "lucide-react";

import type { ManagedAgent } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import { ChooserDialogContent } from "@/shared/ui/chooser-dialog-content";
import { Dialog } from "@/shared/ui/dialog";

type BestieRemoveDialogProps = {
  agent: ManagedAgent;
  isPending: boolean;
  onKeepAgent: () => void;
  onDeleteAgent: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

/**
 * Two distinct outcomes, presented as a choice rather than one destructive
 * confirm: dropping the role is reversible and keeps the agent, while deleting
 * removes the agent entirely. Collapsing these into a single "Remove" would
 * either delete an agent someone wanted to keep or leave an unwanted agent
 * behind with no way to finish the job.
 */
export function BestieRemoveDialog({
  agent,
  isPending,
  onDeleteAgent,
  onKeepAgent,
  onOpenChange,
  open,
}: BestieRemoveDialogProps) {
  const canDelete = agent.backend.type === "local";

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <ChooserDialogContent
        className="max-w-lg"
        data-testid="bestie-remove-dialog"
        headerSubtitle={`Choose what happens to ${agent.name}.`}
        title="Remove your bestie"
      >
        <div className="space-y-3">
          <button
            className="flex w-full items-start gap-3 rounded-xl border border-input bg-muted/40 p-4 text-left transition-colors hover:border-muted-foreground/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            disabled={isPending}
            onClick={onKeepAgent}
            type="button"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Bot className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">
                Keep {agent.name} as a regular agent
              </span>
              <span className="mt-1 block text-sm leading-5 text-muted-foreground">
                It returns to your agents with its name, instructions, and
                conversations. You can make it your bestie again later.
              </span>
            </span>
          </button>

          {canDelete ? (
            <button
              className="flex w-full items-start gap-3 rounded-xl border border-input bg-muted/40 p-4 text-left transition-colors hover:border-destructive/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              disabled={isPending}
              onClick={onDeleteAgent}
              type="button"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
                <Trash2 className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">
                  Delete {agent.name}
                </span>
                <span className="mt-1 block text-sm leading-5 text-muted-foreground">
                  Stops the agent and removes it from Buzz. Its conversations
                  stay, but the agent can’t be recovered.
                </span>
              </span>
            </button>
          ) : (
            <p className="px-1 text-sm leading-5 text-muted-foreground">
              {agent.name} runs outside this app, so it can only be deleted
              wherever it’s hosted.
            </p>
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <Button
            disabled={isPending}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
        </div>
      </ChooserDialogContent>
    </Dialog>
  );
}
