import assert from "node:assert/strict";
import test from "node:test";

import {
  collectOccurrenceManagedNames,
  isOccurrenceManagedName,
  reconcileMentionIdentityRefs,
  restoreMentionIdentityRefs,
  snapshotMentionIdentityRefs,
} from "./mentionIdentityRefs.ts";

const FIRST = "1".repeat(64);
const SECOND = "2".repeat(64);
const refs = [
  { displayName: "Will", pubkey: FIRST, isAgent: false, offset: 0 },
  { displayName: "Will", pubkey: SECOND, isAgent: true, offset: 10 },
];

test("deleting either same-name occurrence retains only the other identity", () => {
  assert.deepEqual(
    reconcileMentionIdentityRefs(refs, "@Will and @Will", "and @Will"),
    [{ ...refs[1], offset: 4 }],
  );
  assert.deepEqual(
    reconcileMentionIdentityRefs(refs, "@Will and @Will", "@Will and "),
    [refs[0]],
  );
  assert.deepEqual(
    reconcileMentionIdentityRefs(refs, "@Will and @Will", "@Will and ", {
      oldFrom: 10,
      oldTo: 15,
      newFrom: 10,
      newTo: 10,
    }),
    [refs[0]],
  );
});

test("editing before same-name mentions rebases both occurrences", () => {
  assert.deepEqual(
    reconcileMentionIdentityRefs(
      refs,
      "@Will and @Will",
      "hey @Will and @Will",
    ),
    [
      { ...refs[0], offset: 4 },
      { ...refs[1], offset: 14 },
    ],
  );
});

test("autocomplete replacement retains its pre-registered identity", () => {
  const autocompleteRef = { ...refs[0], offset: 0, id: "autocomplete-1" };
  assert.deepEqual(
    reconcileMentionIdentityRefs(
      [autocompleteRef],
      "@Wi",
      "@Will ",
      {
        oldFrom: 0,
        oldTo: 3,
        newFrom: 0,
        newTo: 6,
      },
      new Set([autocompleteRef.id]),
    ),
    [autocompleteRef],
  );
});

test("editing inside a mention drops only the intersected identity", () => {
  assert.deepEqual(
    reconcileMentionIdentityRefs(refs, "@Will and @Will", "@Wills and @Will"),
    [{ ...refs[1], offset: 11 }],
  );
});

test("unprojectable editor updates fail closed at unchanged offsets", () => {
  assert.deepEqual(
    reconcileMentionIdentityRefs(
      refs,
      "@Will and @Will",
      "x @Will and @Will",
      null,
    ),
    [],
  );
});

test("invalid supplied ranges drop identities", () => {
  assert.deepEqual(
    reconcileMentionIdentityRefs(refs, "@Will and @Will", "@Will and @Will!", {
      oldFrom: -1,
      oldTo: 0,
      newFrom: 0,
      newTo: 1,
    }),
    [],
  );
});

test("restoration uses persisted offsets when one duplicate occurrence was removed", () => {
  const persisted = snapshotMentionIdentityRefs(refs);
  assert.deepEqual(restoreMentionIdentityRefs("@Will and ", persisted), [
    refs[0],
  ]);
});

test("restoration drops explicit stale offsets instead of reassigning identity", () => {
  assert.deepEqual(
    restoreMentionIdentityRefs("@Will", [{ ...refs[1], offset: 10 }]),
    [],
  );
});

test("restored names stay occurrence-managed after explicit offsets go stale", () => {
  const managedNames = collectOccurrenceManagedNames([
    { ...refs[1], offset: 10 },
  ]);

  assert.equal(isOccurrenceManagedName("Will", managedNames), true);
  assert.equal(isOccurrenceManagedName("will", managedNames), true);
  assert.equal(isOccurrenceManagedName("Alice", managedNames), false);
});

test("legacy refs without offsets restore same-name identities in order", () => {
  assert.deepEqual(
    restoreMentionIdentityRefs(
      "@Will and @Will",
      refs.map(({ offset: _offset, ...ref }) => ref),
    ),
    refs,
  );
});

test("draft refs restore same-name identities and agent flags in occurrence order", () => {
  const persisted = snapshotMentionIdentityRefs(refs);
  assert.deepEqual(
    persisted.map(({ offset: _offset, ...ref }) => ref),
    [
      { displayName: "Will", pubkey: FIRST, isAgent: false },
      { displayName: "Will", pubkey: SECOND, isAgent: true },
    ],
  );
  assert.deepEqual(
    restoreMentionIdentityRefs("@Will and @Will", persisted),
    refs,
  );
});
