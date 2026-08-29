import {
  MAX_CHANNEL_MUTE_ENTRIES,
  readChannelMutesStore,
  storageKey,
} from "./channelMutesStorage.ts";
import { useChannelMutes } from "./useChannelMutes.ts";
import { runMergeLaneHookSuite } from "./mergeLaneHook.shared.test.mjs";

runMergeLaneHookSuite({
  label: "mutes",
  entryValueField: "muted",
  idsField: "mutedChannelIds",
  trueAction: "muteChannel",
  falseAction: "unmuteChannel",
  dTag: "channel-mutes",
  outboxKeyPrefix: "buzz-channel-mutes-outbox.v1",
  MAX_ENTRIES: MAX_CHANNEL_MUTE_ENTRIES,
  readStore: readChannelMutesStore,
  storageKey,
  useHook: useChannelMutes,
  makePayload: (channels) => JSON.stringify({ version: 1, channels }),
});
