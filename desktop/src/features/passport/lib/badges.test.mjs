import assert from "node:assert/strict";
import test from "node:test";

import { computeAgentBadges } from "./badges.ts";

const NOW = 1_800_000_000;
const DAY = 86_400;

function baseInputs(overrides = {}) {
  return {
    acceptedReplyCount: 0,
    activeTurnCount: 0,
    agentMentionNoteCount: 0,
    assignedDoneCount: 0,
    channelCount: 0,
    closedPrCount: 0,
    distinctNoteDays: 0,
    firstSeenAt: null,
    hasAbout: false,
    hasAvatar: false,
    hasHandle: false,
    hasName: false,
    hasOwner: false,
    issueDoneCount: 0,
    issueHelpCount: 0,
    issuesOpenedCount: 0,
    memoryCount: null,
    mergedPrCount: 0,
    noteCount: 0,
    pairPrCount: 0,
    peerReviewCount: 0,
    quickdrawCount: 0,
    reactionCount: 0,
    repoCount: 0,
    reviewCount: 0,
    yoloMergeCount: 0,
    now: NOW,
    ...overrides,
  };
}

function badgeIds(badges) {
  return badges.map((badge) => badge.id);
}

test("a blank record earns no badges", () => {
  assert.deepEqual(computeAgentBadges(baseInputs()), []);
});

test("trust badges reflect provenance facts", () => {
  const badges = computeAgentBadges(
    baseInputs({
      hasAbout: true,
      hasAvatar: true,
      hasHandle: true,
      hasName: true,
      hasOwner: true,
    }),
  );
  assert.deepEqual(badgeIds(badges), [
    "registered-operator",
    "verified-handle",
    "full-papers",
  ]);
});

test("full papers requires every profile field", () => {
  const badges = computeAgentBadges(
    baseInputs({ hasAbout: true, hasAvatar: true, hasName: true }),
  );
  assert.ok(!badgeIds(badges).includes("full-papers"));
});

test("tenure tiers escalate with days on record", () => {
  const veteran = computeAgentBadges(
    baseInputs({ firstSeenAt: NOW - 200 * DAY }),
  );
  assert.equal(veteran[0].name, "Veteran");
  assert.equal(veteran[0].tier, 3);

  const settled = computeAgentBadges(
    baseInputs({ firstSeenAt: NOW - 45 * DAY }),
  );
  assert.equal(settled[0].name, "Settled");
  assert.equal(settled[0].tier, 1);

  const fresh = computeAgentBadges(baseInputs({ firstSeenAt: NOW - 5 * DAY }));
  assert.deepEqual(fresh, []);
});

test("the like ladder honors its BadgeNation heritage", () => {
  const godlike = computeAgentBadges(baseInputs({ reactionCount: 150 }));
  assert.equal(godlike[0].name, "Godlike");
  assert.equal(godlike[0].tier, 3);

  const double = computeAgentBadges(baseInputs({ reactionCount: 5 }));
  assert.equal(double[0].name, "Double Like");
});

test("memories only grant badges when visible to the viewer", () => {
  assert.deepEqual(computeAgentBadges(baseInputs({ memoryCount: null })), []);
  const badges = computeAgentBadges(baseInputs({ memoryCount: 60 }));
  assert.equal(badges[0].name, "Elephant Memory");
});

test("merged pull requests earn the shipped ladder", () => {
  const first = computeAgentBadges(baseInputs({ mergedPrCount: 1 }));
  assert.equal(first[0].name, "First Merge");
  assert.equal(first[0].tier, 1);
  assert.match(first[0].description, /1 pull request merged/);

  const machine = computeAgentBadges(baseInputs({ mergedPrCount: 24 }));
  assert.equal(machine[0].name, "Merge Machine");
  assert.equal(machine[0].tier, 3);
});

test("high signal requires a decided sample and a high merge rate", () => {
  const strong = computeAgentBadges(
    baseInputs({ closedPrCount: 1, mergedPrCount: 9 }),
  );
  assert.ok(badgeIds(strong).includes("high-signal"));
  const highSignal = strong.find((badge) => badge.id === "high-signal");
  assert.match(highSignal.description, /9 of 10/);

  // Same rate but too few decided PRs to mean anything.
  const tinySample = computeAgentBadges(
    baseInputs({ closedPrCount: 0, mergedPrCount: 4 }),
  );
  assert.ok(!badgeIds(tinySample).includes("high-signal"));

  // Enough volume but half the PRs got rejected.
  const lowRate = computeAgentBadges(
    baseInputs({ closedPrCount: 5, mergedPrCount: 5 }),
  );
  assert.ok(!badgeIds(lowRate).includes("high-signal"));
});

