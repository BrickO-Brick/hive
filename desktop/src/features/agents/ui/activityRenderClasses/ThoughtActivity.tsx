import * as React from "react";
import { Brain, ChevronDown } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Markdown } from "@/shared/ui/markdown";
import { Shimmer } from "@/shared/ui/Shimmer";
import {
  ActivityRow,
  ActivityRowContent,
  ActivityRowLabel,
} from "./ActivityRow";
import { ToolActivity } from "./ToolActivity";
import { formatThoughtDisclosureLabel } from "../agentSessionConversationMeta";
import {
  useAgentSessionTranscriptTurnMeta,
  useAgentSessionTranscriptVariant,
} from "../agentSessionTranscriptContext";
import { formatTranscriptTimestampTitle } from "../agentSessionUtils";
import type { ActivityRenderClassItemProps } from "./types";

export function ThoughtActivity(props: ActivityRenderClassItemProps) {
  if (props.item.type === "tool") {
    return <ToolActivity {...props} />;
  }
  if (props.item.type !== "thought") {
    return null;
  }

  return <ThoughtItem item={props.item} />;
}

function ThoughtItem({
  item,
}: {
  item: Extract<ActivityRenderClassItemProps["item"], { type: "thought" }>;
}) {
  const variant = useAgentSessionTranscriptVariant();

  if (variant === "conversation") {
    return <ConversationThought item={item} />;
  }

  return (
    <ActivityRow
      testId="transcript-thought-item"
      title={formatTranscriptTimestampTitle(item.timestamp)}
    >
      <ActivityRowLabel openToneScope="tool" verb={item.title} />
      <ActivityRowContent className="pt-1 pb-1.5 text-sm leading-5 text-muted-foreground">
        <Markdown className="leading-5" content={item.text.trim() || " "} />
      </ActivityRowContent>
    </ActivityRow>
  );
}

/**
 * Focus-mode reasoning disclosure: collapsed by default so the reader sees the
 * prompt/response rhythm, open while the thought is the streaming tail of a
 * live turn so reasoning can be watched as it arrives, and collapsed again once
 * the turn produces its next item (that is exactly when the item stops being
 * the streaming tail — no timers involved).
 *
 * A reader who opens or closes it takes over: `userOpen` pins the state so the
 * next stream transition cannot yank the panel out from under them.
 */
function ConversationThought({
  item,
}: {
  item: Extract<ActivityRenderClassItemProps["item"], { type: "thought" }>;
}) {
  const turnMeta = useAgentSessionTranscriptTurnMeta();
  const isStreaming = turnMeta.streamingItemId === item.id;
  const [userOpen, setUserOpen] = React.useState<boolean | null>(null);
  const isOpen = userOpen ?? isStreaming;
  const label = formatThoughtDisclosureLabel({
    durationSeconds: turnMeta.thoughtDurationSecondsById[item.id],
    isStreaming,
  });

  return (
    <details
      className="not-prose group w-full"
      data-testid="transcript-thought-item"
      onToggle={(event) => {
        setUserOpen(event.currentTarget.open);
      }}
      open={isOpen}
      title={formatTranscriptTimestampTitle(item.timestamp)}
    >
      <summary
        className="flex w-full cursor-pointer list-none items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        data-testid="transcript-thought-disclosure"
      >
        <Brain aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        {isStreaming ? <Shimmer>{label}</Shimmer> : <span>{label}</span>}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform",
            "group-open:rotate-180",
          )}
        />
      </summary>
      <div className="mt-2 border-l border-border/60 pl-3 text-sm leading-relaxed text-muted-foreground">
        <Markdown
          className="leading-relaxed"
          content={item.text.trim() || " "}
        />
      </div>
    </details>
  );
}
