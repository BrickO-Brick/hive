/**
 * Wrapper that handles the current-viewer identity check for the
 * `PermissionRequestCard`, keeping React hooks out of the memo-heavy
 * `MessageRow` component.
 *
 * Renders nothing when `computePermissionRequest` returns null (no trusted
 * sentinel, wrong signer, or non-interactive surface).
 */
import * as React from "react";

import type { TimelineMessage } from "@/features/messages/types";
import { getPermissionRequestAgentPubkey } from "@/features/messages/ui/permissionRequestAuthPubkey";
import { useIdentityQuery } from "@/shared/api/hooks";
import { computePermissionRequest } from "@/shared/lib/computePermissionRequest";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { AttachmentGroup } from "@/shared/ui/attachment";
import { PermissionRequestCard } from "@/shared/ui/permission-request-card";

export type PermissionRequestCardBlockProps = {
  /** The message that may carry a permission-request sentinel. */
  message: TimelineMessage;
  /** Predicate identifying a known agent signer (enables the card). */
  isKnownAgentPubkey: (pubkey: string) => boolean;
  /** Channel ID for routing the decision click; falsy → no card. */
  channelId: string | null | undefined;
};

export const PermissionRequestCardBlock = React.memo(
  function PermissionRequestCardBlock({
    message,
    isKnownAgentPubkey,
    channelId,
  }: PermissionRequestCardBlockProps) {
    const identityQuery = useIdentityQuery();
    const viewerPubkey = identityQuery.data?.pubkey;

    if (!channelId || !message.isAgent) return null;

    const agentPubkey = getPermissionRequestAgentPubkey(
      message,
      isKnownAgentPubkey,
    );
    const request = computePermissionRequest(
      message.body,
      true,
      agentPubkey,
      message.signerPubkey,
      message.editSignerPubkey,
      message.id,
      message.preEditBody,
    );

    if (request === null || !agentPubkey) return null;

    const ownerPubkey = message.ownerPubkey;
    const isOwner =
      !!viewerPubkey &&
      !!ownerPubkey &&
      normalizePubkey(viewerPubkey) === normalizePubkey(ownerPubkey);

    return (
      <AttachmentGroup
        className="max-w-full flex-wrap overflow-visible pb-0"
        data-permission-request=""
      >
        <PermissionRequestCard
          agentPubkey={agentPubkey}
          channelId={channelId}
          isOwner={isOwner}
          request={request}
        />
      </AttachmentGroup>
    );
  },
  (prev, next) =>
    prev.message === next.message &&
    prev.isKnownAgentPubkey === next.isKnownAgentPubkey &&
    prev.channelId === next.channelId,
);
