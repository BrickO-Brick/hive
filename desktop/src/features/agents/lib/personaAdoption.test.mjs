import assert from "node:assert/strict";
import test from "node:test";

import {
  countCatalogRepublishers,
  personaDefinitionFingerprint,
  resolveAdoptionRecord,
} from "./personaAdoption.ts";

const WES = "a".repeat(64);
const ALICE = "b".repeat(64);
const BOB = "c".repeat(64);

function publication(ownerPubkey, agent = {}) {
  return {
    eventId: "e".repeat(64),
    ownerPubkey,
    sourcePersonaId: "persona-1",
    createdAt: 1_700_000_000,
    agent: {
      displayName: "Brain",
      avatarUrl: null,
      systemPrompt: "You review pull requests carefully.",
      runtime: null,
      model: null,
      provider: null,
      namePool: [],
      respondTo: null,
      parallelism: null,
      ...agent,
    },
  };
}

test("fingerprint keys on the prompt, ignoring whitespace and case", () => {
  const canonical = personaDefinitionFingerprint({
    displayName: "Brain",
    systemPrompt: "You review pull requests carefully.",
  });
  assert.equal(
    personaDefinitionFingerprint({
      displayName: "Renamed Brain",
      systemPrompt: "  You   review pull\nrequests CAREFULLY.  ",
    }),
    canonical,
  );
  // Promptless personas fall back to the display name.
  assert.equal(
    personaDefinitionFingerprint({ displayName: " Brain ", systemPrompt: "" }),
    personaDefinitionFingerprint({ displayName: "brain", systemPrompt: "  " }),
  );
});

test("counts distinct other members with a matching publication", () => {
  const count = countCatalogRepublishers(
    [
      publication(WES), // the original — never counts
      publication(ALICE),
      publication(ALICE, { displayName: "Brain (alice)" }), // same member twice
      publication(BOB, { displayName: "Big Brain" }), // renamed copy, same prompt
      publication(BOB.replace(/c/gu, "d"), {
        systemPrompt: "A different persona entirely.",
      }),
    ],
    {
      displayName: "Brain",
      systemPrompt: "You review pull requests carefully.",
      publisherPubkey: WES,
    },
  );
  assert.equal(count, 2);
});

test("adoption record surfaces for added copies of others' entries", () => {
  const adopted = resolveAdoptionRecord(
    {
      id: "local-uuid-1",
      createdAt: "2026-03-03T10:00:00Z",
      catalogSource: { ownerPubkey: WES.toUpperCase() },
    },
    ALICE,
  );
  assert.deepEqual(adopted, {
    adoptedAt: "2026-03-03T10:00:00Z",
    publisherPubkey: WES.toUpperCase(),
  });

  // Your own published entry is not an adoption.
  assert.equal(
    resolveAdoptionRecord(
      {
        id: "local-uuid-2",
        createdAt: "2026-03-03T10:00:00Z",
        catalogSource: { ownerPubkey: ALICE },
      },
      ALICE,
    ),
    null,
  );
  // A catalog projection the viewer never added carries no adoption date.
  assert.equal(
    resolveAdoptionRecord(
      {
        id: `catalog:${WES}:persona-1`,
        createdAt: "2026-03-03T10:00:00Z",
        catalogSource: { ownerPubkey: WES },
      },
      ALICE,
    ),
    null,
  );
  // Personas created from scratch have no source at all.
  assert.equal(
    resolveAdoptionRecord(
      { id: "local-uuid-3", createdAt: "2026-03-03T10:00:00Z" },
      ALICE,
    ),
    null,
  );
});

test("no publisher and no matches yield zero", () => {
  assert.equal(
    countCatalogRepublishers([], {
      displayName: "Brain",
      systemPrompt: "prompt",
      publisherPubkey: null,
    }),
    0,
  );
});
