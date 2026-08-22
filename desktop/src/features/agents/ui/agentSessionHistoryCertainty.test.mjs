import assert from "node:assert/strict";
import test from "node:test";

import {
  getTranscriptHistoryCertainty,
  getUncertainHistoryCopy,
} from "./agentSessionHistoryCertainty.ts";

const complete = {
  hasSubscription: true,
  channelId: "channel-1",
  archiveHydrated: true,
};

test("a fully checked channel can state emptiness as fact", () => {
  assert.equal(getTranscriptHistoryCertainty(complete), "known-empty");
});

test("an unresolved subscription check is never a definitive empty", () => {
  assert.equal(
    getTranscriptHistoryCertainty({ ...complete, hasSubscription: null }),
    "unknown",
  );
});

test("a missing owner_p subscription is never a definitive empty", () => {
  assert.equal(
    getTranscriptHistoryCertainty({ ...complete, hasSubscription: false }),
    "unknown",
  );
});

test("an unhydrated archive is never a definitive empty", () => {
  assert.equal(
    getTranscriptHistoryCertainty({ ...complete, archiveHydrated: false }),
    "unknown",
  );
});

test("no channel means no archive was consulted", () => {
  assert.equal(
    getTranscriptHistoryCertainty({ ...complete, channelId: null }),
    "unknown",
  );
});

test("uncertain copy never claims there was no activity", () => {
  const cases = [
    { ...complete, hasSubscription: null },
    { ...complete, hasSubscription: false },
    { ...complete, archiveHydrated: false },
  ];
  for (const inputs of cases) {
    const copy = getUncertainHistoryCopy(inputs);
    const text = `${copy.title} ${copy.description}`.toLowerCase();
    assert.ok(!text.includes("no acp activity"), text);
    assert.ok(!text.includes("no activity"), text);
    assert.ok(copy.description.length > 0);
  }
});

test("uncertain copy names the specific gap", () => {
  assert.match(
    getUncertainHistoryCopy({ ...complete, hasSubscription: null }).title,
    /Checking/,
  );
  assert.match(
    getUncertainHistoryCopy({ ...complete, hasSubscription: false })
      .description,
    /isn't indexed/,
  );
  assert.match(
    getUncertainHistoryCopy({ ...complete, archiveHydrated: false })
      .description,
    /hasn't finished loading/,
  );
});
