import type { TimelineMessage } from "@/features/messages/types";

import { collectionReferencesForMessage } from "../messageMembership";
import { CollectionMembershipBadges } from "./CollectionMembershipBadges";

export function MessageCollectionMembershipBadges({
  channelId,
  message,
}: {
  channelId: string;
  message: TimelineMessage;
}) {
  return (
    <CollectionMembershipBadges
      references={collectionReferencesForMessage(channelId, message)}
    />
  );
}
