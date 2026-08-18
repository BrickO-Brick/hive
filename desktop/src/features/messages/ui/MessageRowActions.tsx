import type {
  TimelineMessage,
  TimelineReaction,
} from "@/features/messages/types";
import { cn } from "@/shared/lib/cn";
import { MessageActionBar } from "./MessageActionBar";
import { MessageHoverTimestamp } from "./MessageBubbleMetadata";

type MessageRowActionsProps = {
  anchorToBubble: boolean;
  bubbleAlignment: "left" | "right";
  channelId?: string | null;
  isFollowingThread?: boolean;
  isUnread?: boolean;
  message: TimelineMessage;
  onDelete?: (message: TimelineMessage) => void;
  onEdit?: (message: TimelineMessage) => void;
  onFollowThread?: (message: TimelineMessage) => void;
  onMarkRead?: (message: TimelineMessage) => void;
  onMarkUnread?: (message: TimelineMessage) => void;
  onReactionBadgeBurstRequest?: (emoji: string) => void;
  onReactionSelect?: (emoji: string) => Promise<void>;
  onRemindLater?: (message: TimelineMessage) => void;
  onReply?: (message: TimelineMessage) => void;
  onSendToChannel?: (message: TimelineMessage) => Promise<void>;
  onUnfollowThread?: (message: TimelineMessage) => void;
  reactionErrorMessage?: string | null;
  reactions: TimelineReaction[];
  showMessageBubbles: boolean;
  showHoverTimestamp?: boolean;
};

export function MessageRowActions({
  anchorToBubble,
  bubbleAlignment,
  channelId,
  isFollowingThread,
  isUnread,
  message,
  onDelete,
  onEdit,
  onFollowThread,
  onMarkRead,
  onMarkUnread,
  onReactionBadgeBurstRequest,
  onReactionSelect,
  onRemindLater,
  onReply,
  onSendToChannel,
  onUnfollowThread,
  reactionErrorMessage,
  reactions,
  showMessageBubbles,
  showHoverTimestamp = false,
}: MessageRowActionsProps) {
  const showInlineBubbleActions = showMessageBubbles && anchorToBubble;

  return (
    <div
      className={cn(
        "absolute z-10 flex items-center gap-2",
        showInlineBubbleActions && "text-foreground",
        showInlineBubbleActions
          ? cn(
              "top-1/2 -translate-y-1/2",
              bubbleAlignment === "right"
                ? "right-full mr-3"
                : "left-full ml-3",
            )
          : "right-1 top-1",
      )}
    >
      {showHoverTimestamp && bubbleAlignment === "right" ? (
        <MessageHoverTimestamp createdAt={message.createdAt} />
      ) : null}
      <MessageActionBar
        actionAlign={bubbleAlignment === "left" ? "start" : "end"}
        channelId={channelId}
        isFollowingThread={isFollowingThread}
        isUnread={isUnread}
        message={message}
        onDelete={onDelete}
        onEdit={onEdit}
        onFollowThread={onFollowThread}
        onMarkRead={onMarkRead}
        onMarkUnread={onMarkUnread}
        onReactionBadgeBurstRequest={onReactionBadgeBurstRequest}
        onReactionSelect={onReactionSelect}
        onRemindLater={onRemindLater}
        onReply={onReply}
        onSendToChannel={onSendToChannel}
        onUnfollowThread={onUnfollowThread}
        presentation={showInlineBubbleActions ? "inline" : "menu"}
        reactionErrorMessage={reactionErrorMessage}
        reactions={reactions}
      />
      {showHoverTimestamp && bubbleAlignment === "left" ? (
        <MessageHoverTimestamp createdAt={message.createdAt} />
      ) : null}
    </div>
  );
}
