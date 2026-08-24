import assert from "node:assert/strict";
import test from "node:test";

import { getValidatedRouteThreadRootId } from "./ChannelRouteScreen.tsx";

function event(id, tags = [["h", "channel"]]) {
  return {
    id,
    pubkey: "author",
    created_at: 1,
    kind: 9,
    tags,
    content: "hello",
    sig: "signature",
  };
}

test("a top-level route only accepts its own id as thread root", () => {
  const target = event("target");
  assert.equal(getValidatedRouteThreadRootId(target, "target"), "target");
  assert.equal(getValidatedRouteThreadRootId(target, "unrelated"), null);
  assert.equal(getValidatedRouteThreadRootId(target, null), null);
});

test("a reply route derives its containing root", () => {
  const target = event("reply", [
    ["h", "channel"],
    ["e", "root", "", "root"],
    ["e", "root", "", "reply"],
  ]);
  assert.equal(getValidatedRouteThreadRootId(target, null), "root");
});
