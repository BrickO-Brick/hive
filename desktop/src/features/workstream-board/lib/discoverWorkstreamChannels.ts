import type { Channel } from "@/shared/api/types";

/**
 * Channels whose name starts with this prefix are discovered as workstream
 * board entries. There is no creator/ownership filter — any visible,
 * non-archived channel matching the prefix is included, regardless of who
 * created or joined it.
 */
export const WORKSTREAM_CHANNEL_PREFIX = "loganj-ws-";

export function filterWorkstreamChannels(
  channels: readonly Channel[],
): Channel[] {
  return channels.filter(
    (channel) =>
      channel.name.startsWith(WORKSTREAM_CHANNEL_PREFIX) &&
      channel.archivedAt === null,
  );
}
