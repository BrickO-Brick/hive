import { useNavigate } from "@tanstack/react-router";

import { Button } from "@/shared/ui/button";
import {
  collectionReferenceKey,
  useCollectionMembershipIndex,
} from "../membership";
import type { CollectionReference } from "../types";
import { CollectionGlyph } from "./CollectionGlyph";

export function CollectionMembershipBadges({
  reference,
  references,
}: {
  reference?: CollectionReference;
  references?: readonly CollectionReference[];
}) {
  const navigate = useNavigate();
  const membershipIndex = useCollectionMembershipIndex();
  const requestedReferences = references ?? (reference ? [reference] : []);
  const memberships = [
    ...new Map(
      requestedReferences
        .flatMap(
          (requestedReference) =>
            membershipIndex.get(collectionReferenceKey(requestedReference)) ??
            [],
        )
        .map((membership) => [membership.collection.id, membership]),
    ).values(),
  ];
  if (memberships.length === 0) return null;

  const visible = memberships.slice(0, 3);
  return (
    <div
      className="flex items-center -space-x-1"
      data-testid="collection-membership-badges"
    >
      {visible.map(({ collection }) => (
        <Button
          aria-label={`Open Collection ${collection.name}`}
          className="rounded-full border bg-background"
          key={collection.id}
          onClick={() =>
            void navigate({
              to: "/collections/$collectionId",
              params: { collectionId: collection.id },
            })
          }
          size="icon-xs"
          title={collection.name}
          variant="ghost"
        >
          <CollectionGlyph className="h-3.5 w-3.5" collection={collection} />
        </Button>
      ))}
      {memberships.length > visible.length ? (
        <span className="pl-2 text-xs text-muted-foreground">
          +{memberships.length - visible.length}
        </span>
      ) : null}
    </div>
  );
}
