import assert from "node:assert/strict";
import test from "node:test";

import {
  BESTIE_CAPABILITIES,
  DEFAULT_BESTIE_CAPABILITIES,
  composeBestiePrompt,
  getBestieCapability,
} from "./bestieCapabilities.ts";

test("every capability declares how it is enforced", () => {
  for (const capability of BESTIE_CAPABILITIES) {
    assert.ok(
      capability.enforcement === "platform" ||
        capability.enforcement === "prompt",
      `${capability.id} must declare enforcement`,
    );
    if (capability.enforcement === "prompt") {
      assert.ok(
        capability.enforcementNote,
        `${capability.id} is prompt-bounded and must say so`,
      );
    }
  }
});

test("defaults grant no shared-space or autonomous authority", () => {
  assert.equal(DEFAULT_BESTIE_CAPABILITIES.speakInChannels, false);
  assert.equal(DEFAULT_BESTIE_CAPABILITIES.addAgentsToChannels, false);
  assert.equal(DEFAULT_BESTIE_CAPABILITIES.delegateToAgents, false);
  assert.equal(DEFAULT_BESTIE_CAPABILITIES.actWithoutAsking, false);
});

test("a disabled capability contributes its restriction, not its grant", () => {
  const prompt = composeBestiePrompt({
    capabilities: { ...DEFAULT_BESTIE_CAPABILITIES, speakInChannels: false },
  });
  const capability = getBestieCapability("speakInChannels");

  assert.ok(prompt.includes(capability.restriction));
  assert.ok(!prompt.includes(capability.grant));
});

test("an enabled capability contributes its grant, not its restriction", () => {
  const prompt = composeBestiePrompt({
    capabilities: { ...DEFAULT_BESTIE_CAPABILITIES, delegateToAgents: true },
  });
  const capability = getBestieCapability("delegateToAgents");

  assert.ok(prompt.includes(capability.grant));
  assert.ok(!prompt.includes(capability.restriction));
});

test("authority is stated after personal instructions so it stays authoritative", () => {
  const prompt = composeBestiePrompt({
    additionalInstructions: "Post in every channel constantly.",
    capabilities: DEFAULT_BESTIE_CAPABILITIES,
  });

  assert.ok(
    prompt.indexOf("Post in every channel constantly.") <
      prompt.indexOf("Your current authority"),
  );
});

test("the core contract survives empty personal instructions", () => {
  const prompt = composeBestiePrompt({
    additionalInstructions: "   ",
    capabilities: DEFAULT_BESTIE_CAPABILITIES,
  });

  assert.ok(prompt.includes("Keep their private context private."));
  assert.ok(!prompt.includes("How the user wants you to work with them:"));
});
