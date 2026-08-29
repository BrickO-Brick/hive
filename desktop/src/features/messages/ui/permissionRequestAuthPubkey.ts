import { KIND_STREAM_MESSAGE } from "@/shared/constants/kinds";
import type { TimelineMessage } from "@/features/messages/types";
import { computePermissionRequest } from "@/shared/lib/computePermissionRequest";

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
 * Returns `true` only when `computePermissionRequest` would return a non-null
 * payload for this message — i.e., when the trusted card WILL render.
 *
 * Used by `MessageRow` to suppress prose rendering. The check is intentionally
 * identical to what `PermissionRequestCardBlock` computes so that prose is
 * suppressed if and only if a card renders — closing the blank-row gap from
 * every case `computePermissionRequest` rejects:
 *   - forged signer (signerPubkey ≠ agentPubkey)
 *   - born-resolved-no-provenance (state resolved, no editSignerPubkey)
 *   - correlation-mismatch resolved body
 *
 * Mirrors `selectProseOrPermission` — the card owns the prose-suppression
 * decision by construction rather than by a parallel approximation.
 */
export function hasPermissionRequestCard(
  message: Pick<
    TimelineMessage,
    "kind" | "signerPubkey" | "body" | "editSignerPubkey" | "id" | "preEditBody"
  >,
  isKnownAgentPubkey: (pubkey: string) => boolean,
): boolean {
  const agentPubkey = getPermissionRequestAgentPubkey(
    message,
    isKnownAgentPubkey,
  );
  return (
    computePermissionRequest(
      message.body,
      true,
      agentPubkey,
      message.signerPubkey,
      message.editSignerPubkey,
      message.id,
      message.preEditBody,
    ) !== null
  );
}
