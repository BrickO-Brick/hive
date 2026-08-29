/**
 * Tests for `isTrustedPermissionRequestSentinel` — the prose-suppression gate.
 *
 * The contract: `MessageRow` suppresses prose rendering ONLY when this
 * function returns true. It returns true IFF (a) the signer is a known agent
 * AND (b) the body is a permission-request sentinel.
 *
 * Carl's F3 requirement: a forged sentinel (valid JSON shape, wrong signer)
 * must NOT suppress prose — the fallback is markdown rendering, not a blank row.
 * Shape-only detection (`isPermissionRequestSentinel`) is insufficient because
 * it fires before the trust check, producing a blank row on forged sentinels.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const mod = await import("./permissionRequestAuthPubkey.js").catch(
  () => import("./permissionRequestAuthPubkey.ts"),
);
const { getPermissionRequestAgentPubkey, isTrustedPermissionRequestSentinel } =
  mod;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const AGENT_PUBKEY =
  "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
const ATTACKER_PUBKEY =
  "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const SENTINEL_BODY = JSON.stringify({
  v: 1,
  state: "pending",
  requestNonce: "a9f3b2c1-d4e5-4f6a-b7c8-d9e0f1a2b3c4",
  sessionId: "sess-abc",
  turnId: "turn-xyz",
  expiresAt: 9_999_999_999,
  optionIds: ["opt-allow", "opt-deny"],
  labels: { "opt-allow": "Allow once", "opt-deny": "Deny" },
});

const PROSE_BODY = "Hello from the agent";

function makeMessage({ kind = 9, signerPubkey, body }) {
  return { kind, signerPubkey, body };
}

function isKnownAgent(pubkey) {
  return pubkey === AGENT_PUBKEY;
}

// ── getPermissionRequestAgentPubkey ───────────────────────────────────────────

describe("getPermissionRequestAgentPubkey", () => {
  it("test_returns_signer_pubkey_for_known_agent_on_kind9", () => {
    const msg = makeMessage({
      kind: 9,
      signerPubkey: AGENT_PUBKEY,
      body: SENTINEL_BODY,
    });
    assert.equal(
      getPermissionRequestAgentPubkey(msg, isKnownAgent),
      AGENT_PUBKEY,
    );
  });

  it("test_returns_undefined_for_unknown_signer", () => {
    const msg = makeMessage({
      kind: 9,
      signerPubkey: ATTACKER_PUBKEY,
      body: SENTINEL_BODY,
    });
    assert.equal(getPermissionRequestAgentPubkey(msg, isKnownAgent), undefined);
  });

  it("test_returns_undefined_for_non_kind9", () => {
    const msg = makeMessage({
      kind: 1,
      signerPubkey: AGENT_PUBKEY,
      body: SENTINEL_BODY,
    });
    assert.equal(getPermissionRequestAgentPubkey(msg, isKnownAgent), undefined);
  });
});

// ── isTrustedPermissionRequestSentinel ────────────────────────────────────────

describe("isTrustedPermissionRequestSentinel", () => {
  it("test_returns_true_for_known_agent_sentinel", () => {
    const msg = makeMessage({
      kind: 9,
      signerPubkey: AGENT_PUBKEY,
      body: SENTINEL_BODY,
    });
    assert.equal(
      isTrustedPermissionRequestSentinel(msg, isKnownAgent),
      true,
      "trusted sentinel must return true",
    );
  });

  it("test_returns_false_for_forged_signer_sentinel_prose_not_suppressed", () => {
    // F3: forged signer — valid sentinel JSON but wrong signer. The function
    // must return false so MessageRow does NOT suppress prose, preventing a
    // blank row. This is the exact defect: shape-only detection would return
    // true here, silencing the message without rendering a card.
    const msg = makeMessage({
      kind: 9,
      signerPubkey: ATTACKER_PUBKEY, // known-agent check fails
      body: SENTINEL_BODY, // valid shape
    });
    assert.equal(
      isTrustedPermissionRequestSentinel(msg, isKnownAgent),
      false,
      "forged signer must NOT suppress prose — fallback to markdown",
    );
  });

  it("test_returns_false_for_prose_body_even_with_known_agent", () => {
    // Not a sentinel — prose body should not suppress itself.
    const msg = makeMessage({
      kind: 9,
      signerPubkey: AGENT_PUBKEY,
      body: PROSE_BODY,
    });
    assert.equal(
      isTrustedPermissionRequestSentinel(msg, isKnownAgent),
      false,
      "non-sentinel body must not suppress prose",
    );
  });

  it("test_returns_false_for_unknown_agent_with_sentinel_body", () => {
    // unknown-agent case: Carl also asked to cover this
    const msg = makeMessage({
      kind: 9,
      signerPubkey: ATTACKER_PUBKEY,
      body: SENTINEL_BODY,
    });
    assert.equal(
      isTrustedPermissionRequestSentinel(msg, isKnownAgent),
      false,
      "unknown agent must not suppress prose",
    );
  });

  it("test_returns_false_for_non_kind9_trusted_agent_sentinel", () => {
    // Born on wrong kind — kind gate blocks regardless of body shape
    const msg = makeMessage({
      kind: 1,
      signerPubkey: AGENT_PUBKEY,
      body: SENTINEL_BODY,
    });
    assert.equal(
      isTrustedPermissionRequestSentinel(msg, isKnownAgent),
      false,
      "wrong kind must not suppress prose",
    );
  });
});
