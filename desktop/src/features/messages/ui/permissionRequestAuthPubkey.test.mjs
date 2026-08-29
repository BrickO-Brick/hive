/**
 * Tests for `hasPermissionRequestCard` — the prose-suppression gate.
 *
 * The contract: `MessageRow` suppresses prose rendering ONLY when this
 * function returns true. It returns true IFF `computePermissionRequest` returns
 * a non-null payload — identical to the block's own decision. This closes
 * every blank-row case:
 *   - forged signer (signerPubkey ≠ agentPubkey)
 *   - born-resolved-no-provenance (state "resolved" in a kind-9, no edit
 *     provenance — no editSignerPubkey / id / preEditBody)
 *   - correlation-mismatch resolved body (originalEventId or nonce doesn't
 *     match the card it claims to resolve)
 *
 * Carl's F3 requirement: integrated forged-signer + born-resolved tests that
 * assert the prose fallback is NOT suppressed (the card will not render for
 * these shapes, so neither should prose be hidden).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const mod = await import("./permissionRequestAuthPubkey.js").catch(
  () => import("./permissionRequestAuthPubkey.ts"),
);
const { getPermissionRequestAgentPubkey, hasPermissionRequestCard } = mod;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const AGENT_PUBKEY =
  "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
const ATTACKER_PUBKEY =
  "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

// A valid 64-char hex event ID used as the sentinel's own ID.
const MESSAGE_ID =
  "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const OTHER_ID =
  "fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321";

const PENDING_BODY = JSON.stringify({
  v: 1,
  state: "pending",
  requestNonce: "a9f3b2c1-d4e5-4f6a-b7c8-d9e0f1a2b3c4",
  sessionId: "sess-abc",
  turnId: "turn-xyz",
  expiresAt: 9_999_999_999,
  optionIds: ["opt-allow", "opt-deny"],
  labels: { "opt-allow": "Allow once", "opt-deny": "Deny" },
});

// A valid resolved body that correlates to MESSAGE_ID + PENDING_BODY nonce.
const RESOLVED_BODY = JSON.stringify({
  v: 1,
  state: "resolved",
  requestNonce: "a9f3b2c1-d4e5-4f6a-b7c8-d9e0f1a2b3c4",
  originalEventId: MESSAGE_ID,
  sessionId: "sess-abc",
  turnId: "turn-xyz",
  expiresAt: 9_999_999_999,
  optionIds: ["opt-allow", "opt-deny"],
  labels: { "opt-allow": "Allow once", "opt-deny": "Deny" },
  outcome: "applied",
  chosenOptionId: "opt-allow",
});

const PROSE_BODY = "Hello from the agent";

function makePendingMessage(overrides = {}) {
  return {
    kind: 9,
    signerPubkey: AGENT_PUBKEY,
    body: PENDING_BODY,
    id: MESSAGE_ID,
    editSignerPubkey: undefined,
    preEditBody: undefined,
    ...overrides,
  };
}

function isKnownAgent(pubkey) {
  return pubkey === AGENT_PUBKEY;
}

// ── getPermissionRequestAgentPubkey ───────────────────────────────────────────

describe("getPermissionRequestAgentPubkey", () => {
  it("test_returns_signer_pubkey_for_known_agent_on_kind9", () => {
    const msg = makePendingMessage();
    assert.equal(
      getPermissionRequestAgentPubkey(msg, isKnownAgent),
      AGENT_PUBKEY,
    );
  });

  it("test_returns_undefined_for_unknown_signer", () => {
    const msg = makePendingMessage({ signerPubkey: ATTACKER_PUBKEY });
    assert.equal(getPermissionRequestAgentPubkey(msg, isKnownAgent), undefined);
  });

  it("test_returns_undefined_for_non_kind9", () => {
    const msg = makePendingMessage({ kind: 1 });
    assert.equal(getPermissionRequestAgentPubkey(msg, isKnownAgent), undefined);
  });
});

// ── hasPermissionRequestCard ──────────────────────────────────────────────────

describe("hasPermissionRequestCard", () => {
  it("test_returns_true_for_trusted_agent_pending_sentinel", () => {
    const msg = makePendingMessage();
    assert.equal(
      hasPermissionRequestCard(msg, isKnownAgent),
      true,
      "trusted pending sentinel must return true",
    );
  });

  it("test_returns_false_for_forged_signer_prose_not_suppressed", () => {
    // F3: forged signer — valid sentinel JSON but wrong signer.
    // computePermissionRequest rejects on the D1 signer gate.
    // Prose must NOT be suppressed — fallback to markdown.
    const msg = makePendingMessage({ signerPubkey: ATTACKER_PUBKEY });
    assert.equal(
      hasPermissionRequestCard(msg, isKnownAgent),
      false,
      "forged signer must NOT suppress prose — fallback to markdown",
    );
  });

  it("test_returns_false_for_prose_body_even_with_known_agent", () => {
    const msg = makePendingMessage({ body: PROSE_BODY });
    assert.equal(
      hasPermissionRequestCard(msg, isKnownAgent),
      false,
      "non-sentinel body must not suppress prose",
    );
  });

  it("test_returns_false_for_unknown_agent", () => {
    const msg = makePendingMessage({ signerPubkey: ATTACKER_PUBKEY });
    assert.equal(
      hasPermissionRequestCard(msg, isKnownAgent),
      false,
      "unknown agent must not suppress prose",
    );
  });

  it("test_returns_false_for_non_kind9", () => {
    const msg = makePendingMessage({ kind: 1 });
    assert.equal(
      hasPermissionRequestCard(msg, isKnownAgent),
      false,
      "wrong kind must not suppress prose",
    );
  });

  it("test_returns_false_for_born_resolved_no_provenance", () => {
    // Born-resolved-no-provenance: the kind-9 body is already "resolved"
    // but has no edit provenance (no editSignerPubkey / id / preEditBody).
    // computePermissionRequest rejects this — no edit signer present.
    // The prose must render, not produce a blank row.
    const msg = makePendingMessage({
      body: RESOLVED_BODY,
      editSignerPubkey: undefined,
      id: MESSAGE_ID,
      preEditBody: undefined,
    });
    assert.equal(
      hasPermissionRequestCard(msg, isKnownAgent),
      false,
      "born-resolved sentinel without edit provenance must NOT suppress prose",
    );
  });

  it("test_returns_true_for_resolved_with_valid_provenance", () => {
    // Resolved with proper edit provenance — card renders, prose suppressed.
    const msg = makePendingMessage({
      body: RESOLVED_BODY,
      editSignerPubkey: AGENT_PUBKEY,
      id: MESSAGE_ID,
      preEditBody: PENDING_BODY,
    });
    assert.equal(
      hasPermissionRequestCard(msg, isKnownAgent),
      true,
      "resolved sentinel with valid edit provenance must suppress prose",
    );
  });

  it("test_returns_false_for_correlation_mismatch_resolved", () => {
    // Correlation mismatch: originalEventId in the resolved body names a
    // DIFFERENT event ID than the message's own id.
    // computePermissionRequest rejects — this is a cross-card attack.
    const mismatchedBody = JSON.stringify({
      v: 1,
      state: "resolved",
      requestNonce: "a9f3b2c1-d4e5-4f6a-b7c8-d9e0f1a2b3c4",
      originalEventId: OTHER_ID, // ← different from MESSAGE_ID
      sessionId: "sess-abc",
      turnId: "turn-xyz",
      expiresAt: 9_999_999_999,
      optionIds: ["opt-allow", "opt-deny"],
      labels: { "opt-allow": "Allow once", "opt-deny": "Deny" },
      outcome: "applied",
      chosenOptionId: "opt-allow",
    });
    const msg = makePendingMessage({
      body: mismatchedBody,
      editSignerPubkey: AGENT_PUBKEY,
      id: MESSAGE_ID,
      preEditBody: PENDING_BODY,
    });
    assert.equal(
      hasPermissionRequestCard(msg, isKnownAgent),
      false,
      "correlation-mismatch resolved body must NOT suppress prose",
    );
  });
});
