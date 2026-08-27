import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  ChevronDown,
  Folders,
  Palette,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { FeatureGate } from "@/shared/features";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/shared/ui/sidebar";
import { SidebarMenuLabel } from "@/shared/ui/sidebar-menu-label";
import type { Collection } from "../types";
import { useCollectionMutations, useCollectionsQuery } from "../hooks";
import { useCollectionScope } from "../useCollectionScope";
import { CreateCollectionDialog } from "./CreateCollectionDialog";
import { CollectionGlyph } from "./CollectionGlyph";
import { CollectionIconDialog } from "./CollectionIconDialog";
import { RenameCollectionDialog } from "./RenameCollectionDialog";

export function SidebarCollectionsSection() {
  return (
    <FeatureGate feature="collections">
      <SidebarCollectionsSectionContent />
    </FeatureGate>
  );
}

function SidebarCollectionsSectionContent() {
  const scope = useCollectionScope();
  const collections = useCollectionsQuery(scope);
  const { create } = useCollectionMutations(scope);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const [collapsed, setCollapsed] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);

  return (
    <SidebarGroup
      className="group/sidebar-section select-none"
      data-testid="sidebar-collections-section"
    >
      <div className="relative">
        <SidebarGroupLabel asChild>
          <button
            aria-expanded={!collapsed}
            className="group flex w-fit items-center gap-1 text-left"
            data-testid="sidebar-collections-section-label"
            onClick={() => setCollapsed((current) => !current)}
            type="button"
          >
            <span>Collections</span>
            <ChevronDown
              className={`h-3 w-3 transition-transform ${collapsed ? "-rotate-90" : ""}`}
            />
          </button>
        </SidebarGroupLabel>
        <SidebarMenuAction
          aria-label="Create collection"
          data-testid="sidebar-collections-create"
          onClick={() => setCreateOpen(true)}
          showOnHover
        >
          <Plus className="h-4 w-4" />
        </SidebarMenuAction>
      </div>
      {!collapsed ? (
        <SidebarGroupContent>
          <SidebarMenu data-testid="sidebar-collections">
            <SidebarMenuItem>
              <SidebarMenuButton
                data-testid="open-collections-view"
                isActive={pathname === "/collections"}
                onClick={() => void navigate({ to: "/collections" })}
                tooltip="All collections"
                type="button"
              >
                <Folders className="h-4 w-4" />
                <SidebarMenuLabel>All collections</SidebarMenuLabel>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {(collections.data ?? []).map((collection) => (
              <SidebarCollectionItem
                collection={collection}
                isActive={pathname === `/collections/${collection.id}`}
                key={collection.id}
              />
            ))}
            {collections.isError ? (
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => void collections.refetch()}
                  tooltip="Retry loading collections"
                  type="button"
                >
                  <span className="truncate text-xs text-destructive">
                    Could not load · Retry
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
          </SidebarMenu>
        </SidebarGroupContent>
      ) : null}
      <CreateCollectionDialog
        isCreating={create.isPending}
        onCreate={async (name, icon) => {
          try {
            const collection = await create.mutateAsync({ icon, name });
            toast.success(`Collection “${collection.name}” created`);
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
    </SidebarGroup>
  );
}

function SidebarCollectionItem({
  collection,
  isActive,
}: {
  collection: Collection;
  isActive: boolean;
}) {
  const scope = useCollectionScope();
  const { remove, setIcon, setName } = useCollectionMutations(scope);
  const navigate = useNavigate();
  const [iconOpen, setIconOpen] = React.useState(false);
  const [renameOpen, setRenameOpen] = React.useState(false);

  return (
    <>
      <ContextMenu>
        <SidebarMenuItem>
          <ContextMenuTrigger asChild>
            <SidebarMenuButton
              data-testid={`sidebar-collection-${collection.id}`}
              isActive={isActive}
              onClick={() =>
                void navigate({
                  to: "/collections/$collectionId",
                  params: { collectionId: collection.id },
                })
              }
              tooltip={collection.name}
              type="button"
            >
              <CollectionGlyph className="h-4 w-4" collection={collection} />
              <SidebarMenuLabel>{collection.name}</SidebarMenuLabel>
            </SidebarMenuButton>
          </ContextMenuTrigger>
        </SidebarMenuItem>
        <ContextMenuContent data-testid={`collection-context-${collection.id}`}>
          <ContextMenuItem onSelect={() => setRenameOpen(true)}>
            <Pencil /> Rename
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setIconOpen(true)}>
            <Palette /> Change icon
          </ContextMenuItem>
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => {
              if (!window.confirm(`Delete “${collection.name}”?`)) return;
              void remove
                .mutateAsync(collection.id)
                .then(() => {
                  if (isActive) return navigate({ to: "/collections" });
                })
                .catch((error) =>
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : "Could not delete Collection",
                  ),
                );
            }}
          >
            <Trash2 /> Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <RenameCollectionDialog
        isSaving={setName.isPending}
        name={collection.name}
        onOpenChange={setRenameOpen}
        onSave={async (name) => {
          try {
            await setName.mutateAsync({ collectionId: collection.id, name });
            toast.success("Collection renamed");
          } catch (error) {
            toast.error(
              error instanceof Error
                ? error.message
                : "Could not rename Collection",
            );
            throw error;
          }
        }}
        open={renameOpen}
      />
      <CollectionIconDialog
        icon={collection.icon}
        isSaving={setIcon.isPending}
        onOpenChange={setIconOpen}
        onSave={async (icon) => {
          try {
            await setIcon.mutateAsync({
              collectionId: collection.id,
              icon,
            });
            toast.success("Collection icon updated");
          } catch (error) {
            toast.error(
              error instanceof Error
                ? error.message
                : "Could not update Collection icon",
            );
            throw error;
          }
        }}
        open={iconOpen}
      />
    </>
  );
}
