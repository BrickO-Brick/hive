import type { ReactNode } from "react";
import type { PermissionRequestPayload } from "@/shared/lib/permissionRequest";
import { extractPermissionRequest } from "@/shared/lib/permissionRequest";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * Pure helper that computes the active `PermissionRequestPayload` for a
 * message body.
 *
 * The card is active ONLY when:
 * 1. `interactive` is true — non-interactive surfaces (search snippets, etc.)
 *    never render actionable cards.
 * 2. `agentPubkey` is provided and matches `signerPubkey` — authenticates
 *    the sentinel against the raw event signer from the signed envelope, not
 *    a relay-delegated author. This enforces the D1 requirement that forged
 *    cards (wrong signer) never become actionable.
 * 3. For resolved state: `editSignerPubkey` must equal `agentPubkey` — only
 *    edits signed by the original agent may flip the card to resolved.
 *    Owner-signed or attacker-signed edits are rejected.
 * 4. For resolved state: the resolved payload must correlate to THIS card —
 *    its `originalEventId` must equal `messageId`, and its
 *    `requestNonce`/`sessionId`/`turnId` must match the original pending
 *    payload (`preEditContent`). Same-signer authenticity alone is not enough:
 *    a buggy or compromised agent could otherwise cross-apply a resolution it
 *    signed for one card onto a different card it also signed.
 *
 * Extracted into its own module so it can be tested without pulling in
 * markdown.tsx's heavy dependency chain.
 */
export function computePermissionRequest(
  content: string,
  interactive: boolean,
  /** Normalized hex pubkey of the known agent for this channel (from signed envelope). */
  agentPubkey: string | undefined | null,
  /** Raw signer pubkey of the message event (from the signed envelope's pubkey field). */
  signerPubkey: string | undefined | null,
  /**
   * Signer pubkey of the most recent kind-40003 edit for this message, if any.
   * Undefined/null means no edit has arrived. Only edits where
   * `editSignerPubkey === agentPubkey` may resolve the card.
   */
  editSignerPubkey?: string | null,
  /** Event ID of this message (the kind-9 sentinel). A resolved edit must name it. */
  messageId?: string | null,
  /**
   * The pending body before the edit was overlaid. Used to correlate the
   * resolved edit's nonce/session/turn against the card it claims to resolve.
   */
  preEditContent?: string | null,
): PermissionRequestPayload | null {
  if (!interactive || !agentPubkey || !signerPubkey) return null;

  // D1 signer gate: the kind-9 must be signed by the known agent.
  if (normalizePubkey(signerPubkey) !== normalizePubkey(agentPubkey)) {
    return null;
  }

  const payload = extractPermissionRequest(content);
  if (payload === null) return null;

  // For resolved state (edit has arrived): verify the edit was signed by the
  // original agent. Owner-signed or attacker-signed edits are rejected.
  if (
    payload.state === "resolved" &&
    editSignerPubkey !== undefined &&
    editSignerPubkey !== null
  ) {
    if (normalizePubkey(editSignerPubkey) !== normalizePubkey(agentPubkey)) {
      return null;
    }

    // Correlate the resolution to THIS card. `originalEventId` must name this
    // message, and the frozen correlation fields must match the pending
    // payload the edit overlaid — otherwise a same-signer agent could
    // cross-apply a resolution meant for a different card.
    if (!messageId || payload.originalEventId !== messageId) {
      return null;
    }
    const pending = preEditContent
      ? extractPermissionRequest(preEditContent)
      : null;
    if (
      pending === null ||
      pending.requestNonce !== payload.requestNonce ||
      pending.sessionId !== payload.sessionId ||
      pending.turnId !== payload.turnId
    ) {
      return null;
    }
  }

  return payload;
}

/**
 * Returns `markdownNode` when no trusted permission-request payload is present,
 * or `null` when the card should suppress the prose.
 *
 * Mirrors `selectProseOrNudge` from computeConfigNudge.ts — same prose-
 * suppression contract.
 */
export function selectProseOrPermission(
  request: PermissionRequestPayload | null,
  markdownNode: ReactNode,
): ReactNode {
  return request === null ? markdownNode : null;
}
