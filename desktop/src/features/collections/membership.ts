import { useQueries } from "@tanstack/react-query";
import * as React from "react";

import { getCollection } from "./api";
import { collectionsQueryKey, useCollectionsQuery } from "./hooks";
import type {
  Collection,
  CollectionMember,
  CollectionReference,
} from "./types";
import { useCollectionScope } from "./useCollectionScope";

export type CollectionMembership = {
  collection: Collection;
  member: CollectionMember;
};

export function collectionReferenceKey(reference: CollectionReference): string {
  switch (reference.type) {
    case "channel":
      return `channel:${reference.channel_id}`;
    case "message":
      return `message:${reference.channel_id}:${reference.event_id}`;
    case "thread":
      return `thread:${reference.channel_id}:${reference.root_event_id}`;
    case "repository":
      return `repository:${reference.coordinate}`;
    case "task":
      return `task:${reference.repository}:${reference.event_id}`;
    case "note":
      return `note:${reference.coordinate}`;
    case "external":
      return `external:${reference.url}`;
  }
}

/** Build one cached explicit-reference index for the currently visible surface. */
export function useCollectionMembershipIndex(enabled = true) {
  const scope = useCollectionScope();
  const activeScope = enabled ? scope : null;
  const collections = useCollectionsQuery(activeScope);
  const details = useQueries({
    queries: (collections.data ?? []).map((collection) => ({
      enabled: activeScope !== null,
      queryFn: () => {
        if (!activeScope) throw new Error("Collection scope is unavailable");
        return getCollection(activeScope, collection.id);
      },
      queryKey: activeScope
        ? [...collectionsQueryKey(activeScope), collection.id]
        : ["collections", "disabled", collection.id],
      staleTime: 30_000,
    })),
  });

  return React.useMemo(() => {
    const index = new Map<string, CollectionMembership[]>();
    for (const detail of details) {
      if (!detail.data) continue;
      for (const member of detail.data.members) {
        const key = collectionReferenceKey(member.reference);
        const memberships = index.get(key) ?? [];
        memberships.push({ collection: detail.data.collection, member });
        index.set(key, memberships);
      }
    }
    return index;
  }, [details]);
}
