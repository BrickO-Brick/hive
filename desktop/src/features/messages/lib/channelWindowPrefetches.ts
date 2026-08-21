const inFlight = new Set<string>();

/**
 * Tracks channels whose message window is being warmed by a hover prefetch.
 *
 * A prefetch reaches the relay before the channel's live subscription exists,
 * so its snapshot can miss events that land in between; the post-subscribe
 * refresh must replace it rather than dedupe onto it. A cold mount fetch is
 * parked on the persisted-head gate and has not reached the relay yet, so it
 * carries no such gap and still dedupes. Nothing else distinguishes the two
 * in-flight fetches from `refreshChannelWindowMessages`.
 */
export function markChannelPrefetchStarted(channelId: string): void {
  inFlight.add(channelId);
}

export function markChannelPrefetchSettled(channelId: string): void {
  inFlight.delete(channelId);
}

export function hasInFlightChannelPrefetch(channelId: string): boolean {
  return inFlight.has(channelId);
}

/** Community-scoped: cleared by `resetCommunityState`. */
export function resetChannelWindowPrefetches(): void {
  inFlight.clear();
}
