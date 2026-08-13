import {
  ArrowRight,
  CalendarClock,
  CircleCheckBig,
  Clock3,
  Copy,
  GitPullRequest,
  Hash,
  MessageCircle,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Play,
  Send,
  SmilePlus,
  Timer,
  Trash2,
  Webhook,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { Workflow } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import {
  getWorkflowCardLabel,
  getWorkflowDescription,
  getWorkflowDisplayStatus,
  getWorkflowPrimaryAction,
  getWorkflowTriggerSummary,
  getWorkflowTriggerType,
} from "./workflowDefinition";

type WorkflowCardProps = {
  workflow: Workflow;
  channelName?: string;
  isActive?: boolean;
  onTrigger: (workflowId: string) => void;
  onEdit: (workflow: Workflow) => void;
  onDuplicate: (workflow: Workflow) => void;
  onDelete: (workflow: Workflow) => void;
};

const TRIGGER_ICONS: Record<string, LucideIcon> = {
  diff_posted: GitPullRequest,
  message_posted: MessageSquare,
  reaction_added: SmilePlus,
  schedule: CalendarClock,
  webhook: Webhook,
};

const ACTION_ICONS: Record<string, LucideIcon> = {
  add_reaction: SmilePlus,
  call_webhook: Webhook,
  delay: Timer,
  request_approval: CircleCheckBig,
  send_dm: MessageCircle,
  send_message: Send,
  set_channel_topic: Hash,
};

const TRIGGER_THEMES: Record<string, string> = {
  diff_posted: "border-violet-400/30 bg-violet-600 text-white",
  message_posted: "border-blue-400/30 bg-blue-600 text-white",
  reaction_added: "border-pink-400/30 bg-pink-600 text-white",
  schedule: "border-emerald-400/30 bg-emerald-600 text-white",
  webhook: "border-orange-300/30 bg-orange-500 text-white",
};

function StatusBadge({ status }: { status: Workflow["status"] }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-1 text-2xs font-semibold uppercase tracking-wider",
        status === "active"
          ? "bg-white/20 text-white"
          : "bg-black/20 text-white/80",
      )}
    >
      {status}
    </span>
  );
}

export function WorkflowCard({
  workflow,
  channelName,
  isActive = false,
  onTrigger,
  onEdit,
  onDuplicate,
  onDelete,
}: WorkflowCardProps) {
  const displayStatus = getWorkflowDisplayStatus(workflow);
  const description = getWorkflowDescription(workflow.definition);
  const triggerSummary = getWorkflowTriggerSummary(workflow.definition);
  const triggerType = getWorkflowTriggerType(workflow.definition);
  const actionType = getWorkflowPrimaryAction(workflow.definition);
  const cardLabel = getWorkflowCardLabel(workflow.definition);
  const TriggerIcon = triggerType ? TRIGGER_ICONS[triggerType] : undefined;
  const ActionIcon = actionType ? ACTION_ICONS[actionType] : undefined;
  const theme = triggerType ? TRIGGER_THEMES[triggerType] : undefined;

  return (
    <div
      className={cn(
        "group relative min-h-60 w-full overflow-hidden rounded-2xl border p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lg",
        theme ?? "border-slate-500/30 bg-slate-700 text-white",
        isActive &&
          "ring-2 ring-primary ring-offset-2 ring-offset-background shadow-lg",
      )}
      data-testid={`workflow-card-${workflow.id}`}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/10 via-transparent to-black/15"
      />
      <button
        className="absolute inset-0 z-0 rounded-2xl focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white"
        onClick={() => onEdit(workflow)}
        type="button"
      >
        <span className="sr-only">Edit {workflow.name}</span>
      </button>

      <div className="pointer-events-none relative z-10 flex h-full min-h-48 flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2" aria-hidden="true">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/15 shadow-xs ring-1 ring-white/15">
              {TriggerIcon ? (
                <TriggerIcon className="h-5 w-5" />
              ) : (
                <Zap className="h-5 w-5" />
              )}
            </span>
            {ActionIcon ? (
              <>
                <ArrowRight className="h-4 w-4 text-white/60" />
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/15 shadow-xs ring-1 ring-white/15">
                  <ActionIcon className="h-5 w-5" />
                </span>
              </>
            ) : null}
          </div>

          <div className="pointer-events-auto flex items-center gap-1.5">
            <StatusBadge status={displayStatus} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label="Workflow actions"
                  className="h-8 w-8 text-white hover:bg-white/15 hover:text-white data-[state=open]:bg-white/15"
                  size="icon"
                  variant="ghost"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onTrigger(workflow.id)}>
                  <Play className="mr-2 h-4 w-4" />
                  Trigger
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onEdit(workflow)}>
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onDuplicate(workflow)}>
                  <Copy className="mr-2 h-4 w-4" />
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => onDelete(workflow)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {triggerSummary ? (
          <p className="mt-4 line-clamp-1 text-xs font-semibold text-white/70">
            {triggerSummary}
          </p>
        ) : null}
        <h3 className="mt-1 line-clamp-4 text-xl font-bold leading-tight tracking-tight">
          {cardLabel}
        </h3>
        {description ? (
          <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-white/75">
            {description}
          </p>
        ) : null}

        <div className="mt-auto flex min-w-0 items-end justify-between gap-3 pt-5 text-white/75">
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-white">
              {workflow.name}
            </p>
            {channelName ? (
              <p className="mt-0.5 truncate text-2xs">#{channelName}</p>
            ) : null}
          </div>
          <span className="flex shrink-0 items-center gap-1 text-2xs">
            <Clock3 className="h-3.5 w-3.5" />
            {new Date(workflow.updatedAt * 1000).toLocaleDateString()}
          </span>
        </div>
      </div>
    </div>
  );
}
