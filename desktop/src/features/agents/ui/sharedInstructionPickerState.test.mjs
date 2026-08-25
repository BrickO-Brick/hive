import assert from "node:assert/strict";
import test from "node:test";

import { toggleSharedInstructionCoordinate } from "./sharedInstructionPickerState.ts";

const owner = "a".repeat(64);
const compatible = {
  coordinate: `30023:${owner}:design-review`,
  publisher: owner,
  slug: "design-review",
  title: "Thoughtful Interfaces",
  summary: "Review layout, interaction, and accessibility.",
  eventId: "1".repeat(64),
  updatedAt: 1,
  compatible: true,
  incompatibilities: [],
};
const incompatible = {
  ...compatible,
  coordinate: `30023:${owner}:bad_name`,
  slug: "bad_name",
  title: "Legacy note",
  summary: "An older note that is not compatible yet.",
  compatible: false,
  incompatibilities: [
    { code: "invalidName", message: "Use an shared-instruction name" },
  ],
};

test("shared instruction selection adds and removes exact coordinates", () => {
  assert.deepEqual(toggleSharedInstructionCoordinate([], compatible), [
    compatible.coordinate,
  ]);
  assert.deepEqual(
    toggleSharedInstructionCoordinate([compatible.coordinate], compatible),
    [],
  );
});

test("incompatible relay notes cannot enter the assignment", () => {
  const selected = [compatible.coordinate];
  assert.deepEqual(
    toggleSharedInstructionCoordinate(selected, incompatible),
    selected,
  );
});
