import {
  ArrowRight,
  CalendarClock,
  CircleCheckBig,
  Copy,
  GitPullRequest,
  Hash,
  MessageCircle,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Play,
  Power,
  PowerOff,
  Send,
  SmilePlus,
  Timer,
  Trash2,
  Webhook,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { useCustomEmoji } from "@/features/custom-emoji/hooks";
import { reactionEmojiUrl } from "@/shared/api/customEmoji";
import type { Workflow } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { emojiDisplayName } from "@/shared/lib/emojiName";
import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import {
  getWorkflowCardLabel,
  getWorkflowDisplayStatus,
  getWorkflowEnabled,
  getWorkflowPrimaryAction,
  getWorkflowPrimaryActionEmoji,
  getWorkflowStepCount,
  getWorkflowTriggerConfig,
  getWorkflowTriggerSummary,
  getWorkflowTriggerType,
} from "./workflowDefinition";
import { TriggerDescriptionText } from "./WorkflowNodeDescriptions";
import { useWorkflowTriggerPresentation } from "./useWorkflowTriggerPresentation";

type WorkflowCardProps = {
  workflow: Workflow;
  channelName?: string;
  isTogglingEnabled?: boolean;
  onTrigger: (workflowId: string) => void;
  onToggleEnabled: (workflow: Workflow) => void;
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

const TRIGGER_ACCENTS: Record<string, string> = {
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
        "rounded-full border border-border/65 bg-background/80 px-2 py-1 text-2xs font-semibold uppercase tracking-wider shadow-xs",
        status === "active" ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {status}
    </span>
  );
}

function ActionTileStack({
  children,
  stackDepth,
}: {
  children: React.ReactNode;
  stackDepth: number;
}) {
  return (
    <span
      className={cn(
        "relative h-9",
        stackDepth === 0 && "w-9",
        stackDepth === 1 && "w-[2.625rem]",
        stackDepth > 1 && "w-12",
      )}
    >
      {stackDepth > 1 ? (
        <span
          aria-hidden="true"
          className="absolute top-1/2 left-3 h-9 w-9 -translate-y-1/2 scale-75 rounded-xl border border-border/60 bg-background/80 opacity-35"
        />
      ) : null}
      {stackDepth > 0 ? (
        <span
          aria-hidden="true"
          className="absolute top-1/2 left-1.5 h-9 w-9 -translate-y-1/2 scale-90 rounded-xl border border-border/65 bg-background/80 opacity-60"
        />
      ) : null}
      <span className="absolute inset-y-0 left-0 z-10 flex w-9 items-center justify-center rounded-xl border border-border/65 bg-background/80 text-muted-foreground shadow-xs">
        {children}
      </span>
    </span>
  );
}

function ReactionGlyph({
  className,
  emoji,
  testId,
  url,
}: {
  className: string;
  emoji: string;
  testId: string;
  url?: string;
}) {
  return url ? (
    <img
      alt={emoji}
      className={cn("inline-block object-contain", className)}
      data-testid={testId}
      draggable={false}
      src={rewriteRelayUrl(url)}
      title={emojiDisplayName(emoji)}
    />
  ) : (
    <span
      className={cn(
        "inline-flex items-center justify-center leading-none",
        emoji.startsWith(":") && "text-3xs",
        className,
      )}
      data-testid={testId}
      title={emojiDisplayName(emoji)}
    >
      {emoji}
    </span>
  );
}

function ReactionLabelText({
  reactions,
  text,
}: {
  reactions: ReadonlyArray<{ emoji: string; url?: string }>;
  text: string;
}) {
  const candidates = [...reactions].sort(
    (left, right) => right.emoji.length - left.emoji.length,
  );
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    let nextIndex = -1;
    let nextReaction: (typeof candidates)[number] | undefined;
    for (const reaction of candidates) {
      const matchIndex = text.indexOf(reaction.emoji, cursor);
      if (matchIndex >= 0 && (nextIndex < 0 || matchIndex < nextIndex)) {
        nextIndex = matchIndex;
        nextReaction = reaction;
      }
    }
    if (!nextReaction) break;

    if (nextIndex > cursor) parts.push(text.slice(cursor, nextIndex));
    parts.push(
      nextReaction.url ? (
        <ReactionGlyph
          className="h-5 w-5 align-text-bottom"
          emoji={nextReaction.emoji}
          key={`${nextReaction.emoji}-${nextIndex}`}
          testId="workflow-card-reaction-emoji"
          url={nextReaction.url}
        />
      ) : (
        nextReaction.emoji
      ),
    );
    cursor = nextIndex + nextReaction.emoji.length;
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length > 0 ? parts : text;
}

function TriggerCardText({
  authorLoading,
  messageLoading,
  reactions,
  text,
}: {
  authorLoading?: boolean;
  messageLoading?: boolean;
  reactions: ReadonlyArray<{ emoji: string; url?: string }>;
  text: string;
}) {
  return authorLoading || messageLoading ? (
    <TriggerDescriptionText
      authorLoading={authorLoading}
      messageLoading={messageLoading}
      text={text}
    />
  ) : (
    <ReactionLabelText reactions={reactions} text={text} />
  );
}

export function WorkflowCard({
  workflow,
  channelName,
  isTogglingEnabled = false,
  onTrigger,
  onToggleEnabled,
  onEdit,
  onDuplicate,
  onDelete,
}: WorkflowCardProps) {
  const customEmoji = useCustomEmoji();
  const isEnabled = getWorkflowEnabled(workflow.definition);
  const displayStatus = getWorkflowDisplayStatus(workflow);
  const configuredTrigger = getWorkflowTriggerConfig(workflow.definition);
  const trigger = configuredTrigger ?? { on: "message_posted" as const };
  const triggerPresentation = useWorkflowTriggerPresentation({
    trigger,
    workflowChannelId: workflow.channelId,
  });
  const triggerSummary =
    configuredTrigger &&
    ["diff_posted", "message_posted", "reaction_added"].includes(trigger.on)
      ? triggerPresentation.description
      : getWorkflowTriggerSummary(workflow.definition);
  const triggerType = getWorkflowTriggerType(workflow.definition);
  const actionType = getWorkflowPrimaryAction(workflow.definition);
  const actionReaction = getWorkflowPrimaryActionEmoji(workflow.definition);
  const cardLabel = getWorkflowCardLabel(workflow.definition, {
    triggerDescription:
      configuredTrigger &&
      triggerPresentation.description !==
        getWorkflowTriggerSummary({ trigger: { on: configuredTrigger.on } })
        ? triggerPresentation.description
        : undefined,
    triggerReaction: triggerPresentation.emoji,
  });
  const cardReactions = [
    ...new Set([triggerPresentation.emoji, actionReaction]),
  ]
    .filter((emoji): emoji is string => Boolean(emoji))
    .map((emoji) => ({
      emoji,
      url: reactionEmojiUrl(emoji, customEmoji),
    }));
  const TriggerIcon = triggerType ? TRIGGER_ICONS[triggerType] : undefined;
  const ActionIcon = actionType ? ACTION_ICONS[actionType] : undefined;
  const triggerReaction = cardReactions.find(
    ({ emoji }) => emoji === triggerPresentation.emoji,
  );
  const actionReactionPresentation = cardReactions.find(
    ({ emoji }) => emoji === actionReaction,
  );
  const stackDepth = Math.min(
    Math.max(getWorkflowStepCount(workflow.definition) - 1, 0),
    2,
  );
  const triggerAccent = triggerType ? TRIGGER_ACCENTS[triggerType] : undefined;

  return (
    <div
      className={cn(
        "group relative min-h-60 w-full overflow-hidden rounded-2xl border border-border/70 bg-muted/50 p-5 text-left text-foreground shadow-xs transition-colors hover:border-border hover:bg-muted/65",
      )}
      data-testid={`workflow-card-${workflow.id}`}
    >
      <button
        className="absolute inset-0 z-0 rounded-2xl focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => onEdit(workflow)}
        type="button"
      >
        <span className="sr-only">Edit {workflow.name}</span>
      </button>

      <div className="pointer-events-none relative z-10 flex h-full min-h-48 flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2" aria-hidden="true">
            <span
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-xl border shadow-xs",
                triggerAccent ?? "border-slate-400/30 bg-slate-600 text-white",
              )}
            >
              {triggerReaction ? (
                <ReactionGlyph
                  className="h-6 w-6 text-2xl"
                  emoji={triggerReaction.emoji}
                  testId="workflow-card-trigger-reaction"
                  url={triggerReaction.url}
                />
              ) : TriggerIcon ? (
                <TriggerIcon className="h-5 w-5" />
              ) : (
                <Zap className="h-5 w-5" />
              )}
            </span>
            {ActionIcon ? (
              <>
                <ArrowRight className="h-4 w-4 text-muted-foreground/60" />
                <ActionTileStack stackDepth={stackDepth}>
                  {actionReactionPresentation ? (
                    <ReactionGlyph
                      className="h-6 w-6 text-2xl"
                      emoji={actionReactionPresentation.emoji}
                      testId="workflow-card-action-reaction"
                      url={actionReactionPresentation.url}
                    />
                  ) : (
                    <ActionIcon className="h-5 w-5" />
                  )}
                </ActionTileStack>
              </>
            ) : null}
          </div>

          <div className="pointer-events-auto flex items-center gap-1.5">
            <StatusBadge status={displayStatus} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label="Workflow actions"
                  className="h-8 w-8 text-muted-foreground hover:bg-background/80 hover:text-foreground data-[state=open]:bg-background/80 data-[state=open]:text-foreground"
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
                  disabled={isTogglingEnabled}
                  onClick={() => onToggleEnabled(workflow)}
                >
                  {isEnabled ? (
                    <PowerOff className="mr-2 h-4 w-4" />
                  ) : (
                    <Power className="mr-2 h-4 w-4" />
                  )}
                  {isEnabled ? "Disable" : "Enable"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
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
          <p className="mt-4 line-clamp-1 text-xs font-semibold text-muted-foreground">
            <TriggerCardText
              authorLoading={triggerPresentation.authorLoading}
              messageLoading={triggerPresentation.messageLoading}
              reactions={cardReactions}
              text={triggerSummary}
            />
          </p>
        ) : null}
        <h3 className="mt-1 line-clamp-4 text-xl font-bold leading-tight tracking-tight">
          <TriggerCardText
            authorLoading={triggerPresentation.authorLoading}
            messageLoading={triggerPresentation.messageLoading}
            reactions={cardReactions}
            text={cardLabel}
          />
        </h3>
        <div className="mt-auto flex min-w-0 items-end justify-between gap-3 pt-5 text-secondary-foreground/75">
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-foreground">
              {workflow.name}
            </p>
            {channelName ? (
              <p className="mt-0.5 truncate text-2xs">#{channelName}</p>
            ) : null}
          </div>
          <span className="shrink-0 text-2xs">
            {new Date(workflow.updatedAt * 1000).toLocaleDateString()}
          </span>
        </div>
      </div>
    </div>
  );
}
