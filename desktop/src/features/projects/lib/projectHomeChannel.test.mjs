import assert from "node:assert/strict";
import test from "node:test";

import { isProjectHomeChannel } from "./projectHomeChannel.ts";

test("isProjectHomeChannel is true when a project points at the channel", () => {
  assert.equal(
    isProjectHomeChannel("channel-a", [
      { projectChannelId: "channel-a" },
      { projectChannelId: "channel-b" },
    ]),
    true,
  );
});

test("isProjectHomeChannel is false for unbound channels", () => {
  assert.equal(
    isProjectHomeChannel("channel-z", [{ projectChannelId: "channel-a" }]),
    false,
  );
  assert.equal(
    isProjectHomeChannel(null, [{ projectChannelId: "channel-a" }]),
    false,
  );
});
