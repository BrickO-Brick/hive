import * as React from "react";
import { toast } from "sonner";

import { pickBestieAgent } from "@/features/agents/lib/bestie";
import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { useOpenDmMutation } from "@/features/channels/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import { buildMessageLink } from "@/features/messages/lib/messageLink";
import { getThreadReference } from "@/features/messages/lib/threading";
import { useSendMessageMutation } from "@/features/messages/hooks";
import type { TimelineMessage } from "@/features/messages/types";
import { MessageComposer } from "@/features/messages/ui/MessageComposer";
import { MessageActionBloomSurface } from "@/features/messages/ui/MessageActionBloomSurface";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { useIdentityQuery } from "@/shared/api/hooks";
import { Button } from "@/shared/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/shared/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { VideoReviewCommentMarkdown } from "@/shared/ui/VideoReviewCommentMarkdown";

const ACTION_BUTTON_CLASS = "h-8 w-8 rounded-full p-0";

export function BestieMessagePopover({
  anchorRef,
  channelId,
  message,
  onOpenChange,
  open,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  channelId: string;
  message: TimelineMessage;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { activeCommunity } = useCommunities();
  const identityQuery = useIdentityQuery();
  const managedAgentsQuery = useManagedAgentsQuery();
  const openDmMutation = useOpenDmMutation();
  const sendMessageMutation = useSendMessageMutation(null, identityQuery.data);
  const bestie = React.useMemo(
    () =>
      pickBestieAgent(managedAgentsQuery.data ?? [], activeCommunity?.relayUrl),
    [activeCommunity?.relayUrl, managedAgentsQuery.data],
  );
  const isPending = openDmMutation.isPending || sendMessageMutation.isPending;

  if (!bestie) return null;

  const submit = async (
    note: string,
    mentionPubkeys: string[],
    mediaTags?: string[][],
  ) => {
    const { rootId } = getThreadReference(message.tags ?? []);
    const link = buildMessageLink({
      channelId,
      messageId: message.id,
      threadRootId: rootId,
    });
    const trimmedNote = note.trim();
    const content = [trimmedNote, `[Open original message](${link})`]
      .filter(Boolean)
      .join("\n\n");

    try {
      const dm = await openDmMutation.mutateAsync({
        pubkeys: [bestie.pubkey],
        expectedRelayUrl: activeCommunity?.relayUrl,
        expectedSignerPubkey: identityQuery.data?.pubkey,
      });
      await sendMessageMutation.mutateAsync({
        content,
        mediaTags,
        mentionPubkeys,
        targetChannel: dm,
      });
      onOpenChange(false);
      toast.success(`Sent to ${bestie.name}`);
    } catch (error) {
      console.error("Failed to send message to Bestie", error);
      toast.error(`Couldn't send to ${bestie.name}`);
      throw error;
    }
  };

  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <PopoverAnchor virtualRef={anchorRef} />
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              aria-label={`Send to ${bestie.name}`}
              className={ACTION_BUTTON_CLASS}
              data-testid={`send-to-bestie-${message.id}`}
              size="sm"
              type="button"
              variant={open ? "secondary" : "ghost"}
            >
              <ProfileAvatar
                avatarUrl={bestie.avatarUrl}
                className="size-4 text-[7px] shadow-none"
                label={bestie.name}
                plain
                testId={`bestie-action-avatar-${message.id}`}
              />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Send to Bestie</TooltipContent>
      </Tooltip>
      <PopoverContent
        asChild
        align="end"
        className="data-[state=closed]:animate-none data-[state=open]:animate-none"
        side="top"
        sideOffset={2}
      >
        <MessageActionBloomSurface
          className="w-[min(328px,calc(100vw-2rem))] p-4"
          data-testid={`bestie-popover-${message.id}`}
        >
          <div className="space-y-3.5">
            <div className="flex items-center gap-2.5">
              <ProfileAvatar
                avatarUrl={bestie.avatarUrl}
                className="size-8 text-xs"
                label={bestie.name}
              />
              <p className="min-w-0 truncate text-sm font-semibold">Bestie</p>
            </div>

            <div
              className="w-3/4 overflow-hidden rounded-xl border border-border/60 bg-background p-2.5 shadow-sm"
              data-testid={`bestie-message-snapshot-${message.id}`}
            >
              <div className="flex min-w-0 items-start gap-2">
                <UserAvatar
                  avatarUrl={message.avatarUrl ?? null}
                  className="size-6 shrink-0"
                  displayName={message.author}
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-baseline gap-1">
                    <p className="truncate text-[10px] font-semibold leading-3.5">
                      {message.author}
                    </p>
                    <p className="shrink-0 text-[9px] leading-3.5 text-muted-foreground/70">
                      {message.time}
                    </p>
                  </div>
                  <div
                    className="mt-0.5 max-h-3.5 overflow-hidden"
                    data-testid={`bestie-message-snapshot-body-${message.id}`}
                  >
                    <VideoReviewCommentMarkdown
                      className="line-clamp-1 text-[10px] leading-3.5 text-foreground/80 [&_p]:leading-3.5"
                      content={message.body}
                      interactive={false}
                      messageId={message.id}
                    />
                  </div>
                </div>
              </div>
            </div>

            <MessageComposer
              allowEmptySend
              channelName="Bestie"
              channelType="dm"
              containerClassName="px-0 pb-0"
              disabled={isPending}
              draftKey={`bestie-share:${message.id}`}
              isSending={isPending}
              onSend={submit}
              placeholder="Add a note (optional)"
              showBackgroundUploadProgress={false}
            />
          </div>
        </MessageActionBloomSurface>
      </PopoverContent>
    </Popover>
  );
}
