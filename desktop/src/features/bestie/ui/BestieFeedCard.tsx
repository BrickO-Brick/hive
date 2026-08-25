import {
  Bot,
  Clock3,
  GitPullRequest,
  MessageSquareReply,
  Sparkles,
} from "lucide-react";

import { bestieItemSourceLabel } from "@/features/bestie/lib/bestieFeed";
import type { InboxItem } from "@/features/home/lib/inbox";
import { isProjectInboxItem } from "@/features/home/lib/projectInbox";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

type BestieFeedCardProps = {
  item: InboxItem;
  onChat: () => void;
  onReply: () => void;
  onSnooze: () => void;
};

function actualSupportingContent(item: InboxItem) {
  const seen = new Set<string>();
  return [...item.groupItems]
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((event) => event.content.trim())
    .filter((content) => {
      if (!content || seen.has(content)) return false;
      seen.add(content);
      return true;
    })
    .slice(-2);
}

function SupportingVisual({ item }: { item: InboxItem }) {
  const content = actualSupportingContent(item);
  const projectItem = isProjectInboxItem(item.item);

  return (
    <div
      className="rounded-2xl border border-border/60 bg-muted/25 p-4"
      data-testid="bestie-source-visual"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {projectItem ? (
          <GitPullRequest className="h-4 w-4 text-violet-500" />
        ) : item.categories.includes("agent_activity") ? (
          <Bot className="h-4 w-4" />
        ) : (
          <MessageSquareReply className="h-4 w-4" />
        )}
        <span className="font-medium text-foreground">
          {bestieItemSourceLabel(item)}
        </span>
        <span>·</span>
        <span>{item.categoryLabel}</span>
        {item.unreadCount > 0 ? <span>· {item.unreadCount} unread</span> : null}
      </div>
      {content.length > 0 ? (
        <div className="mt-3 flex flex-col items-start gap-1.5">
          {content.map((message) => (
            <div
              className="max-w-full rounded-2xl bg-muted/70 px-4 py-2.5 text-sm leading-relaxed text-foreground"
              key={message}
            >
              {message}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          This Buzz event has no text content.
        </p>
      )}
    </div>
  );
}

function IconAction({
  children,
  label,
  onClick,
  testId,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className="h-10 w-10 rounded-full bg-muted/50"
          data-testid={testId}
          onClick={onClick}
          size="icon"
          type="button"
          variant="ghost"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function BestieFeedCard({
  item,
  onChat,
  onReply,
  onSnooze,
}: BestieFeedCardProps) {
  const headingId = `bestie-card-heading-${item.id}`;

  return (
    <article
      aria-labelledby={headingId}
      className="rounded-[1.75rem] border border-border/55 bg-background/95 p-5 shadow-sm sm:p-7"
      data-bestie-category={item.categories.join(" ")}
      data-testid={`bestie-card-${item.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <time dateTime={new Date(item.latestActivityAt * 1_000).toISOString()}>
          {item.fullTimestampLabel}
        </time>
        <div className="flex flex-wrap gap-1.5">
          {item.categories.map((category) => (
            <Badge
              className="normal-case tracking-normal"
              key={category}
              variant="secondary"
            >
              {category === "needs_action"
                ? "Needs action"
                : category === "agent_activity"
                  ? "Agent update"
                  : category === "mention"
                    ? "Mention"
                    : "Activity"}
            </Badge>
          ))}
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3">
        {item.avatarUrl ? (
          <img
            alt=""
            className="h-11 w-11 shrink-0 rounded-2xl object-cover"
            src={item.avatarUrl}
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-xs font-semibold text-background"
          >
            {item.senderLabel.slice(0, 2).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{item.senderLabel}</p>
          <p className="truncate text-xs text-muted-foreground">
            {bestieItemSourceLabel(item)}
          </p>
        </div>
      </div>

      <h2
        className="mt-5 text-balance text-xl font-semibold leading-tight tracking-tight sm:text-2xl"
        id={headingId}
      >
        {item.subject}
      </h2>
      <p className="mt-2 max-w-2xl whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
        {item.preview}
      </p>

      <div className="mt-5">
        <SupportingVisual item={item} />
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <IconAction
            label={`Snooze ${item.subject}`}
            onClick={onSnooze}
            testId={`bestie-snooze-${item.id}`}
          >
            <Clock3 />
          </IconAction>
          <IconAction
            label={`Reply about ${item.subject}`}
            onClick={onReply}
            testId={`bestie-reply-${item.id}`}
          >
            <MessageSquareReply />
          </IconAction>
        </div>
        <Button
          className="h-10 rounded-full px-4"
          data-testid={`bestie-chat-${item.id}`}
          onClick={onChat}
          type="button"
          variant="secondary"
        >
          <span aria-hidden="true">🐝</span>
          Chat with Bestie
          <Sparkles className="h-4 w-4" />
        </Button>
      </div>
    </article>
  );
}
