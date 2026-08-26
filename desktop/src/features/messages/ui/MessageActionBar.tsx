import {
  BellOff,
  BellRing,
  Clock,
  Copy,
  CornerUpLeft,
  EllipsisVertical,
  Flag,
  Link2,
  MailCheck,
  MailOpen,
  Pencil,
  SmilePlus,
  Trash2,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import * as React from "react";
import { toast } from "sonner";

import { EmojiPicker } from "@/features/custom-emoji/ui/EmojiPicker";
import { useCustomEmoji } from "@/features/custom-emoji/hooks";
import { ReportMessageDialog } from "@/features/moderation/ui/ReportMessageDialog";
import { MessageModerationInlineItems } from "@/features/moderation/ui/MessageModerationMenuItems";
import type {
  TimelineMessage,
  TimelineReaction,
} from "@/features/messages/types";
import {
  recordQuickReactionEmoji,
  useQuickReactionEmojis,
} from "@/features/messages/ui/useQuickReactionEmojis";
import { reactionEmojiUrl } from "@/shared/api/customEmoji";
import { cn } from "@/shared/lib/cn";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { KIND_HUDDLE_STARTED } from "@/shared/constants/kinds";
import { Button } from "@/shared/ui/button";
import { HashArrowIn } from "@/shared/ui/icons";
import { DeleteMessageConfirmDialog } from "./DeleteMessageConfirmDialog";
import { isPositiveEmojiParticle } from "@/shared/ui/EmojiBurstProvider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import {
  BestieMessagePanel,
  useBestieMessageAgent,
} from "./BestieMessagePopover";
import {
  MESSAGE_ACTION_BLOOM_EASE_OUT,
  MESSAGE_ACTION_BLOOM_SPEED_MULTIPLIER,
  MESSAGE_ACTION_BLOOM_VISUAL_DURATION,
  MessageActionBloomSurface,
} from "./MessageActionBloomSurface";
import {
  canCopyMessageLink,
  copyMessageLink,
  isCustomEmojiShortcode,
  QuickReactionButton,
} from "./MessageActionToolbarHelpers";

const ACTION_BUTTON_CLASS = "h-8 w-8 rounded-full p-0";
const ACTION_ICON_CLASS = "!h-4 !w-4";

