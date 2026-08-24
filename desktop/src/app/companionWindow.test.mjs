import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { companionWindowKindForLabel } from "./companionWindow.ts";

describe("companionWindowKindForLabel", () => {
  it("classifies focused companion labels", () => {
    assert.equal(
      companionWindowKindForLabel("agent-activity-deadbeef-channel"),
      "agent-activity",
    );
    assert.equal(companionWindowKindForLabel("huddle-channel-id"), "huddle");
  });

  it("leaves primary and unrelated windows unclassified", () => {
    assert.equal(companionWindowKindForLabel("main"), null);
    assert.equal(companionWindowKindForLabel("reader-document"), null);
  });
});
