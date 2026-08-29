// Thin wrapper — delegates all invariants to the shared merge-lane suite.
// Lane-specific differences: Manager class, outbox reader, watermark key,
// entry shape (starred field), and typed publish/getPending/fetchRemote methods.

import { readChannelStarsOutbox } from "./channelStarsStorage.ts";
import { ChannelStarSyncManager } from "./channelStarsSync.ts";
import { runMergeLaneSyncSuite } from "./mergeLaneSync.shared.test.mjs";

runMergeLaneSyncSuite({
  label: "stars",
  Manager: ChannelStarSyncManager,
  readOutbox: readChannelStarsOutbox,
  watermarkKind: "channel-stars",
  makeEntry: (starred, updatedAt, rev) => ({ starred, updatedAt, rev }),
  publish: (m, s) => m.publishStars(s),
  getPending: (m) => m.getPendingStarStore(),
  fetchRemote: (m) => m.fetchRemoteStars(),
});
