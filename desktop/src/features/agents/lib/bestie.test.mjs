import assert from "node:assert/strict";
import test from "node:test";

import { pickBestieAgent } from "./bestie.ts";

function agent(overrides) {
  return {
    pubkey: "a".repeat(64),
    name: "Agent",
    personaId: null,
    relayUrl: "wss://buzz.example",
    status: "stopped",
    ...overrides,
  };
}

test("prefers the built-in Bestie over a name fallback", () => {
  const chief = agent({ pubkey: "b".repeat(64), name: "chief of staff" });
  const bestie = agent({
    pubkey: "c".repeat(64),
    name: "Bestie",
    personaId: "builtin:bestie",
  });

  assert.equal(pickBestieAgent([chief, bestie]), bestie);
});

test("reuses an existing Chief of Staff within the active relay", () => {
  const otherRelay = agent({
    pubkey: "b".repeat(64),
    name: "Bestie",
    personaId: "builtin:bestie",
    relayUrl: "wss://other.example",
  });
  const chief = agent({
    pubkey: "c".repeat(64),
    name: "Chief of Staff",
    relayUrl: "wss://buzz.example/",
  });

  assert.equal(
    pickBestieAgent([otherRelay, chief], "wss://buzz.example"),
    chief,
  );
});

test("prefers a running Bestie instance", () => {
  const stopped = agent({ personaId: "builtin:bestie" });
  const running = agent({
    pubkey: "b".repeat(64),
    personaId: "builtin:bestie",
    status: "running",
  });

  assert.equal(pickBestieAgent([stopped, running]), running);
});
