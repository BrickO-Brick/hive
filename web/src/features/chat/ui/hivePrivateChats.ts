import {
  type NostrEvent,
  publishEvent,
  queryEventsHttp,
} from "@/shared/lib/nostr-client";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import { relayWsUrl } from "@/shared/lib/relay-url";
import {
  conversationsFromMetadata,
  type HiveConversation,
} from "./discussionMessages";

function detailsFromDmAck(message: string): {
  channelId: string;
  name: string | null;
} | null {
  const encoded = message.startsWith("response:")
    ? message.slice("response:".length)
    : "";
  try {
    const payload = JSON.parse(encoded) as {
      channel_id?: unknown;
      name?: unknown;
    };
    const channelId = payload.channel_id;
    return typeof channelId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        channelId,
      )
      ? {
          channelId,
          name:
            typeof payload.name === "string" && payload.name.trim()
              ? payload.name.trim()
              : null,
        }
      : null;
  } catch {
    return null;
  }
}

export async function loadPrivateChats(
  currentPubkey: string,
): Promise<HiveConversation[]> {
  const metadata: NostrEvent[] = [];
  let cursor: { beforeId: string; until: number } | null = null;
  for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
    const page = await queryEventsHttp([
      {
        kinds: [39000],
        "#p": [currentPubkey],
        limit: 200,
        ...(cursor ? { before_id: cursor.beforeId, until: cursor.until } : {}),
      },
    ]);
    metadata.push(...page);
    if (page.length < 200) break;
    const oldest = [...page].sort(
      (left, right) =>
        right.created_at - left.created_at || left.id.localeCompare(right.id),
    )[page.length - 1];
    if (!oldest) break;
    cursor = { beforeId: oldest.id, until: oldest.created_at };
  }
  return conversationsFromMetadata(metadata, currentPubkey);
}

export function togglePrivateChatParticipant(
  current: Set<string>,
  pubkey: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(pubkey)) next.delete(pubkey);
  else if (next.size < 8) next.add(pubkey);
  return next;
}

export async function createPrivateChat({
  currentPubkey,
  participantPubkeys,
  title,
}: {
  currentPubkey: string;
  participantPubkeys: string[];
  title: string;
}): Promise<HiveConversation> {
  const signed = await signNostrEvent({
    kind: 41010,
    tags: [
      ...participantPubkeys.map((pubkey) => ["p", pubkey]),
      ["d", crypto.randomUUID()],
      ["name", title],
    ],
    content: "",
  });
  const acknowledgment = await publishEvent(relayWsUrl(), signed);
  const details = detailsFromDmAck(acknowledgment.message);
  if (!details) {
    throw new Error(
      "Hive created the private chat but did not return its channel ID. Refresh chats before retrying.",
    );
  }
  return {
    createdAt: Math.floor(Date.now() / 1000),
    id: details.channelId,
    participantPubkeys: [currentPubkey, ...participantPubkeys],
    title: details.name ?? title,
  };
}
