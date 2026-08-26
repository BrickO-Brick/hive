import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  filterBuildAvailableFeatures,
  isFeatureBuildAvailable,
} from "./buildAvailability.ts";

const publicFeature = {
  id: "projects",
  name: "Projects",
  description: "",
};
const bestie = {
  id: "bestie",
  name: "Bestie",
  description: "",
  requiredBuildFlag: "bestie",
};

describe("feature build availability", () => {
  it("keeps features without a required build flag available", () => {
    assert.equal(
      isFeatureBuildAvailable(publicFeature, { bestie: false }),
      true,
    );
  });

  it("does not allow a required feature into an ineligible build", () => {
    assert.equal(isFeatureBuildAvailable(bestie, { bestie: false }), false);
  });

  it("shows a required feature when its build opts in", () => {
    assert.equal(isFeatureBuildAvailable(bestie, { bestie: true }), true);
  });

  it("filters unavailable features out of the experiment picker", () => {
    assert.deepEqual(
      filterBuildAvailableFeatures([publicFeature, bestie], { bestie: false }),
      [publicFeature],
    );
  });

  it("includes the Bestie experiment only in an eligible build", () => {
    assert.deepEqual(
      filterBuildAvailableFeatures([publicFeature, bestie], { bestie: true }),
      [publicFeature, bestie],
    );
  });
});