function MoreActionsPanel({
  channelId,
  message,
  onDelete,
  onEdit,
  onFollowThread,
  onMarkUnread,
  onMarkRead,
  onClose,
  onRemindLater,
  onSendToChannel,
  onUnfollowThread,
  isFollowingThread,
  isUnread,
}: {
  /** Channel UUID for the "Copy link" action. When null/undefined, the
   *  Copy link entry is hidden (e.g. inbox preview rows that don't have it). */
  channelId?: string | null;
  message: TimelineMessage;
  onDelete?: (message: TimelineMessage) => void;
  onEdit?: (message: TimelineMessage) => void;
  onFollowThread?: (message: TimelineMessage) => void;
  onMarkUnread?: (message: TimelineMessage) => void;
  onMarkRead?: (message: TimelineMessage) => void;
  onClose: () => void;
  onRemindLater?: (message: TimelineMessage) => void;
  onSendToChannel?: (message: TimelineMessage) => Promise<void>;
  onUnfollowThread?: (message: TimelineMessage) => void;
  isFollowingThread?: boolean;
  isUnread?: boolean;
}) {
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = React.useState(false);
  const [isReportDialogOpen, setIsReportDialogOpen] = React.useState(false);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const hasCopyActions =
    !message.pending && message.kind !== KIND_HUDDLE_STARTED;

  // A report needs a real, delivered event to target and a known author to
  // name in the NIP-56 `p` tag. Pending sends and system huddle rows have
  // neither, so the entry is hidden for them.
  const canReport =
    !message.pending &&
    message.kind !== KIND_HUDDLE_STARTED &&
    Boolean(message.pubkey);

  const itemClassName =
    "flex min-h-9 w-full select-none items-center gap-2 rounded-lg py-2 pl-2 pr-4 text-left text-sm outline-hidden transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring [&>svg]:size-4 [&>svg]:shrink-0";

  React.useEffect(() => {
    panelRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
      ?.focus();
  }, []);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([disabled])',
      ),
    );
    if (items.length === 0) return;

    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (currentIndex + 1) % items.length
            : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  return (
    <>
      <div
        className="max-h-[min(420px,calc(100vh-3rem))] min-w-60 overflow-y-auto p-1"
        data-testid={`more-actions-panel-${message.id}`}
        onKeyDown={handleMenuKeyDown}
        ref={panelRef}
        role="menu"
      >
        {onEdit ? (
          <button
            className={itemClassName}
            data-testid={`edit-message-${message.id}`}
            onClick={() => {
              onClose();
              onEdit(message);
            }}
            role="menuitem"
            type="button"
          >
            <Pencil className="h-4 w-4" />
            Edit message
          </button>
        ) : null}

        {onMarkRead || onMarkUnread ? (
          <button
            className={itemClassName}
            data-testid={`mark-read-toggle-${message.id}`}
            onClick={() => {
              if (isUnread) {
                onMarkRead?.(message);
              } else {
                onMarkUnread?.(message);
              }
              onClose();
            }}
            role="menuitem"
            type="button"
          >
            {isUnread ? (
              <MailCheck className="h-4 w-4" />
            ) : (
              <MailOpen className="h-4 w-4" />
            )}
            {isUnread ? "Mark read" : "Mark unread"}
          </button>
        ) : null}

        {onFollowThread || onUnfollowThread ? (
          <button
            className={itemClassName}
            onClick={() => {
              if (isFollowingThread) {
                onUnfollowThread?.(message);
              } else {
                onFollowThread?.(message);
              }
              onClose();
            }}
            role="menuitem"
            type="button"
          >
            {isFollowingThread ? (
              <BellOff className="h-4 w-4" />
            ) : (
              <BellRing className="h-4 w-4" />
            )}
            {isFollowingThread ? "Unfollow thread" : "Follow thread"}
          </button>
        ) : null}

        {hasCopyActions ? (
          <button
            className={itemClassName}
            onClick={() => {
              copyTextToClipboard(message.body, "Message copied to clipboard");
              onClose();
            }}
            role="menuitem"
            type="button"
          >
            <Copy className="h-4 w-4" />
            Copy message
          </button>
        ) : null}

        {onRemindLater ? (
          <button
            className={itemClassName}
            onClick={() => {
              onRemindLater(message);
              onClose();
            }}
            role="menuitem"
            type="button"
          >
            <Clock className="h-4 w-4" />
            Remind me later
          </button>
        ) : null}

        {onSendToChannel ? (
          <button
            aria-label="Send to channel"
            className={itemClassName}
            data-testid={`send-to-channel-${message.id}`}
            onClick={() => {
              onClose();
              void onSendToChannel(message)
                .then(() => toast.success("Sent to channel"))
                .catch((error) => {
                  console.error(
                    "Failed to send thread message to channel",
                    error,
                  );
                  toast.error("Couldn't send to channel");
                });
            }}
            role="menuitem"
            type="button"
          >
            <HashArrowIn
              aria-hidden="true"
              className="h-4 w-4"
              data-testid="send-to-channel-icon"
            />
            Send to channel
          </button>
        ) : null}

        {canCopyMessageLink(message, channelId) ? (
          <button
            className={itemClassName}
            data-testid={`copy-message-link-${message.id}`}
            onClick={() => {
              copyMessageLink(channelId, message);
              onClose();
            }}
            role="menuitem"
            type="button"
          >
            <Link2 className="h-4 w-4" />
            Copy link
          </button>
        ) : null}

        {canReport || onDelete ? (
          <hr className="-mx-1 my-1 border-0 border-t border-muted" />
        ) : null}

        {canReport ? (
          <button
            className={itemClassName}
            data-testid={`report-message-${message.id}`}
            onClick={() => {
              setIsReportDialogOpen(true);
            }}
            role="menuitem"
            type="button"
          >
            <Flag className="h-4 w-4" />
            Report message
          </button>
        ) : null}

        {onDelete ? (
          <button
            className={`${itemClassName} text-destructive`}
            data-testid={`delete-message-${message.id}`}
            onClick={() => {
              setIsDeleteDialogOpen(true);
            }}
            role="menuitem"
            type="button"
          >
            <Trash2 className="h-4 w-4" />
            Delete message
          </button>
        ) : null}

        <MessageModerationInlineItems
          channelId={channelId}
          message={message}
          onAction={onClose}
        />
      </div>

      {onDelete ? (
        <DeleteMessageConfirmDialog
          onConfirm={() => onDelete(message)}
          onOpenChange={(nextOpen) => {
            setIsDeleteDialogOpen(nextOpen);
            if (!nextOpen) onClose();
          }}
          open={isDeleteDialogOpen}
        />
      ) : null}

      {canReport ? (
        <ReportMessageDialog
          open={isReportDialogOpen}
          onOpenChange={(nextOpen) => {
            setIsReportDialogOpen(nextOpen);
            if (!nextOpen) onClose();
          }}
          authorPubkey={message.pubkey ?? ""}
          eventId={message.id}
        />
      ) : null}
    </>
  );
}

