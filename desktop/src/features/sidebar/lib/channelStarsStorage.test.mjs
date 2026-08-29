import {
  boundStarStore,
  DEFAULT_STORE,
  isStarsStoreSubsumedBy,
  MAX_CHANNEL_STAR_ENTRIES,
  mergeStores,
  parseStarPayload,
  readChannelStarsStore,
  starredChannelIdsFromStore,
  storageKey,
  writeChannelStarsStore,
} from "./channelStarsStorage.ts";
import { normalizeRelayUrl } from "@/shared/lib/normalizeRelayUrl";
import { runMergeLaneStorageSuite } from "./mergeLaneStorage.shared.test.mjs";

runMergeLaneStorageSuite({
  label: "stars",
  storageKeyPrefix: "buzz-channel-stars.v1",
  MAX_ENTRIES: MAX_CHANNEL_STAR_ENTRIES,
  DEFAULT_STORE,
  parsePayload: parseStarPayload,
  makeEntry: (v, updatedAt, rev) => ({ starred: v, updatedAt, rev }),
  entryValueField: "starred",
  trueLabel: "star",
  falseLabel: "unstar",
  boundStore: boundStarStore,
  mergeStores,
  readStore: readChannelStarsStore,
  writeStore: writeChannelStarsStore,
  storageKey,
  normalizeRelayUrl,
});