test("issues filed earn the bug hunter ladder", () => {
  const spotter = computeAgentBadges(baseInputs({ issuesOpenedCount: 1 }));
  assert.equal(spotter[0].name, "Bug Spotter");

  const exterminator = computeAgentBadges(
    baseInputs({ issuesOpenedCount: 20 }),
  );
  assert.equal(exterminator[0].name, "Exterminator");
  assert.equal(exterminator[0].tier, 3);
});

test("reviews given and repo spread earn craft badges", () => {
  const badges = computeAgentBadges(
    baseInputs({ repoCount: 4, reviewCount: 12 }),
  );
  assert.deepEqual(badgeIds(badges), ["reviewer", "cross-pollinator"]);
  assert.equal(badges[0].name, "Reviewer");
  assert.equal(badges[1].name, "Multi-Repo");
});

test("craft badges precede tenure and activity", () => {
  const badges = computeAgentBadges(
    baseInputs({
      firstSeenAt: NOW - 200 * DAY,
      mergedPrCount: 5,
      noteCount: 30,
    }),
  );
  assert.deepEqual(badgeIds(badges), [
    "shipped",
    "high-signal",
    "tenure",
    "scribe",
  ]);
});

test("on duty appears while the agent is actively working", () => {
  const badges = computeAgentBadges(baseInputs({ activeTurnCount: 2 }));
  assert.equal(badges[0].id, "on-duty");
  assert.match(badges[0].description, /2 channels/);
});

test("GitHub-style YOLO and Quickdraw fire from a single qualifying event", () => {
  const yolo = computeAgentBadges(baseInputs({ yoloMergeCount: 1 }));
  assert.equal(yolo[0].id, "yolo");
  assert.equal(yolo[0].name, "YOLO");

  const quickdraw = computeAgentBadges(baseInputs({ quickdrawCount: 2 }));
  assert.equal(quickdraw[0].id, "quickdraw");
  assert.match(quickdraw[0].description, /2 items/);
});

test("Pair Extraordinaire and Team Player reward working with other agents", () => {
  const pair = computeAgentBadges(baseInputs({ pairPrCount: 10 }));
  assert.equal(pair[0].id, "pair-extraordinaire");
  assert.equal(pair[0].tier, 2);

  const team = computeAgentBadges(baseInputs({ peerReviewCount: 15 }));
  assert.equal(team[0].name, "Squad Lead");
  assert.equal(team[0].id, "team-player");
});

test("closer, helping hand, and assignee ladders track issue follow-through", () => {
  const badges = computeAgentBadges(
    baseInputs({
      assignedDoneCount: 5,
      issueDoneCount: 1,
      issueHelpCount: 10,
    }),
  );
  assert.deepEqual(badgeIds(badges), ["closer", "helping-hand", "assignee"]);
  assert.equal(badges[0].name, "Closer");
  assert.equal(badges[1].name, "First Responder");
  assert.equal(badges[2].name, "Owner");
});

test("Galaxy Brain, Daily Driver, and Crew Caller are activity ladders", () => {
  const galaxy = computeAgentBadges(baseInputs({ acceptedReplyCount: 16 }));
  assert.equal(galaxy[0].id, "galaxy-brain");
  assert.equal(galaxy[0].name, "Galaxy Brain");
  assert.equal(galaxy[0].tier, 3);

  const daily = computeAgentBadges(baseInputs({ distinctNoteDays: 7 }));
  assert.equal(daily[0].name, "Weekender");

  const crew = computeAgentBadges(baseInputs({ agentMentionNoteCount: 3 }));
  assert.equal(crew[0].name, "Crew Caller");
});

test("the shipped ladder uses GitHub's Pull Shark name at tier 2", () => {
  const shark = computeAgentBadges(baseInputs({ mergedPrCount: 5 }));
  assert.equal(shark[0].name, "Pull Shark");
  assert.equal(shark[0].tier, 2);
});
