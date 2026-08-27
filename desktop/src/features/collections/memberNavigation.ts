import {
  buildChannelLink,
  parseChannelLink,
} from "@/features/messages/lib/channelLink";
import {
  buildMessageLink,
  parseMessageLink,
} from "@/features/messages/lib/messageLink";
import { parseAddressableCoordinate } from "@/shared/lib/addressableCoordinate";
import { KIND_REPO_ANNOUNCEMENT } from "@/shared/constants/kinds";
import {
  buildIssueLink,
  buildRepoLink,
  isLinkableCoordinate,
  parseEntityLink,
} from "@/shared/lib/entityLink";

import type { CollectionReference } from "./types";

export type CollectionMemberNavigationTarget =
  | { kind: "channel"; channelId: string }
  | {
      kind: "message";
      channelId: string;
      messageId: string;
      threadRootId: string | null;
    }
  | {
      kind: "entity";
      entity: Extract<
        ReturnType<typeof parseEntityLink>,
        { ok: true }
      >["value"];
    }
  | { kind: "external"; url: string };

/** Resolve only references backed by an existing Buzz route/deep link. */
export function collectionMemberNavigationTarget(
  reference: CollectionReference,
): CollectionMemberNavigationTarget | null {
  try {
    return resolveCollectionMemberNavigationTarget(reference);
  } catch {
    // Locally persisted references may predate current deep-link validation.
    return null;
  }
}

function resolveCollectionMemberNavigationTarget(
  reference: CollectionReference,
): CollectionMemberNavigationTarget | null {
  if (reference.type === "external") {
    return { kind: "external", url: reference.url };
  }
  if (reference.type === "channel") {
    const parsed = parseChannelLink(buildChannelLink(reference.channel_id));
    return parsed.ok
      ? { kind: "channel", channelId: parsed.value.channelId }
      : null;
  }
  if (reference.type === "message" || reference.type === "thread") {
    const messageId =
      reference.type === "message"
        ? reference.event_id
        : reference.root_event_id;
    const parsed = parseMessageLink(
      buildMessageLink({
        channelId: reference.channel_id,
        messageId,
        threadRootId:
          reference.type === "thread" ? reference.root_event_id : null,
      }),
    );
    return parsed.ok
      ? {
          kind: "message",
          channelId: parsed.value.channelId,
          messageId: parsed.value.messageId,
          threadRootId: parsed.value.threadRootId,
        }
      : null;
  }
  if (reference.type !== "repository" && reference.type !== "task") {
    // Notes do not yet have a desktop route or supported deep-link format.
    return null;
  }

  const address =
    reference.type === "repository"
      ? reference.coordinate
      : reference.repository;
  const coordinate = parseAddressableCoordinate(address);
  if (
    !coordinate ||
    coordinate.kind !== KIND_REPO_ANNOUNCEMENT ||
    !isLinkableCoordinate(coordinate.owner, coordinate.dtag)
  ) {
    return null;
  }
  const href =
    reference.type === "repository"
      ? buildRepoLink(coordinate)
      : buildIssueLink({ ...coordinate, id: reference.event_id });
  const parsed = parseEntityLink(href);
  return parsed.ok ? { kind: "entity", entity: parsed.value } : null;
}
