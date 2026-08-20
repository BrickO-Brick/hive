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
  const valid = [ref("workstream", WS), ref("pull-request", "one")];
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
    ref("pull-request", "same"),
    ref("agent-group", "same"),
    ref("pull-request", "gone"),
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

test("strict decoding rejects unknown fields and Unicode controls per reference", () => {
  const valid = ref("workstream", WS);
  const malformed = [
    { ...valid, extra: true },
    { ...valid, snapshot: { ...valid.snapshot, extra: true } },
    { ...valid, placement: { ...valid.placement, extra: true } },
    { ...valid, snapshot: { label: "bad\u0085label" } },
  ];
  const tags = malformed.map((value) => [
    "buzz:board-ref",
    "1",
    JSON.stringify(value),
  ]);
  assert.deepEqual(
    parseBoardReferences([...tags, ...boardReferenceTags([valid])]),
    [valid],
  );
});

test("workstream identity is canonically bound to placement", () => {
  const forged = ref("workstream", OTHER);
  forged.placement.workstreamId = WS;
  const tag = ["buzz:board-ref", "1", JSON.stringify(forged)];
  assert.deepEqual(parseBoardReferences([tag], WS), []);
});

test("same reusable identity is scoped to its recorded workstream", () => {
  const inA = ref("agent", "6".repeat(64), WS);
  const inB = ref("agent", "6".repeat(64), OTHER);
  const live = new Map([
    [boardReferenceKey(inA), inA],
    [boardReferenceKey(inB), inB],
  ]);
  assert.notEqual(boardReferenceKey(inA), boardReferenceKey(inB));
  assert.equal(resolveBoardReferences([inA], live)[0].state, "live");
  live.delete(boardReferenceKey(inA));
  assert.equal(resolveBoardReferences([inA], live)[0].state, "historical");
});
