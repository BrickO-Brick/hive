import type { ReactNode } from "react";

import { UserProfilePopover } from "@/features/profile/ui/UserProfilePopover";
import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { MessageTimestamp } from "./MessageTimestamp";

export function MessageAvatarProfile({
  author,
  children,
  pubkey,
  role,
}: {
  author: string;
  children: ReactNode;
  pubkey?: string;
  role?: string;
}) {
  if (!pubkey) {
    return children;
  }

  return (
    <UserProfilePopover botIdenticonValue={author} pubkey={pubkey} role={role}>
      <button
        className="flex shrink-0 items-start rounded-full focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        type="button"
      >
        {children}
      </button>
    </UserProfilePopover>
  );
}

export function MessageAvatarPosition({
  anchorToBubble = false,
  children,
}: {
  anchorToBubble?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={
        anchorToBubble
          ? "absolute bottom-0 right-full mr-2.5"
          : "flex shrink-0 items-start"
      }
      data-testid={
        anchorToBubble
          ? "message-bubble-avatar-anchor"
          : "message-avatar-gutter"
      }
    >
      {children}
    </div>
  );
}

export function MessageHoverTimestampGutter({
  createdAt,
  isThreadReplyLayout,
}: {
  createdAt: number;
  isThreadReplyLayout: boolean;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "relative flex w-9 shrink-0 items-start justify-end pt-0.5",
        isThreadReplyLayout ? "self-start" : "self-stretch",
      )}
    >
      <MessageTimestamp
        className="opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100"
        createdAt={createdAt}
        hideDayPeriod
      />
    </div>
  );
}

export function MessageHoverTimestamp({ createdAt }: { createdAt: number }) {
  return (
    <div
      className="message-hover-timestamp pointer-events-none flex shrink-0 items-center"
      data-testid="message-hover-timestamp"
    >
      <MessageTimestamp createdAt={createdAt} hideDayPeriod />
    </div>
  );
}

export function MessageStatusMetadata({
  className,
  edited = false,
  pending = false,
}: {
  className?: string;
  edited?: boolean;
  pending?: boolean;
}) {
  if (!pending && !edited) {
    return null;
  }

  return (
    <>
      {pending ? (
        <p
          className={cn("font-normal text-muted-foreground/70", className)}
          data-testid="message-send-status"
        >
          Sending…
        </p>
      ) : null}
      {edited ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <p className={cn("text-muted-foreground/70", className)}>
              (edited)
            </p>
          </TooltipTrigger>
          <TooltipContent>This message has been edited</TooltipContent>
        </Tooltip>
      ) : null}
    </>
  );
}

export function MessageBubbleStatusMetadata({
  edited = false,
  isOwn = false,
  pending = false,
}: {
  edited?: boolean;
  isOwn?: boolean;
  pending?: boolean;
}) {
  const ownMetadataClass = isOwn ? "text-primary-foreground/70!" : undefined;

  if (!pending && !edited) {
    return null;
  }

  return (
    <div
      className={cn(
        "mb-1 flex min-h-4 min-w-0 items-baseline gap-1.5 text-xs leading-message-author",
        isOwn && "justify-end",
      )}
      data-testid="message-bubble-status"
    >
      <MessageStatusMetadata
        className={ownMetadataClass}
        edited={edited}
        pending={pending}
      />
    </div>
  );
}
