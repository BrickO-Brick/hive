import {
  resolveUserLabel,
  type UserProfileLookup,
} from "@/features/profile/lib/identity";
import { formatDmParticipantDisplayName } from "@/features/channels/lib/dmParticipantDisplay";
import type { Channel } from "@/shared/api/types";

function isGenericDmChannelName(name: string) {
  const normalized = name.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized === "dm" ||
    normalized === "direct message" ||
    normalized === "direct messages" ||
    /^group dm\s*(\(\d+\))?$/.test(normalized)
  );
}

export function resolveChannelDisplayLabel(
  channel: Channel,
  currentPubkey: string | undefined,
  profiles: UserProfileLookup | undefined,
) {
  if (channel.channelType !== "dm" || !isGenericDmChannelName(channel.name)) {
    return channel.name;
  }

  const participants = channel.participantPubkeys.map((pubkey, index) => ({
    fallbackName: channel.participants[index] ?? null,
    pubkey,
  }));
  const otherParticipants = currentPubkey
    ? participants.filter(
        (participant) =>
          participant.pubkey.toLowerCase() !== currentPubkey.toLowerCase(),
      )
    : participants;
  const resolvedLabels = (
    otherParticipants.length > 0 ? otherParticipants : participants
  ).map((participant) =>
    resolveUserLabel({
      currentPubkey,
      fallbackName: participant.fallbackName,
      profiles,
      pubkey: participant.pubkey,
    }),
  );
  const uniqueLabels = [...new Set(resolvedLabels)];

  return uniqueLabels.length > 0
    ? formatDmParticipantDisplayName(
        uniqueLabels.map((displayName) => ({ displayName })),
      )
    : channel.name;
}

export function resolveChannelSidebarSubtitle(channel: Channel): string {
  const description = channel.description.trim();
  if (description) return description;

  const typeLabel = channel.channelType === "forum" ? "forum" : "channel";
  return channel.visibility === "private"
    ? `Private ${typeLabel}`
    : `Open ${typeLabel}`;
}