export const MessageActionBar = React.memo(function MessageActionBar({
  channelId,
  message,
  onDelete,
  onEdit,
  onExpandedChange,
  onFollowThread,
  onMarkUnread,
  onMarkRead,
  onReactionBadgeBurstRequest,
  onReactionSelect,
  onRemindLater,
  onReply,
  onSendToChannel,
  onUnfollowThread,
  reactionErrorMessage = null,
  reactions,
  isFollowingThread,
  isUnread,
}: {
  /** Channel UUID — required for the "Copy link" action; when omitted the
   *  action is hidden (callers like the home inbox that lack the context). */
  channelId?: string | null;
  message: TimelineMessage;
  onDelete?: (message: TimelineMessage) => void;
  onEdit?: (message: TimelineMessage) => void;
  onExpandedChange?: (expanded: boolean) => void;
  onFollowThread?: (message: TimelineMessage) => void;
  onMarkUnread?: (message: TimelineMessage) => void;
  onMarkRead?: (message: TimelineMessage) => void;
  onReactionBadgeBurstRequest?: (emoji: string) => void;
  onReactionSelect?: (emoji: string) => Promise<void>;
  onRemindLater?: (message: TimelineMessage) => void;
  onReply?: (message: TimelineMessage) => void;
  onSendToChannel?: (message: TimelineMessage) => Promise<void>;
  onUnfollowThread?: (message: TimelineMessage) => void;
  reactionErrorMessage?: string | null;
  reactions: TimelineReaction[];
  isFollowingThread?: boolean;
  /** Current read state of the clicked message, from the same predicate the
   *  unread badge uses. Drives the single mark-read/unread toggle label. */
  isUnread?: boolean;
}) {
  const [activeSurface, setActiveSurface] = React.useState<
    "reactions" | "bestie" | "more" | null
  >(null);
  const bestie = useBestieMessageAgent();
  const reduceMotion = useReducedMotion();
  const surfaceRef = React.useRef<HTMLDivElement>(null);
  const toolbarRef = React.useRef<HTMLDivElement>(null);
  const activeContentRef = React.useRef<HTMLDivElement>(null);
  const anchorRectRef = React.useRef<DOMRect | null>(null);
  const promotionTimerRef = React.useRef<number | null>(null);
  const [closedSize, setClosedSize] = React.useState<{
    height: number;
    width: number;
  } | null>(null);
  const [openSize, setOpenSize] = React.useState<{
    height: number;
    width: number;
  } | null>(null);
  const [contentReady, setContentReady] = React.useState(false);
  const [expansionDirection, setExpansionDirection] = React.useState<
    "up" | "down"
  >("up");
  const reactionTriggerRef = React.useRef<HTMLButtonElement>(null);
  const bestieTriggerRef = React.useRef<HTMLButtonElement>(null);
  const moreTriggerRef = React.useRef<HTMLButtonElement>(null);
  const lastSurfaceRef = React.useRef<typeof activeSurface>(null);
  const customEmoji = useCustomEmoji();
  const quickReactionEmojis = useQuickReactionEmojis(3, customEmoji);
  const quickReactionItems = React.useMemo(
    () =>
      quickReactionEmojis
        .map((emoji) => ({
          customEmojiUrl: reactionEmojiUrl(emoji, customEmoji),
          emoji,
        }))
        .filter(
          (item) => !isCustomEmojiShortcode(item.emoji) || item.customEmojiUrl,
        ),
    [customEmoji, quickReactionEmojis],
  );
  const hasReplyAction = Boolean(onReply);
  const hasReactionAction = Boolean(onReactionSelect);

  const hasMoreMenuActions =
    Boolean(onEdit) ||
    Boolean(onDelete) ||
    Boolean(onMarkUnread) ||
    Boolean(onMarkRead) ||
    Boolean(onFollowThread) ||
    Boolean(onUnfollowThread) ||
    Boolean(onRemindLater) ||
    Boolean(onSendToChannel) ||
    !message.pending;

  React.useEffect(() => {
    onExpandedChange?.(activeSurface !== null);
    return () => onExpandedChange?.(false);
  }, [activeSurface, onExpandedChange]);

  const wouldAddReaction = React.useCallback(
    (emoji: string) =>
      !reactions.some(
        (reaction) => reaction.emoji === emoji && reaction.reactedByCurrentUser,
      ),
    [reactions],
  );
  const handleReactionSelection = React.useCallback(
    (emoji: string, closePicker = false) => {
      if (!onReactionSelect) {
        return;
      }

      if (wouldAddReaction(emoji) && isPositiveEmojiParticle(emoji)) {
        onReactionBadgeBurstRequest?.(emoji);
      }

      void onReactionSelect(emoji)
        .then(() => {
          recordQuickReactionEmoji(emoji);
        })
        .catch(() => {})
        .finally(() => {
          if (closePicker) {
            setActiveSurface(null);
          }
        });
    },
    [onReactionBadgeBurstRequest, onReactionSelect, wouldAddReaction],
  );
  const closeSurface = React.useCallback((restoreFocus = false) => {
    const surface = lastSurfaceRef.current;
    setActiveSurface(null);
    if (!restoreFocus) return;
    window.requestAnimationFrame(() => {
      if (surface === "reactions") reactionTriggerRef.current?.focus();
      if (surface === "bestie") bestieTriggerRef.current?.focus();
      if (surface === "more") moreTriggerRef.current?.focus();
    });
  }, []);
  const openSurface = React.useCallback(
    (surface: Exclude<typeof activeSurface, null>) => {
      const bloom = surfaceRef.current;
      if (bloom && !bloom.matches(":popover-open")) {
        const anchorRect = bloom.getBoundingClientRect();
        anchorRectRef.current = anchorRect;
        bloom.setAttribute("popover", "manual");
        bloom.style.position = "fixed";
        bloom.style.inset = "auto";
        bloom.style.right = `${window.innerWidth - anchorRect.right}px`;
        bloom.style.bottom = `${window.innerHeight - anchorRect.bottom}px`;
        bloom.style.margin = "0";
        bloom.showPopover();
      }
      if (promotionTimerRef.current !== null) {
        window.clearTimeout(promotionTimerRef.current);
        promotionTimerRef.current = null;
      }
      lastSurfaceRef.current = surface;
      setContentReady(false);
      setOpenSize(null);
      setActiveSurface(surface);
    },
    [],
  );

  React.useLayoutEffect(() => {
    if (!activeSurface) return;
    const bloom = surfaceRef.current;
    const anchorRect = anchorRectRef.current;
    if (!bloom || !anchorRect) return;

    bloom.style.right = `${window.innerWidth - anchorRect.right}px`;
    if (expansionDirection === "up") {
      bloom.style.top = "auto";
      bloom.style.bottom = `${window.innerHeight - anchorRect.bottom}px`;
    } else {
      bloom.style.top = `${anchorRect.top}px`;
      bloom.style.bottom = "auto";
    }
  }, [activeSurface, expansionDirection]);

  React.useEffect(() => {
    if (activeSurface) return;
    const bloom = surfaceRef.current;
    if (!bloom?.matches(":popover-open")) return;

    promotionTimerRef.current = window.setTimeout(
      () => {
        if (bloom.matches(":popover-open")) bloom.hidePopover();
        bloom.removeAttribute("popover");
        bloom.style.removeProperty("position");
        bloom.style.removeProperty("inset");
        bloom.style.removeProperty("right");
        bloom.style.removeProperty("bottom");
        bloom.style.removeProperty("top");
        bloom.style.removeProperty("margin");
        anchorRectRef.current = null;
        promotionTimerRef.current = null;
      },
      reduceMotion
        ? 0
        : MESSAGE_ACTION_BLOOM_VISUAL_DURATION * 1000 +
            20 / MESSAGE_ACTION_BLOOM_SPEED_MULTIPLIER,
    );

    return () => {
      if (promotionTimerRef.current !== null) {
        window.clearTimeout(promotionTimerRef.current);
        promotionTimerRef.current = null;
      }
    };
  }, [activeSurface, reduceMotion]);

  React.useEffect(
    () => () => {
      if (promotionTimerRef.current !== null) {
        window.clearTimeout(promotionTimerRef.current);
      }
    },
    [],
  );

  React.useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;

    const measure = () => {
      const rect = toolbar.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setClosedSize((current) => {
          if (current?.height === rect.height && current.width === rect.width) {
            return current;
          }
          return { height: rect.height, width: rect.width };
        });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, []);

  React.useLayoutEffect(() => {
    if (!activeSurface) return;
    const content = activeContentRef.current;
    if (!content) return;

    let firstFrame = 0;
    let settledFrame = 0;
    const measureAfterLayoutSettles = () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(settledFrame);
      firstFrame = window.requestAnimationFrame(() => {
        settledFrame = window.requestAnimationFrame(() => {
          const rect = content.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return;
          const surfaceRect = surfaceRef.current?.getBoundingClientRect();
          if (surfaceRect) {
            const margin = 64;
            const roomAbove = surfaceRect.bottom - margin;
            const roomBelow = window.innerHeight - surfaceRect.top - margin;
            setExpansionDirection(
              rect.height <= roomAbove || roomAbove >= roomBelow
                ? "up"
                : "down",
            );
          }
          const height = Math.ceil(rect.height);
          const width = Math.ceil(rect.width);
          setOpenSize((current) =>
            current?.height === height && current.width === width
              ? current
              : { height, width },
          );
          setContentReady(true);
        });
      });
    };

    measureAfterLayoutSettles();
    const observer = new ResizeObserver(measureAfterLayoutSettles);
    observer.observe(content);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(settledFrame);
    };
  }, [activeSurface]);

  React.useEffect(() => {
    if (!activeSurface) return;

    const currentBar = surfaceRef.current?.closest("[data-message-action-bar]");
    const otherBars = Array.from(
      document.querySelectorAll<HTMLElement>("[data-message-action-bar]"),
    ).filter((bar) => bar !== currentBar);
    for (const bar of otherBars) bar.inert = true;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.composedPath().includes(surfaceRef.current as EventTarget)) {
        return;
      }
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-radix-popper-content-wrapper], [role="dialog"]')
      ) {
        return;
      }
      closeSurface();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeSurface(true);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      for (const bar of otherBars) bar.inert = false;
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [activeSurface, closeSurface]);

  if (!hasReplyAction && !hasReactionAction && !hasMoreMenuActions) {
    return null;
  }

  return (
    <div
      className={cn(
        "relative h-10 w-0 transition-opacity duration-150 ease-out",
        "opacity-100 sm:pointer-events-none sm:opacity-0",
        "sm:group-hover/message:pointer-events-auto sm:group-hover/message:opacity-100",
        "sm:group-focus-within/message:pointer-events-auto sm:group-focus-within/message:opacity-100",
        activeSurface ? "sm:pointer-events-auto sm:opacity-100" : "",
      )}
      data-bloom-surface={activeSurface ?? "toolbar"}
      data-message-action-bar
      data-testid={`message-action-bar-${message.id}`}
    >
      <MessageActionBloomSurface
        className={cn(
          "absolute right-0 m-0 p-0 [&::backdrop]:hidden",
          expansionDirection === "up" ? "bottom-0" : "top-0",
        )}
        data-testid={`message-action-bloom-container-${message.id}`}
        expanded={activeSurface !== null && contentReady}
        ref={surfaceRef}
        size={activeSurface !== null && contentReady ? openSize : closedSize}
      >
        <motion.div
          animate={{ opacity: activeSurface && contentReady ? 0 : 1 }}
          className="flex w-max shrink-0 flex-nowrap items-center gap-0.5 p-1"
          data-testid={`message-action-bloom-surface-${message.id}`}
          initial={false}
          ref={toolbarRef}
          style={{
            pointerEvents: activeSurface === null ? "auto" : "none",
          }}
          transition={{ duration: reduceMotion ? 0 : 0.1 }}
        >
          {hasReactionAction && quickReactionItems.length > 0 ? (
            <div className="hidden items-center gap-0.5 sm:flex">
              {quickReactionItems.map(({ customEmojiUrl, emoji }) => (
                <QuickReactionButton
                  customEmojiUrl={customEmojiUrl}
                  emoji={emoji}
                  key={emoji}
                  onSelect={handleReactionSelection}
                />
              ))}
            </div>
          ) : null}
          {hasReactionAction ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Open reactions"
                  className={ACTION_BUTTON_CLASS}
                  data-testid={`react-message-${message.id}`}
                  onClick={() => openSurface("reactions")}
                  ref={reactionTriggerRef}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <SmilePlus className={ACTION_ICON_CLASS} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>React</TooltipContent>
            </Tooltip>
          ) : null}

          {bestie && canCopyMessageLink(message, channelId) ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={`Send to ${bestie.name}`}
                  className={ACTION_BUTTON_CLASS}
                  data-testid={`send-to-bestie-${message.id}`}
                  onClick={() => openSurface("bestie")}
                  ref={bestieTriggerRef}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <ProfileAvatar
                    avatarUrl={bestie.avatarUrl}
                    className="size-4 text-3xs shadow-none"
                    label={bestie.name}
                    plain
                    testId={`bestie-action-avatar-${message.id}`}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Send to Bestie</TooltipContent>
            </Tooltip>
          ) : null}

          {hasReactionAction && quickReactionItems.length > 0 ? (
            <div
              aria-hidden="true"
              className="mx-0.5 hidden h-4 w-px bg-border/70 sm:block"
              data-testid="message-action-divider"
            />
          ) : null}

          {hasReplyAction ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Reply"
                  className={ACTION_BUTTON_CLASS}
                  data-testid={`reply-message-${message.id}`}
                  onClick={() => onReply?.(message)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <CornerUpLeft className={ACTION_ICON_CLASS} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reply</TooltipContent>
            </Tooltip>
          ) : null}

          {canCopyMessageLink(message, channelId) ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Copy link"
                  className={ACTION_BUTTON_CLASS}
                  data-testid={`copy-link-message-${message.id}`}
                  onClick={() => copyMessageLink(channelId, message)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Link2 className={ACTION_ICON_CLASS} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy link</TooltipContent>
            </Tooltip>
          ) : null}

          {hasMoreMenuActions ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="More actions"
                  className={ACTION_BUTTON_CLASS}
                  data-testid={`more-actions-${message.id}`}
                  onClick={() => openSurface("more")}
                  ref={moreTriggerRef}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <EllipsisVertical className={ACTION_ICON_CLASS} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>More actions</TooltipContent>
            </Tooltip>
          ) : null}
        </motion.div>

        <AnimatePresence initial={false}>
          {activeSurface === "reactions" ? (
            <motion.div
              animate={{
                filter: contentReady ? "blur(0px)" : "blur(6px)",
                opacity: contentReady ? 1 : 0,
                y: contentReady ? 0 : expansionDirection === "up" ? 8 : -8,
              }}
              className={cn(
                "absolute right-0",
                expansionDirection === "up" ? "bottom-0" : "top-0",
              )}
              data-testid={`reaction-bloom-panel-${message.id}`}
              exit={{
                filter: "blur(6px)",
                opacity: 0,
                y: expansionDirection === "up" ? 8 : -8,
              }}
              initial={false}
              key="reactions"
              ref={activeContentRef}
              style={{ pointerEvents: contentReady ? "auto" : "none" }}
              transition={{
                delay:
                  reduceMotion || !contentReady
                    ? 0
                    : 0.01 / MESSAGE_ACTION_BLOOM_SPEED_MULTIPLIER,
                duration: reduceMotion
                  ? 0
                  : 0.1 / MESSAGE_ACTION_BLOOM_SPEED_MULTIPLIER,
                ease: MESSAGE_ACTION_BLOOM_EASE_OUT,
              }}
            >
              {reactionErrorMessage ? (
                <div className="px-3 pb-0 pt-3">
                  <p className="text-xs text-destructive">
                    {reactionErrorMessage}
                  </p>
                </div>
              ) : null}
              <EmojiPicker
                autoFocus
                onSelect={(value) => handleReactionSelection(value, true)}
              />
            </motion.div>
          ) : null}

          {activeSurface === "bestie" &&
          bestie &&
          canCopyMessageLink(message, channelId) ? (
            <motion.div
              animate={{
                filter: contentReady ? "blur(0px)" : "blur(6px)",
                opacity: contentReady ? 1 : 0,
                y: contentReady ? 0 : expansionDirection === "up" ? 8 : -8,
              }}
              className={cn(
                "absolute right-0",
                expansionDirection === "up" ? "bottom-0" : "top-0",
              )}
              exit={{
                filter: "blur(6px)",
                opacity: 0,
                y: expansionDirection === "up" ? 8 : -8,
              }}
              initial={false}
              key="bestie"
              ref={activeContentRef}
              style={{ pointerEvents: contentReady ? "auto" : "none" }}
              transition={{
                delay:
                  reduceMotion || !contentReady
                    ? 0
                    : 0.01 / MESSAGE_ACTION_BLOOM_SPEED_MULTIPLIER,
                duration: reduceMotion
                  ? 0
                  : 0.1 / MESSAGE_ACTION_BLOOM_SPEED_MULTIPLIER,
                ease: MESSAGE_ACTION_BLOOM_EASE_OUT,
              }}
            >
              <BestieMessagePanel
                bestie={bestie}
                channelId={channelId}
                message={message}
                onClose={() => closeSurface()}
              />
            </motion.div>
          ) : null}

          {activeSurface === "more" ? (
            <motion.div
              animate={{
                filter: contentReady ? "blur(0px)" : "blur(6px)",
                opacity: contentReady ? 1 : 0,
                y: contentReady ? 0 : expansionDirection === "up" ? 8 : -8,
              }}
              className={cn(
                "absolute right-0",
                expansionDirection === "up" ? "bottom-0" : "top-0",
              )}
              exit={{
                filter: "blur(6px)",
                opacity: 0,
                y: expansionDirection === "up" ? 8 : -8,
              }}
              initial={false}
              key="more"
              ref={activeContentRef}
              style={{ pointerEvents: contentReady ? "auto" : "none" }}
              transition={{
                delay:
                  reduceMotion || !contentReady
                    ? 0
                    : 0.01 / MESSAGE_ACTION_BLOOM_SPEED_MULTIPLIER,
                duration: reduceMotion
                  ? 0
                  : 0.1 / MESSAGE_ACTION_BLOOM_SPEED_MULTIPLIER,
                ease: MESSAGE_ACTION_BLOOM_EASE_OUT,
              }}
            >
              <MoreActionsPanel
                channelId={channelId}
                isFollowingThread={isFollowingThread}
                isUnread={isUnread}
                message={message}
                onClose={() => closeSurface()}
                onDelete={onDelete}
                onEdit={onEdit}
                onFollowThread={onFollowThread}
                onMarkRead={onMarkRead}
                onMarkUnread={onMarkUnread}
                onRemindLater={onRemindLater}
                onSendToChannel={onSendToChannel}
                onUnfollowThread={onUnfollowThread}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </MessageActionBloomSurface>
    </div>
  );
});

MessageActionBar.displayName = "MessageActionBar";
