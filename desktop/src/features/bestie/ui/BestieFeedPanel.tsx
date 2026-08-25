import { Bot, ExternalLink, SendHorizontal } from "lucide-react";
import * as React from "react";

import { bestieItemSourceLabel } from "@/features/bestie/lib/bestieFeed";
import type { BestiePanelState } from "@/features/bestie/lib/bestieFeed";
import type { InboxItem } from "@/features/home/lib/inbox";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/shared/ui/sheet";
import { Textarea } from "@/shared/ui/textarea";

type PanelMessage = {
  author: "source" | "you";
  content: string;
  id: string;
};

function sourceMessages(item: InboxItem): PanelMessage[] {
  return [...item.groupItems]
    .sort((left, right) => left.createdAt - right.createdAt)
    .filter((event) => event.content.trim().length > 0)
    .map((event) => ({
      author: "source" as const,
      content: event.content.trim(),
      id: event.id,
    }));
}

export function BestieFeedPanel({
  item,
  onOpenChange,
  onOpenSource,
  state,
}: {
  item: InboxItem | null;
  onOpenChange: (open: boolean) => void;
  onOpenSource: (item: InboxItem) => void;
  state: BestiePanelState;
}) {
  const mode = state.mode === "closed" ? null : state.mode;
  const [draft, setDraft] = React.useState("");
  const [localMessages, setLocalMessages] = React.useState<PanelMessage[]>([]);

  if (!item || !mode) return null;

  const isChat = mode === "chat";
  const messages = isChat
    ? localMessages
    : [...sourceMessages(item), ...localMessages];
  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    setLocalMessages((current) => [
      ...current,
      { author: "you", content, id: `${item.id}-local-${current.length}` },
    ]);
    setDraft("");
  };

  return (
    <Sheet onOpenChange={onOpenChange} open>
      <SheetContent
        aria-describedby="bestie-panel-description"
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[30rem]"
        data-testid={`bestie-${mode}-panel`}
        side="right"
      >
        <SheetHeader className="border-b border-border/60 px-5 pb-4 pt-5 pr-14 text-left">
          <div className="flex items-center gap-2">
            {isChat ? <Bot className="h-4 w-4" /> : null}
            <SheetTitle>
              {isChat
                ? "Bestie · About this item"
                : `Reply in ${bestieItemSourceLabel(item)}`}
            </SheetTitle>
          </div>
          <SheetDescription id="bestie-panel-description">
            {isChat
              ? "The exact Buzz item is pinned below. Agent chat is not connected yet."
              : "This panel shows the real source conversation from Buzz."}
          </SheetDescription>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge className="normal-case tracking-normal" variant="outline">
              {isChat
                ? "Prototype chat · no agent response"
                : "Prototype composer · nothing is sent"}
            </Badge>
            {item.item.channelId ? (
              <Button
                onClick={() => onOpenSource(item)}
                size="xs"
                type="button"
                variant="ghost"
              >
                Open source
                <ExternalLink />
              </Button>
            ) : null}
          </div>
        </SheetHeader>

        <div className="border-b border-border/60 bg-muted/25 px-5 py-4">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Pinned Buzz context
          </p>
          <p className="mt-1 text-sm font-semibold">{item.subject}</p>
          <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
            {item.preview}
          </p>
        </div>

        <div
          aria-live="polite"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-5"
          data-testid="bestie-panel-transcript"
        >
          {messages.length > 0 ? (
            messages.map((message) => (
              <div
                className={
                  message.author === "you"
                    ? "ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-foreground px-4 py-2.5 text-sm text-background"
                    : "mr-auto max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-muted px-4 py-2.5 text-sm text-foreground"
                }
                data-author={message.author}
                key={message.id}
              >
                {message.content}
              </div>
            ))
          ) : (
            <p className="my-auto text-center text-sm text-muted-foreground">
              Bestie chat is not connected in this prototype. Add a question
              here to test the interaction; it stays local and receives no
              simulated answer.
            </p>
          )}
        </div>

        <form className="border-t border-border/60 p-4" onSubmit={handleSubmit}>
          <Textarea
            aria-label={isChat ? "Ask Bestie about this item" : "Write a reply"}
            autoFocus
            className="min-h-24 resize-none"
            data-testid="bestie-panel-input"
            onChange={(event) => setDraft(event.target.value)}
            placeholder={isChat ? "Ask about this item…" : "Write a reply…"}
            value={draft}
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              Local prototype only
            </span>
            <Button disabled={!draft.trim()} size="sm" type="submit">
              <SendHorizontal />
              {isChat ? "Add question" : "Add reply"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
