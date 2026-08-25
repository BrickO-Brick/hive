import { Clock3, MessageSquareReply, Sparkles } from "lucide-react";

import { bestieItemSummary } from "@/features/bestie/lib/bestieFeed";
import type { InboxItem } from "@/features/home/lib/inbox";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { parseImetaTags } from "@/shared/ui/markdown/parseImeta";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { VideoReviewCommentMarkdown } from "@/shared/ui/VideoReviewCommentMarkdown";

type BestieFeedCardProps = {
  item: InboxItem;
  onChat: () => void;
  onReply: () => void;
  onSnooze: () => void;
};

function actualSupportingItems(item: InboxItem) {
  const seen = new Set<string>();
  return [...item.groupItems]
    .sort((left, right) => left.createdAt - right.createdAt)
    .filter((event) => {
      const content = event.content.trim();
      if (!content || seen.has(content)) return false;
      seen.add(content);
      return true;
    })
    .slice(-2);
}

function SupportingVisual({ item }: { item: InboxItem }) {
  const sourceItems = actualSupportingItems(item);

  return (
    <div
      className="rounded-2xl border border-border/60 bg-muted/25 p-4"
      data-testid="bestie-source-visual"
    >
      {sourceItems.length > 0 ? (
        <div className="flex flex-col items-start gap-1.5">
          {sourceItems.map((sourceItem) => (
            <div
              className="max-w-full overflow-hidden rounded-2xl bg-muted/70 px-4 py-2.5"
              key={sourceItem.id}
            >
              <VideoReviewCommentMarkdown
                className="max-w-full text-sm leading-relaxed text-foreground [&_p]:line-clamp-4"
                content={sourceItem.content}
                imetaByUrl={parseImetaTags(sourceItem.tags)}
                messageId={sourceItem.id}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
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
  const summary = bestieItemSummary(item);

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
        <UserAvatar
          avatarUrl={item.avatarUrl}
          className="h-11 w-11 shrink-0"
          displayName={item.senderLabel}
          fallbackDelayMs={0}
          testId={`bestie-avatar-${item.id}`}
        />
      </div>

      <h2
        className="mt-5 text-balance text-xl font-semibold leading-tight tracking-tight sm:text-2xl"
        id={headingId}
      >
        {summary}
      </h2>

      <div className="mt-5">
        <SupportingVisual item={item} />
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <IconAction
            label={`Snooze ${summary}`}
            onClick={onSnooze}
            testId={`bestie-snooze-${item.id}`}
          >
            <Clock3 />
          </IconAction>
          <IconAction
            label={`Reply about ${summary}`}
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
