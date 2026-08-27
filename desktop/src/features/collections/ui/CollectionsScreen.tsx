import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import { useCollectionMutations, useCollectionsQuery } from "../hooks";
import { useCollectionScope } from "../useCollectionScope";
import { CreateCollectionDialog } from "./CreateCollectionDialog";
import { CollectionGlyph } from "./CollectionGlyph";

export function CollectionsScreen() {
  const scope = useCollectionScope();
  const collections = useCollectionsQuery(scope);
  const { create } = useCollectionMutations(scope);
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = React.useState(false);

  return (
    <main
      className="h-full overflow-y-auto p-6"
      data-testid="collections-screen"
    >
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Collections</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Related work and context in one place.
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            New collection
          </Button>
        </header>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(collections.data ?? []).map((collection) => (
            <button
              className="rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent"
              data-testid={`collection-card-${collection.id}`}
              key={collection.id}
              onClick={() =>
                void navigate({
                  to: "/collections/$collectionId",
                  params: { collectionId: collection.id },
                })
              }
              type="button"
            >
              <CollectionGlyph
                className="mb-3 h-5 w-5 text-muted-foreground"
                collection={collection}
              />
              <div className="font-medium">{collection.name}</div>
            </button>
          ))}
        </div>
        {collections.isError ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
            <span>Could not load collections.</span>
            <Button
              onClick={() => void collections.refetch()}
              size="sm"
              variant="outline"
            >
              Try again
            </Button>
          </div>
        ) : null}
        {!collections.isPending &&
        !collections.isError &&
        (collections.data?.length ?? 0) === 0 ? (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            Create a collection to start grouping related work.
          </div>
        ) : null}
      </div>
      <CreateCollectionDialog
        isCreating={create.isPending}
        onCreate={async (name, icon) => {
          try {
            const collection = await create.mutateAsync({ icon, name });
            await navigate({
              to: "/collections/$collectionId",
              params: { collectionId: collection.id },
            });
          } catch (error) {
            toast.error(
              error instanceof Error
                ? error.message
                : "Could not create collection",
            );
            throw error;
          }
        }}
        onOpenChange={setCreateOpen}
        open={createOpen}
      />
    </main>
  );
}
