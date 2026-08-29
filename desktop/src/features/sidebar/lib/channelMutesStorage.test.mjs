import {
  boundMuteStore,
  DEFAULT_STORE,
  isMutesStoreSubsumedBy,
  MAX_CHANNEL_MUTE_ENTRIES,
  mergeStores,
  parseMutePayload,
  mutedChannelIdsFromStore,
  readChannelMutesStore,
  storageKey,
  writeChannelMutesStore,
} from "./channelMutesStorage.ts";
import { normalizeRelayUrl } from "@/shared/lib/normalizeRelayUrl";
import { runMergeLaneStorageSuite } from "./mergeLaneStorage.shared.test.mjs";

runMergeLaneStorageSuite({
  label: "mutes",
  storageKeyPrefix: "buzz-channel-mutes.v1",
  MAX_ENTRIES: MAX_CHANNEL_MUTE_ENTRIES,
  DEFAULT_STORE,
  parsePayload: parseMutePayload,
  makeEntry: (v, updatedAt, rev) => ({ muted: v, updatedAt, rev }),
  entryValueField: "muted",
  trueLabel: "mute",
  falseLabel: "unmute",
  boundStore: boundMuteStore,
  mergeStores,
  readStore: readChannelMutesStore,
  writeStore: writeChannelMutesStore,
  storageKey,
  normalizeRelayUrl,
});
