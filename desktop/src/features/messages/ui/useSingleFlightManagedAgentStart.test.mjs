import assert from "node:assert/strict";
import test from "node:test";

import { managedAgentStartFlightKey } from "./useSingleFlightManagedAgentStart.ts";

const AGENT = "a".repeat(64);
const SIGNER = "b".repeat(64);

test("start flight keys coalesce only within the same tenant scope", () => {
  const scoped = managedAgentStartFlightKey({
    pubkey: AGENT,
    expectedRelayUrl: "wss://relay.example",
    expectedSignerPubkey: SIGNER,
  });

  assert.equal(
    scoped,
    managedAgentStartFlightKey({
      pubkey: AGENT.toUpperCase(),
      expectedRelayUrl: "wss://relay.example",
      expectedSignerPubkey: SIGNER.toUpperCase(),
    }),
  );
  assert.notEqual(
    scoped,
    managedAgentStartFlightKey({
      pubkey: AGENT,
      expectedRelayUrl: "wss://other.example",
      expectedSignerPubkey: SIGNER,
    }),
  );
  assert.notEqual(scoped, managedAgentStartFlightKey(AGENT));
});
