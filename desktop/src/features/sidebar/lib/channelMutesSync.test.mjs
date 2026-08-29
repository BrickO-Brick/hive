// Thin wrapper — delegates all invariants to the shared merge-lane suite.
// Lane-specific differences: Manager class, outbox reader, watermark key,
// entry shape (muted field), and typed publish/getPending/fetchRemote methods.

import { readChannelMutesOutbox } from "./channelMutesStorage.ts";
import { ChannelMuteSyncManager } from "./channelMutesSync.ts";
import { runMergeLaneSyncSuite } from "./mergeLaneSync.shared.test.mjs";

runMergeLaneSyncSuite({
  label: "mutes",
  Manager: ChannelMuteSyncManager,
  readOutbox: readChannelMutesOutbox,
  watermarkKind: "channel-mutes",
  makeEntry: (muted, updatedAt, rev) => ({ muted, updatedAt, rev }),
  publish: (m, s) => m.publishMutes(s),
  getPending: (m) => m.getPendingMuteStore(),
  fetchRemote: (m) => m.fetchRemoteMutes(),
});
