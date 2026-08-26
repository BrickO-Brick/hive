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
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { useIdentityQuery } from "@/shared/api/hooks";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { VideoReviewCommentMarkdown } from "@/shared/ui/VideoReviewCommentMarkdown";

const ACTION_BUTTON_CLASS = "h-8 w-8 rounded-full p-0";

export function BestieMessagePopover({
  channelId,
  message,
  onOpenChange,
  open,
}: {
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
        align="end"
        className="w-[min(30rem,calc(100vw-2rem))] rounded-3xl p-0 shadow-xl"
        data-testid={`bestie-popover-${message.id}`}
        side="top"
        sideOffset={10}
      >
        <div className="space-y-3.5 p-4">
          <div className="flex items-center gap-2.5">
            <ProfileAvatar
              avatarUrl={bestie.avatarUrl}
              className="size-8 text-xs"
              label={bestie.name}
            />
            <p className="min-w-0 truncate text-sm font-semibold">Bestie</p>
          </div>

          <div
            className="rounded-2xl border border-border/60 bg-background px-3 py-3 shadow-md"
            data-testid={`bestie-message-snapshot-${message.id}`}
          >
            <div className="flex min-w-0 items-start gap-2.5">
              <UserAvatar
                avatarUrl={message.avatarUrl ?? null}
                className="size-7 shrink-0"
                displayName={message.author}
                size="sm"
              />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-baseline gap-1.5">
                  <p className="truncate text-xs font-semibold leading-4">
                    {message.author}
                  </p>
                  <p className="shrink-0 text-[10px] leading-4 text-muted-foreground/70">
                    {message.time}
                  </p>
                </div>
                <div className="mt-0.5 max-h-12 overflow-hidden">
                  <VideoReviewCommentMarkdown
                    className="line-clamp-3 text-xs leading-4 text-foreground/80 [&_p]:leading-4"
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
      </PopoverContent>
    </Popover>
  );
}
