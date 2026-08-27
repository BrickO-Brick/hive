import { useIdentityQuery } from "@/shared/api/hooks";
import { useRelayOrigin } from "@/shared/lib/useRelayOrigin";
import type { CollectionScope } from "./types";

export function useCollectionScope(): CollectionScope | null {
  const identity = useIdentityQuery();
  const relayUrl = useRelayOrigin();
  const ownerPubkey = identity.data?.pubkey;
  return relayUrl && ownerPubkey ? { relayUrl, ownerPubkey } : null;
}
