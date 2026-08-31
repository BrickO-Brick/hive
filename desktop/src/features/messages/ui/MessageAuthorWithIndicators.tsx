import type * as React from "react";

import { UserProfilePopover } from "@/features/profile/ui/UserProfilePopover";
import { UserNameIndicators } from "@/features/user-status/ui/UserNameIndicators";

type MessageAuthorWithIndicatorsProps = {
  authorName: string;
  children: React.ReactNode;
  pubkey: string;
  role?: string;
};

export function MessageAuthorWithIndicators({
  authorName,
  children,
  pubkey,
  role,
}: MessageAuthorWithIndicatorsProps) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1">
      <UserProfilePopover
        botIdenticonValue={authorName}
        pubkey={pubkey}
        role={role}
      >
        <button
          className="truncate rounded leading-message-author focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          type="button"
        >
          {children}
        </button>
      </UserProfilePopover>
      <UserNameIndicators pubkey={pubkey} />
    </span>
  );
}
