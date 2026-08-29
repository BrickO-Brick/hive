import { KIND_STREAM_MESSAGE } from "@/shared/constants/kinds";
import type { TimelineMessage } from "@/features/messages/types";
import { isPermissionRequestSentinel } from "@/shared/lib/permissionRequest";

/**
 * Returns the agent pubkey to use for the `PermissionRequestCard` for a given
 * message, or `undefined` when the permission-card path should be disabled.
 *
 * The card is enabled ONLY when:
 *   1. `message.kind === KIND_STREAM_MESSAGE` — restricts to the setup-listener
 *      wire format (kind:9).
 *   2. `message.signerPubkey` is set and passes `isKnownAgentPubkey` —
 *      authenticates against the raw event signer (NOT `message.pubkey`,
 *      which may be a relay-delegated display author).
 *
 * Mirrors `getConfigNudgeAuthorPubkey` — same signer-vs-delegated-author
 * distinction, same test-friendly pure-function shape.
 */
export function getPermissionRequestAgentPubkey(
  message: Pick<TimelineMessage, "kind" | "signerPubkey">,
  isKnownAgentPubkey: (pubkey: string) => boolean,
): string | undefined {
  if (
    message.kind === KIND_STREAM_MESSAGE &&
    message.signerPubkey &&
    isKnownAgentPubkey(message.signerPubkey)
  ) {
    return message.signerPubkey;
  }
  return undefined;
}

/**
 * Returns `true` only when the message body is a permission-request sentinel
 * AND the signer is a known agent (the trusted card path will render).
 *
 * Used by `MessageRow` to decide whether to suppress markdown rendering.
 * Shape-only detection (`isPermissionRequestSentinel`) is NOT sufficient —
 * a forged sentinel (wrong signer) passes the shape gate, is rejected by
 * `computePermissionRequest`, and would leave a blank row if prose were
 * suppressed before the trust check.
 *
 * Mirrors `getConfigNudgeAuthorPubkey`'s prose-suppression contract — the
 * card path owns the prose-vs-card decision.
 */
export function isTrustedPermissionRequestSentinel(
  message: Pick<TimelineMessage, "kind" | "signerPubkey" | "body">,
  isKnownAgentPubkey: (pubkey: string) => boolean,
): boolean {
  // Trust gate first — if the signer is not a known agent, the card will not
  // render, so prose suppression must NOT happen.
  if (!getPermissionRequestAgentPubkey(message, isKnownAgentPubkey)) {
    return false;
  }
  return isPermissionRequestSentinel(message.body);
}
