import assert from "node:assert/strict";
import test from "node:test";

import { recordTypingCompletion } from "./useChannelTyping.ts";

const TYPING_KEY = "agent:thread";
const NOW = 2_000_000_000_000;
const NOW_SECONDS = NOW / 1_000;

function makeState() {
  return {
    latestMessageCreatedAtByPubkey: {},
    suppressUntilByPubkey: {},
  };
}

function record(state, createdAt) {
  return recordTypingCompletion({
    createdAt,
    latestMessageCreatedAtByPubkey: state.latestMessageCreatedAtByPubkey,
    now: NOW,
    suppressUntilByPubkey: state.suppressUntilByPubkey,
    typingKey: TYPING_KEY,
  });
}

test("duplicate full-array replay does not reprocess completion events", () => {
  const state = makeState();

  assert.equal(record(state, NOW_SECONDS), true);
  assert.equal(record(state, NOW_SECONDS), false);
  assert.deepEqual(state.latestMessageCreatedAtByPubkey, {
    [TYPING_KEY]: NOW_SECONDS,
  });
  assert.deepEqual(state.suppressUntilByPubkey, {
    [TYPING_KEY]: NOW + 2_000,
  });
});

test("newer-then-older completion arrival keeps the newer watermark", () => {
  const state = makeState();

  assert.equal(record(state, NOW_SECONDS), true);
  assert.equal(record(state, NOW_SECONDS - 1), false);
  assert.equal(state.latestMessageCreatedAtByPubkey[TYPING_KEY], NOW_SECONDS);
  assert.equal(state.suppressUntilByPubkey[TYPING_KEY], NOW + 2_000);
});

test("older-then-newer completion arrival advances the watermark", () => {
  const state = makeState();

  assert.equal(record(state, NOW_SECONDS - 1), true);
  assert.equal(record(state, NOW_SECONDS), true);
  assert.equal(state.latestMessageCreatedAtByPubkey[TYPING_KEY], NOW_SECONDS);
  assert.equal(state.suppressUntilByPubkey[TYPING_KEY], NOW + 2_000);
});

test("historical thread load creates neither a watermark nor fresh suppression", () => {
  const state = makeState();

  assert.equal(record(state, NOW_SECONDS - 60), false);
  assert.deepEqual(state.latestMessageCreatedAtByPubkey, {});
  assert.deepEqual(state.suppressUntilByPubkey, {});
});
