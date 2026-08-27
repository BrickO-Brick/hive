import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAddressableCoordinate } from "./addressableCoordinate.ts";

const OWNER = "a".repeat(64);

test("parseAddressableCoordinate splits only the two structural separators", () => {
  assert.deepEqual(parseAddressableCoordinate(`30617:${OWNER}:a:b`), {
    kind: 30617,
    owner: OWNER,
    dtag: "a:b",
  });
  assert.deepEqual(
    parseAddressableCoordinate(`30617:${OWNER.toUpperCase()}:repo`)?.owner,
    OWNER,
  );
});

test("parseAddressableCoordinate rejects malformed coordinates", () => {
  for (const address of [
    null,
    undefined,
    "",
    OWNER,
    `30617:${OWNER}`,
    `30617:not-a-pubkey:repo`,
    `30617:${OWNER}:`,
    `:${OWNER}:repo`,
    `notakind:${OWNER}:repo`,
  ]) {
    assert.equal(parseAddressableCoordinate(address), null, String(address));
  }
});
