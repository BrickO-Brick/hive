import * as React from "react";

import { useKnownAgentPubkeys } from "@/features/agents/useKnownAgentPubkeys";
import type { InboxContextMessage } from "@/features/home/lib/inbox";
import { toTimelineMessage } from "@/features/home/lib/inboxViewHelpers";
import { formatTimeWithoutDayPeriod } from "@/features/messages/lib/dateFormatters";
import type { TimelineMessage } from "@/features/messages/types";
import { getConfigNudgeAuthorPubkey } from "@/features/messages/ui/configNudgeAuthPubkey";
import { MessageActionBar } from "@/features/messages/ui/MessageActionBar";
import { MessageAgentOwner } from "@/features/messages/ui/MessageAgentOwner";
import {
  MessageBubbleStatusMetadata,
  MessageHoverTimestamp,
} from "@/features/messages/ui/MessageBubbleMetadata";
import {
  MessageAuthorText,
  MessageHeaderRow,
} from "@/features/messages/ui/MessageHeader";
import { MessageReactions } from "@/features/messages/ui/MessageReactions";
import {
  getMessageBubbleBottomPaddingClass,
  getMessageBubbleLayout,
  MESSAGE_BUBBLE_CONTENT_PADDING_CLASSES,
  MESSAGE_BUBBLE_MAX_WIDTH_CLASSES,
} from "@/features/messages/ui/messageBubbleLayout";
import { UnreadDivider } from "@/features/messages/ui/UnreadDivider";
import { useReactionHandler } from "@/features/messages/ui/useReactionHandler";
import { useMessageEmoji } from "@/features/messages/lib/useMessageEmoji";
import { UserProfilePopover } from "@/features/profile/ui/UserProfilePopover";
import { cn } from "@/shared/lib/cn";
import { useMessageStyle } from "@/shared/lib/messageStylePreference";
import { useOwnMessageAlignment } from "@/shared/lib/ownMessageAlignmentPreference";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { hasLinkPreviewSuppression } from "@/features/messages/lib/formatTimelineMessages";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import type { VideoReviewContext } from "@/shared/ui/VideoPlayer";
import { VideoReviewCommentMarkdown } from "@/shared/ui/VideoReviewCommentMarkdown";
import { parseImetaTags } from "@/shared/ui/markdown/parseImeta";

export type InboxDisplayMessage = InboxContextMessage & {
  depth: number;
};

type InboxMessageRowProps = {
  agentPubkeys?: ReadonlySet<string>;
  canReply: boolean;
  /** Channel UUID for "Copy link" — passed straight through to MessageActionBar. */
  channelId?: string | null;
  currentPubkey?: string;
  isContinuation?: boolean;
  isFollowedByContinuation?: boolean;
  isFirst?: boolean;
  isFocusHighlightVisible: boolean;
  message: InboxDisplayMessage;
  onDelete?: (message: InboxDisplayMessage) => void;
  onEdit?: (message: InboxDisplayMessage) => void;
  onSelectReplyTarget: (message: InboxDisplayMessage) => void;
  onToggleReaction?: (
    message: TimelineMessage,
    emoji: string,
    remove: boolean,
  ) => Promise<void>;
  showUnreadBoundary?: boolean;
  videoReviewCommentRootId?: string;
  videoReviewContext?: VideoReviewContext;
};

