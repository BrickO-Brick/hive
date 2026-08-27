import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { protectedFeatureDefinitions as internalDefinitions } from "./internal.ts";
import { protectedFeatureDefinitions as publicDefinitions } from "./public.ts";

describe("protected feature build variants", () => {
  it("keeps protected definitions out of the OSS module", () => {
    assert.deepEqual(publicDefinitions, []);
  });

  it("adds Bestie only through the internal module", () => {
    assert.deepEqual(
      internalDefinitions.map((feature) => feature.id),
      ["bestie"],
    );
    assert.equal(internalDefinitions[0]?.defaultEnabled, undefined);
  });
});
