import type { RelayEvent, SendChannelMessageResult } from "@/shared/api/types";

type ConfirmedReply =
  | Pick<RelayEvent, "created_at">
  | Pick<SendChannelMessageResult, "createdAt">;

export function markConfirmedThreadReplyRead(
  rootId: string | null,
  reply: ConfirmedReply,
  markThreadRead: (rootId: string, timestamp: number) => void,
): void {
  if (!rootId) return;
  const timestamp = "created_at" in reply ? reply.created_at : reply.createdAt;
  markThreadRead(rootId, timestamp);
}

export function markConfirmedInboxReplyRead(
  reply: Pick<SendChannelMessageResult, "createdAt" | "rootEventId">,
  markThreadRead: (rootId: string, timestamp: number) => void,
): void {
  markConfirmedThreadReplyRead(reply.rootEventId, reply, markThreadRead);
}

export async function sendThreadReplyWithReadBackstop<
  Reply extends ConfirmedReply,
>(
  send: Promise<Reply>,
  getRootId: (reply: Reply) => string | null,
  markThreadRead: (rootId: string, timestamp: number) => void,
): Promise<Reply> {
  const reply = await send;
  markConfirmedThreadReplyRead(getRootId(reply), reply, markThreadRead);
  return reply;
}
