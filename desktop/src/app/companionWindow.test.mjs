import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  acceptsNativeDeepLinks,
  companionCommunityBootstrap,
  companionCommunityIdForHash,
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

describe("companionCommunityBootstrap", () => {
  it("lets huddle companions boot through normal community selection", () => {
    assert.deepEqual(companionCommunityBootstrap("huddle", ""), {
      initialActiveCommunityId: undefined,
      missingRequiredCommunity: false,
    });
  });

  it("rejects agent activity companions without community context", () => {
    assert.deepEqual(companionCommunityBootstrap("agent-activity", ""), {
      initialActiveCommunityId: undefined,
      missingRequiredCommunity: true,
    });
  });

  it("pins agent activity companions to their encoded community", () => {
    assert.deepEqual(
      companionCommunityBootstrap(
        "agent-activity",
        "#/channels/channel?community=community-one",
      ),
      {
        initialActiveCommunityId: "community-one",
        missingRequiredCommunity: false,
      },
    );
  });
});

describe("companionCommunityIdForHash", () => {
  it("reads and decodes immutable community identity from the route", () => {
    assert.equal(
      companionCommunityIdForHash(
        "#/channels/channel?community=community+%26+one&agentSession=agent",
      ),
      "community & one",
    );
  });

  it("returns null when the bootstrap contract is absent", () => {
    assert.equal(companionCommunityIdForHash("#/channels/channel"), null);
  });
});
