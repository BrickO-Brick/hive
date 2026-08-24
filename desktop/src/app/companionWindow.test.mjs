import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  acceptsNativeDeepLinks,
  companionWindowKindForLabel,
} from "./companionWindow.ts";

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

describe("acceptsNativeDeepLinks", () => {
  it("reserves the pending-link queue for the main realm", () => {
    assert.equal(acceptsNativeDeepLinks(null), true);
    assert.equal(acceptsNativeDeepLinks("huddle"), false);
    assert.equal(acceptsNativeDeepLinks("agent-activity"), false);
  });
});