export function InboxMessageRow({
  agentPubkeys,
  canReply,
  channelId = null,
  currentPubkey,
  isContinuation = false,
  isFollowedByContinuation = false,
  isFirst = false,
  isFocusHighlightVisible,
  message,
  onDelete,
  onEdit,
  onSelectReplyTarget,
  onToggleReaction,
  showUnreadBoundary = false,
  videoReviewCommentRootId,
  videoReviewContext,
}: InboxMessageRowProps) {
  const showMessageBubbles = useMessageStyle() === "bubbles";
  const ownMessageAlignment = useOwnMessageAlignment();
  const useGroupedBubbleLayout = showMessageBubbles;
  const isOwnMessage = Boolean(
    currentPubkey &&
      normalizePubkey(message.authorPubkey) === normalizePubkey(currentPubkey),
  );
  const alignOwnMessageRight =
    useGroupedBubbleLayout && ownMessageAlignment === "right" && isOwnMessage;
  const timelineMessage = React.useMemo(
    () => toTimelineMessage(message),
    [message],
  );
  const imetaByUrl = React.useMemo(
    () => (message.tags ? parseImetaTags(message.tags) : undefined),
    [message.tags],
  );
  const { customEmoji, emojiOnly } = useMessageEmoji(
    message.content,
    message.tags,
  );
  const [badgeBurstEmoji, setBadgeBurstEmoji] = React.useState<string | null>(
    null,
  );
  const {
    reactions,
    canToggle: canToggleReactions,
    pending: reactionPending,
    errorMessage: reactionErrorMessage,
    select: handleReactionSelect,
  } = useReactionHandler(timelineMessage, onToggleReaction);
  // "Is this pubkey an agent" = the community-scoped baseline every surface
  // shares plus this surface's extras passed via `agentPubkeys` (HomeView
  // folds feed-profile `isAgent` flags in). Mirrors MessageRow's predicate.
  const knownAgentPubkeys = useKnownAgentPubkeys();
  const isKnownAgentPubkey = React.useCallback(
    (pubkey: string) => {
      const normalized = normalizePubkey(pubkey);
      return (
        knownAgentPubkeys.has(normalized) ||
        agentPubkeys?.has(normalized) === true
      );
    },
    [agentPubkeys, knownAgentPubkeys],
  );
  const isAuthorAgent = isKnownAgentPubkey(message.authorPubkey);
  const profileRole = isAuthorAgent ? "bot" : undefined;
  const hoverTimestampLabel = formatTimeWithoutDayPeriod(
    message.timeLabel ?? message.fullTimestampLabel,
  );
  const { radiusClass, rowSpacingClass } = getMessageBubbleLayout(
    isContinuation,
    isFollowedByContinuation,
    alignOwnMessageRight ? "right" : "left",
  );
  const hoverTimestampNode = useGroupedBubbleLayout ? (
    <MessageHoverTimestamp createdAt={timelineMessage.createdAt} />
  ) : null;
  const actionBarNode =
    canReply ||
    canToggleReactions ||
    onDelete ||
    onEdit ||
    useGroupedBubbleLayout ? (
      <div
        className={cn(
          "absolute z-10 flex items-center gap-2",
          showMessageBubbles && "text-foreground",
          showMessageBubbles
            ? cn(
                "top-1/2 -translate-y-1/2",
                alignOwnMessageRight ? "right-full mr-3" : "left-full ml-3",
              )
            : cn("right-2 top-1", !isFirst && "sm:top-0 sm:-translate-y-1/2"),
        )}
      >
        {alignOwnMessageRight ? hoverTimestampNode : null}
        <MessageActionBar
          actionAlign={alignOwnMessageRight ? "end" : "start"}
          channelId={channelId}
          message={timelineMessage}
          onDelete={onDelete ? () => onDelete(message) : undefined}
          onEdit={onEdit ? () => onEdit(message) : undefined}
          onReactionSelect={
            canToggleReactions ? handleReactionSelect : undefined
          }
          onReactionBadgeBurstRequest={
            reactionPending ? undefined : setBadgeBurstEmoji
          }
          onReply={canReply ? () => onSelectReplyTarget(message) : undefined}
          reactionErrorMessage={reactionErrorMessage}
          reactions={reactions}
          presentation={showMessageBubbles ? "inline" : "menu"}
        />
        {alignOwnMessageRight ? null : hoverTimestampNode}
      </div>
    ) : null;
  const profileAvatarNode = (
    <UserProfilePopover
      botIdenticonValue={message.authorLabel}
      pubkey={message.authorPubkey}
      role={profileRole}
      triggerElement="span"
    >
      <span className="inline-flex shrink-0 rounded-full focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
        <UserAvatar
          avatarUrl={message.avatarUrl}
          className="h-9 w-9 shrink-0"
          displayName={message.authorLabel}
          size="md"
        />
      </span>
    </UserProfilePopover>
  );
  const bubbleAvatarNode =
    useGroupedBubbleLayout &&
    !alignOwnMessageRight &&
    !isFollowedByContinuation ? (
      <div
        className="absolute bottom-0 right-full mr-2.5"
        data-testid="inbox-message-bubble-avatar-anchor"
      >
        {profileAvatarNode}
      </div>
    ) : null;

  return (
    <div
      className={cn(
        "relative px-2",
        showMessageBubbles && (isFollowedByContinuation ? "pb-0" : "pb-2.5"),
      )}
    >
      {showUnreadBoundary ? <UnreadDivider /> : null}
      {message.isSelected ? (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-x-3 inset-y-1 rounded-2xl transition-opacity duration-1000",
            isFocusHighlightVisible
              ? "bg-primary/[0.07] opacity-100"
              : "bg-primary/[0.07] opacity-0",
          )}
        />
      ) : null}
      <article
        className={cn(
          "group/message message-hover-region relative z-10 mx-1 flex gap-2.5 rounded-2xl px-2 transition-colors",
          showMessageBubbles
            ? rowSpacingClass
            : "py-conversation-row hover:bg-muted/50 focus-within:bg-muted/50",
          alignOwnMessageRight && "flex-row-reverse",
          isContinuation ? "items-center" : "items-start",
        )}
        data-message-id={message.id}
        data-own-message={isOwnMessage ? "true" : undefined}
        data-testid={
          message.isSelected
            ? "home-inbox-selected-message"
            : "home-inbox-context-message"
        }
      >
        {showMessageBubbles ? null : actionBarNode}

        {alignOwnMessageRight ? null : useGroupedBubbleLayout ? (
          <div aria-hidden className="w-9 shrink-0" />
        ) : isContinuation ? (
          <div
            aria-hidden={isContinuation}
            className="flex w-9 shrink-0 self-stretch items-start justify-end pt-0.5"
            title={message.fullTimestampLabel}
          >
            <p
              className="shrink-0 cursor-default whitespace-nowrap text-message-timestamp font-normal tabular-nums text-muted-foreground/55 opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100"
              data-testid="inbox-message-timestamp"
            >
              {hoverTimestampLabel}
            </p>
          </div>
        ) : (
          <div className="relative shrink-0">{profileAvatarNode}</div>
        )}

        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col gap-0.5",
            alignOwnMessageRight && "items-end",
          )}
        >
          {isContinuation ||
          (useGroupedBubbleLayout && alignOwnMessageRight) ? null : (
            <MessageHeaderRow
              className={cn(
                "gap-x-2",
                alignOwnMessageRight && "justify-end text-right",
              )}
            >
              {alignOwnMessageRight ? null : (
                <UserProfilePopover
                  botIdenticonValue={message.authorLabel}
                  pubkey={message.authorPubkey}
                  role={profileRole}
                  triggerElement="span"
                >
                  <MessageAuthorText className="block max-w-full">
                    {message.authorLabel}
                  </MessageAuthorText>
                </UserProfilePopover>
              )}
              {message.isAgent ? (
                <MessageAgentOwner
                  ownerLabel={message.ownerLabel}
                  ownerPubkey={message.ownerPubkey}
                />
              ) : null}
              {useGroupedBubbleLayout ? null : (
                <p
                  className="shrink-0 text-message-timestamp font-normal tabular-nums text-muted-foreground/55"
                  data-testid="inbox-message-timestamp"
                >
                  {message.fullTimestampLabel}
                </p>
              )}
            </MessageHeaderRow>
          )}

          <div
            className={cn(
              isContinuation || useGroupedBubbleLayout
                ? "mt-0"
                : "mt-conversation-body",
              showMessageBubbles && "w-full max-w-full",
              alignOwnMessageRight && "ml-auto",
            )}
          >
            {showMessageBubbles ? (
              <div
                className={cn(
                  "relative w-fit",
                  MESSAGE_BUBBLE_MAX_WIDTH_CLASSES,
                  alignOwnMessageRight
                    ? "ml-auto bg-primary text-primary-foreground"
                    : "bg-muted/50",
                  MESSAGE_BUBBLE_CONTENT_PADDING_CLASSES,
                  radiusClass,
                  getMessageBubbleBottomPaddingClass(reactions.length > 0),
                )}
                data-testid="message-body-surface"
              >
                {bubbleAvatarNode}
                {actionBarNode}
                {useGroupedBubbleLayout &&
                (timelineMessage.pending || timelineMessage.edited) ? (
                  <MessageBubbleStatusMetadata
                    edited={timelineMessage.edited}
                    isOwn={alignOwnMessageRight}
                    pending={timelineMessage.pending}
                  />
                ) : null}
                <VideoReviewCommentMarkdown
                  className={cn(
                    "message-bubble-markdown max-w-full text-left text-message",
                    alignOwnMessageRight
                      ? "message-bubble-own text-primary-foreground"
                      : "text-foreground",
                    emojiOnly &&
                      "text-4xl leading-tight [&_p]:leading-tight [&_img[data-custom-emoji]]:h-[1.45em] [&_img[data-custom-emoji]]:align-middle [&_button:has(img[data-custom-emoji])]:align-middle",
                  )}
                  configNudgeAuthorPubkey={getConfigNudgeAuthorPubkey(
                    timelineMessage,
                    isKnownAgentPubkey,
                  )}
                  content={message.content}
                  messageId={message.id}
                  linkPreviewsSuppressed={hasLinkPreviewSuppression(
                    timelineMessage.tags,
                  )}
                  customEmoji={customEmoji}
                  imetaByUrl={imetaByUrl}
                  mentionNames={message.mentionNames}
                  mentionPubkeysByName={message.mentionPubkeysByName}
                  videoReviewCommentRootId={videoReviewCommentRootId}
                  videoReviewContext={videoReviewContext}
                />
              </div>
            ) : (
              <VideoReviewCommentMarkdown
                className={cn(
                  "max-w-full text-left text-message text-foreground",
                  emojiOnly &&
                    "text-4xl leading-tight [&_p]:leading-tight [&_img[data-custom-emoji]]:h-[1.45em] [&_img[data-custom-emoji]]:align-middle [&_button:has(img[data-custom-emoji])]:align-middle",
                )}
                configNudgeAuthorPubkey={getConfigNudgeAuthorPubkey(
                  timelineMessage,
                  isKnownAgentPubkey,
                )}
                content={message.content}
                messageId={message.id}
                linkPreviewsSuppressed={hasLinkPreviewSuppression(
                  timelineMessage.tags,
                )}
                customEmoji={customEmoji}
                imetaByUrl={imetaByUrl}
                mentionNames={message.mentionNames}
                mentionPubkeysByName={message.mentionPubkeysByName}
                videoReviewCommentRootId={videoReviewCommentRootId}
                videoReviewContext={videoReviewContext}
              />
            )}
            <MessageReactions
              canToggle={canToggleReactions}
              className={alignOwnMessageRight ? "justify-end" : undefined}
              messageId={message.id}
              onSelect={(emoji) => {
                void handleReactionSelect(emoji);
              }}
              burstEmojiOnRender={badgeBurstEmoji}
              onBurstEmojiRendered={(emoji) => {
                setBadgeBurstEmoji((current) =>
                  current === emoji ? null : current,
                );
              }}
              pending={reactionPending}
              placement={showMessageBubbles ? "bubble-overlap" : "inline"}
              reactions={reactions}
            />
            {reactionErrorMessage ? (
              <p
                className={cn(
                  "mt-1.5 text-xs text-destructive",
                  alignOwnMessageRight && "text-right",
                )}
              >
                {reactionErrorMessage}
              </p>
            ) : null}
          </div>
        </div>
      </article>
    </div>
  );
}
