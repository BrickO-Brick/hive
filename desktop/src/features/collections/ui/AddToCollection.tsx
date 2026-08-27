import { Check, FolderPlus } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { useCollectionMutations, useCollectionsQuery } from "../hooks";
import {
  collectionReferenceKey,
  useCollectionMembershipIndex,
} from "../membership";
import type { Collection, CollectionReference } from "../types";
import { useCollectionScope } from "../useCollectionScope";
import { Button } from "@/shared/ui/button";
import { CollectionGlyph } from "./CollectionGlyph";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/ui/dialog";

type AddToCollectionProps = {
  label?: string | null;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  reference: CollectionReference;
  trigger?: React.ReactNode | false;
};

/** Reusable item-surface action for adding one typed reference to a collection. */
export function AddToCollection({
  label,
  onOpenChange,
  open: controlledOpen,
  reference,
  trigger,
}: AddToCollectionProps) {
  const scope = useCollectionScope();
  const collections = useCollectionsQuery(scope);
  const { addMember } = useCollectionMutations(scope);
  const [internalOpen, setInternalOpen] = React.useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (nextOpen: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  const add = async (collectionId: string, collectionName: string) => {
    try {
      await addMember.mutateAsync({ collectionId, label, reference });
      toast.success(`Added to ${collectionName}`);
      setOpen(false);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string" && error.trim()
            ? error
            : "Could not add to collection";
      console.error("Could not add to collection", error);
      toast.error(message);
    }
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      {trigger !== false ? (
        <DialogTrigger asChild>
          {trigger ?? (
            <Button size="sm" variant="outline">
              <FolderPlus className="h-4 w-4" />
              Add to collection
            </Button>
          )}
        </DialogTrigger>
      ) : null}
      <DialogContent
        className="max-w-md"
        data-testid="add-to-collection-dialog"
      >
        <DialogHeader>
          <DialogTitle>Add to collection</DialogTitle>
          <DialogDescription>
            Choose where this {reference.type} belongs.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {open ? (
            <CollectionPickerRows
              collections={collections.data ?? []}
              isAdding={addMember.isPending}
              onAdd={add}
              reference={reference}
            />
          ) : null}
          {!collections.isPending && (collections.data?.length ?? 0) === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {collections.isError
                ? "Could not load collections."
                : "Create a collection first."}
            </p>
          ) : null}
          {collections.isError ? (
            <Button
              onClick={() => void collections.refetch()}
              variant="outline"
            >
              Try again
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CollectionPickerRows({
  collections,
  isAdding,
  onAdd,
  reference,
}: {
  collections: readonly Collection[];
  isAdding: boolean;
  onAdd: (collectionId: string, collectionName: string) => Promise<void>;
  reference: CollectionReference;
}) {
  const scope = useCollectionScope();
  const { removeMember } = useCollectionMutations(scope);
  const memberships = useCollectionMembershipIndex().get(
    collectionReferenceKey(reference),
  );
  const membershipsByCollection = new Map(
    (memberships ?? []).map((membership) => [
      membership.collection.id,
      membership,
    ]),
  );

  const remove = async (
    collectionId: string,
    collectionName: string,
    memberId: string,
  ) => {
    if (!window.confirm(`Remove from Collection “${collectionName}”?`)) return;
    try {
      await removeMember.mutateAsync({ collectionId, memberId });
      toast.success(`Removed from ${collectionName}`);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not remove from collection",
      );
    }
  };

  return collections.map((collection) => {
    const membership = membershipsByCollection.get(collection.id);
    return (
      <Button
        className="justify-start"
        disabled={isAdding || removeMember.isPending}
        key={collection.id}
        onClick={() => {
          if (membership) {
            void remove(collection.id, collection.name, membership.member.id);
          } else {
            void onAdd(collection.id, collection.name);
          }
        }}
        variant="outline"
      >
        <CollectionGlyph className="h-4 w-4" collection={collection} />
        {collection.name}
        <Check
          className={`ml-auto h-4 w-4 ${membership ? "opacity-100" : "opacity-0"}`}
        />
      </Button>
    );
  });
}
