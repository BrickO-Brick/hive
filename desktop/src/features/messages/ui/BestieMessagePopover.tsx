import * as React from "react";
import { Send } from "lucide-react";
import { toast } from "sonner";

import { pickBestieAgent } from "@/features/agents/lib/bestie";
import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { useOpenDmMutation } from "@/features/channels/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import { buildMessageLink } from "@/features/messages/lib/messageLink";
import { getThreadReference } from "@/features/messages/lib/threading";
import { useSendMessageMutation } from "@/features/messages/hooks";
import type { TimelineMessage } from "@/features/messages/types";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { useIdentityQuery } from "@/shared/api/hooks";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Textarea } from "@/shared/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

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
  const [note, setNote] = React.useState("");
  const bestie = React.useMemo(
    () =>
      pickBestieAgent(managedAgentsQuery.data ?? [], activeCommunity?.relayUrl),
    [activeCommunity?.relayUrl, managedAgentsQuery.data],
  );
  const isPending = openDmMutation.isPending || sendMessageMutation.isPending;

  if (!bestie) return null;

  const submit = async () => {
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
        targetChannel: dm,
      });
      setNote("");
      onOpenChange(false);
      toast.success(`Sent to ${bestie.name}`);
    } catch (error) {
      console.error("Failed to send message to Bestie", error);
      toast.error(`Couldn't send to ${bestie.name}`);
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
        className="w-[min(22rem,calc(100vw-2rem))] rounded-2xl p-0 shadow-lg"
        data-testid={`bestie-popover-${message.id}`}
        side="top"
        sideOffset={10}
      >
        <form
          className="space-y-4 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex items-center gap-2.5">
            <ProfileAvatar
              avatarUrl={bestie.avatarUrl}
              className="size-8 text-xs"
              label={bestie.name}
            />
            <div className="min-w-0">
              <p className="text-sm font-semibold">Send to Bestie</p>
              <p className="truncate text-xs text-muted-foreground">
                Share this message with {bestie.name}
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-border/70 bg-muted/45 px-3 py-2.5">
            <p className="line-clamp-3 text-sm leading-5 text-foreground/80">
              {message.body}
            </p>
          </div>

          <Textarea
            aria-label="Note for Bestie"
            autoFocus
            className="min-h-24 resize-none"
            disabled={isPending}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Add a note (optional)"
            value={note}
          />

          <div className="flex justify-end gap-2">
            <Button
              disabled={isPending}
              onClick={() => onOpenChange(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button disabled={isPending} size="sm" type="submit">
              <Send aria-hidden className="size-4" />
              {isPending ? "Sending…" : "Send"}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
