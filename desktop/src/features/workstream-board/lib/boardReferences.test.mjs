import assert from "node:assert/strict";
import test from "node:test";
import {
  boardReferenceKey,
  boardReferenceTags,
  parseBoardReferences,
  resolveBoardReferences,
} from "./boardReferences.ts";
const WS = "123e4567-e89b-12d3-a456-426614174000";
const OTHER = "123e4567-e89b-12d3-a456-426614174001";
const ref = (kind, identity, workstreamId = WS) => ({
  kind,
  identity,
  snapshot: { label: identity },
  placement: {
    workstreamId,
    workstreamLabel: "Checkout",
    sectionId: "workstream",
    sectionLabel: "Workstream",
  },
});
test("ordered mixed references round trip while malformed and cross-workstream entries fail closed", () => {
  const valid = [ref("workstream", "one"), ref("pull-request", "one")];
  const tags = [
    ...boardReferenceTags(valid),
    ["buzz:board-ref", "99", "{}"],
    ["buzz:board-ref", "1", "bad"],
    ...boardReferenceTags([ref("agent-group", "other", OTHER)]),
  ];
  assert.deepEqual(parseBoardReferences(tags, WS), valid);
});
test("resolution distinguishes same identity across kinds and removed objects", () => {
  const refs = [
    ref("workstream", "same"),
    ref("pull-request", "same"),
    ref("agent-group", "gone"),
  ];
  const live = new Map([
    [boardReferenceKey(refs[0]), refs[0]],
    [
      boardReferenceKey(refs[1]),
      { ...refs[1], snapshot: { label: "changed" } },
    ],
  ]);
  assert.deepEqual(
    resolveBoardReferences(refs, live).map(({ state }) => state),
    ["live", "changed", "historical"],
  );
});
