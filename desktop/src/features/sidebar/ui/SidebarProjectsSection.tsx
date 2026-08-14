import { useLocation } from "@tanstack/react-router";
import {
  ArrowUpDown,
  ChevronDown,
  FolderGit2,
  Folders,
  Link2,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import {
  type Project,
  useDeleteProjectMutation,
  useProjectsQuery,
} from "@/features/projects/hooks";
import { isProjectOwnedByCurrentUser } from "@/features/projects/lib/projectsViewHelpers";
import { projectShareLink } from "@/features/projects/lib/projectShareLinks";
import { projectMatchesRouteId } from "@/features/projects/projectRoutes";
import { CreateProjectDialog } from "@/features/projects/ui/CreateProjectDialog";
import { useCreateProjectMutation } from "@/features/projects/useCreateProject";
import { useIdentityQuery } from "@/shared/api/hooks";
import { FeatureGate } from "@/shared/features";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { cn } from "@/shared/lib/cn";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
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

import {
  ContextMenuIconSlot,
  deferMenuAction,
} from "@/features/sidebar/ui/sidebarMenuHelpers";
import {
  SECTION_ACTION_VISIBILITY_CLASS,
  SECTION_ICON_BUTTON_CLASS,
} from "@/features/sidebar/ui/sidebarSectionStyles";
import {
  listSidebarProjects,
  readSidebarProjectsFilter,
  readSidebarProjectsSort,
  selectedProjectRouteId,
  type SidebarProjectsFilter,
  type SidebarProjectsSort,
  writeSidebarProjectsFilter,
  writeSidebarProjectsSort,
} from "@/features/sidebar/ui/listSidebarProjects";

const SECTION_LABEL_BUTTON_CLASS =
  "group/section-label flex w-fit max-w-[calc(100%-3rem)] cursor-pointer appearance-none items-center gap-1 text-left transition-colors hover:text-sidebar-foreground focus-visible:text-sidebar-foreground";
const SECTION_LABEL_CHEVRON_CLASS =
  "relative size-2.5 shrink-0 text-current opacity-0 transition-[color,opacity] group-hover/sidebar-section:opacity-100 group-hover/section-label:opacity-100 group-focus-within/sidebar-section:opacity-100 group-focus-visible/section-label:opacity-100 group-data-[section-actions-open=true]/sidebar-section:opacity-100";
const SECTION_LABEL_CHEVRON_ICON_CLASS =
  "absolute left-1/2 top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2";

/**
 * Collapsible list of the viewer's projects in the left sidebar. Rendered
 * only when the Projects experiment is enabled, and only includes projects
 * the viewer owns or contributes to (optionally owned-only).
 */
export function SidebarProjectsSection() {
  return (
    <FeatureGate feature="projects">
      <SidebarProjectsSectionContent />
    </FeatureGate>
  );
}

function SidebarProjectsSectionContent() {
  const projectsQuery = useProjectsQuery();
  const identityQuery = useIdentityQuery();
  const currentPubkey = identityQuery.data?.pubkey;
  const { goProject, goProjects } = useAppNavigation();
  const pathname = useLocation({ select: (location) => location.pathname });
  const routeProjectId = selectedProjectRouteId(pathname);
  const [collapsed, setCollapsed] = React.useState(false);
  const [actionsOpen, setActionsOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [projectToDelete, setProjectToDelete] = React.useState<Project | null>(
    null,
  );
  const [filter, setFilter] = React.useState<SidebarProjectsFilter>(
    readSidebarProjectsFilter,
  );
  const [sort, setSort] = React.useState<SidebarProjectsSort>(
    readSidebarProjectsSort,
  );
  const createProjectMutation = useCreateProjectMutation();
  const deleteProjectMutation = useDeleteProjectMutation();
  const isPending = projectsQuery.isPending || identityQuery.isPending;
  const projects = React.useMemo(
    () =>
      listSidebarProjects({
        currentPubkey,
        filter,
        projects: projectsQuery.data ?? [],
        sort,
      }),
    [currentPubkey, filter, projectsQuery.data, sort],
  );

  const handleFilterChange = (next: SidebarProjectsFilter) => {
    setFilter(next);
    writeSidebarProjectsFilter(next);
  };
  const handleSortChange = (next: SidebarProjectsSort) => {
    setSort(next);
    writeSidebarProjectsSort(next);
  };

  const handleDelete = React.useCallback(
    async (project: Project) => {
      try {
        await deleteProjectMutation.mutateAsync(project);
        toast.success("Project deleted");
        if (
          routeProjectId != null &&
          projectMatchesRouteId(project, routeProjectId)
        ) {
          await goProjects();
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to delete project",
        );
      } finally {
        setProjectToDelete(null);
      }
    },
    [deleteProjectMutation, goProjects, routeProjectId],
  );

  return (
    <SidebarGroup
      className="group/sidebar-section select-none"
      data-section-actions-open={actionsOpen || undefined}
      data-testid="sidebar-projects-section"
    >
      <div className="relative">
        <SidebarGroupLabel asChild>
          <button
            aria-controls="sidebar-projects"
            aria-expanded={!collapsed}
            className={SECTION_LABEL_BUTTON_CLASS}
            data-testid="sidebar-projects-section-label"
            onClick={() => setCollapsed((current) => !current)}
            type="button"
          >
            <span data-sidebar-section-title>Projects</span>
            <span aria-hidden="true" className={SECTION_LABEL_CHEVRON_CLASS}>
              <ChevronDown
                className={cn(
                  SECTION_LABEL_CHEVRON_ICON_CLASS,
                  collapsed ? "-rotate-90" : "rotate-0",
                )}
              />
            </span>
          </button>
        </SidebarGroupLabel>
        <SidebarProjectsHeaderActions
          filter={filter}
          onBrowseAll={() => void goProjects()}
          onCreate={() => setCreateOpen(true)}
          onFilterChange={handleFilterChange}
          onOpenChange={setActionsOpen}
          onSortChange={handleSortChange}
          sort={sort}
        />
      </div>
      {!collapsed ? (
        <SidebarGroupContent id="sidebar-projects">
          {projects.length > 0 ? (
            <SidebarMenu data-testid="sidebar-projects">
              {projects.map((project) => (
                <SidebarProjectRow
                  canDelete={isProjectOwnedByCurrentUser(
                    project,
                    currentPubkey,
                  )}
                  deleteDisabled={deleteProjectMutation.isPending}
                  isActive={
                    routeProjectId != null &&
                    projectMatchesRouteId(project, routeProjectId)
                  }
                  key={project.id}
                  onDelete={() => setProjectToDelete(project)}
                  onOpen={() => goProject(project.id)}
                  project={project}
                />
              ))}
            </SidebarMenu>
          ) : isPending ? null : (
            <p className="px-2 py-1 text-xs text-sidebar-foreground/50">
              No projects yet
            </p>
          )}
        </SidebarGroupContent>
      ) : null}
      <CreateProjectDialog
        isCreating={createProjectMutation.isPending}
        onCreate={async (input) => {
          const result = await createProjectMutation.mutateAsync(input);
          if (result.compatibilityWarning) {
            toast.warning("Created as a standalone project", {
              description: result.compatibilityWarning,
            });
          } else {
            toast.success(`Project "${result.project.name}" created.`);
          }
          await goProject(result.project.id);
        }}
        onOpenChange={setCreateOpen}
        open={createOpen}
      />
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setProjectToDelete(null);
        }}
        open={projectToDelete != null}
      >
        <AlertDialogContent
          data-testid={
            projectToDelete
              ? `sidebar-project-delete-confirm-${projectToDelete.dtag}`
              : undefined
          }
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete {projectToDelete?.name} from Projects for everyone. This
              can only be done for projects you own and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button
                disabled={deleteProjectMutation.isPending}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                data-testid={
                  projectToDelete
                    ? `sidebar-project-delete-confirm-button-${projectToDelete.dtag}`
                    : undefined
                }
                disabled={deleteProjectMutation.isPending || !projectToDelete}
                onClick={(event) => {
                  event.preventDefault();
                  if (projectToDelete) void handleDelete(projectToDelete);
                }}
                type="button"
                variant="destructive"
              >
                {deleteProjectMutation.isPending
                  ? "Deleting..."
                  : "Delete project"}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarGroup>
  );
}

function SidebarProjectsHeaderActions({
  filter,
  onBrowseAll,
  onCreate,
  onFilterChange,
  onOpenChange,
  onSortChange,
  sort,
}: {
  filter: SidebarProjectsFilter;
  onBrowseAll: () => void;
  onCreate: () => void;
  onFilterChange: (filter: SidebarProjectsFilter) => void;
  onOpenChange: (open: boolean) => void;
  onSortChange: (sort: SidebarProjectsSort) => void;
  sort: SidebarProjectsSort;
}) {
  const settingsTriggerRef = React.useRef<HTMLButtonElement>(null);

  return (
    <div className="absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5">
      <button
        aria-label="Create project"
        className={cn(
          SECTION_ICON_BUTTON_CLASS,
          SECTION_ACTION_VISIBILITY_CLASS,
        )}
        data-testid="sidebar-projects-create"
        onClick={(event) => {
          event.stopPropagation();
          onCreate();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        title="Create project"
        type="button"
      >
        <Plus className="h-4 w-4" />
      </button>
      <DropdownMenu onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="Project section settings"
            className={cn(
              SECTION_ICON_BUTTON_CLASS,
              SECTION_ACTION_VISIBILITY_CLASS,
            )}
            data-testid="sidebar-projects-settings"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            ref={settingsTriggerRef}
            type="button"
          >
            <Settings2 className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            settingsTriggerRef.current?.blur();
          }}
        >
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Folders className="h-4 w-4" />
              <span>Show</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                onValueChange={(value) =>
                  onFilterChange(value as SidebarProjectsFilter)
                }
                value={filter}
              >
                <DropdownMenuRadioItem value="mine">Mine</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="owned">
                  Owned by me
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ArrowUpDown className="h-4 w-4" />
              <span>Sort</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                onValueChange={(value) =>
                  onSortChange(value as SidebarProjectsSort)
                }
                value={sort}
              >
                <DropdownMenuRadioItem value="name">A–Z</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="created">
                  Newest
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => deferMenuAction(onBrowseAll)}>
            <FolderGit2 className="h-4 w-4" />
            <span>Browse all projects</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SidebarProjectRow({
  canDelete,
  deleteDisabled,
  isActive,
  onDelete,
  onOpen,
  project,
}: {
  canDelete: boolean;
  deleteDisabled: boolean;
  isActive: boolean;
  onDelete: () => void;
  onOpen: () => void;
  project: Project;
}) {
  const shareLink = projectShareLink(project);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <SidebarMenuItem>
          <SidebarMenuButton
            data-testid={`sidebar-project-${project.dtag}`}
            isActive={isActive}
            onClick={onOpen}
            tooltip={project.name}
            type="button"
          >
            <FolderGit2 className="h-4 w-4" />
            <SidebarMenuLabel>{project.name}</SidebarMenuLabel>
          </SidebarMenuButton>
          {canDelete ? (
            <SidebarMenuAction
              aria-label={`Delete ${project.name}`}
              data-testid={`sidebar-project-delete-${project.dtag}`}
              disabled={deleteDisabled}
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
              showOnHover
              type="button"
            >
              <Trash2 />
            </SidebarMenuAction>
          ) : null}
        </SidebarMenuItem>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {shareLink ? (
          <ContextMenuItem
            onSelect={() =>
              deferMenuAction(() =>
                copyTextToClipboard(shareLink, "Link copied to clipboard"),
              )
            }
          >
            <ContextMenuIconSlot>
              <Link2 className="h-4 w-4" />
            </ContextMenuIconSlot>
            <span>Copy link</span>
          </ContextMenuItem>
        ) : null}
        {canDelete ? (
          <>
            {shareLink ? <ContextMenuSeparator /> : null}
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              data-testid={`sidebar-project-delete-menu-${project.dtag}`}
              disabled={deleteDisabled}
              onSelect={() => deferMenuAction(onDelete)}
            >
              <ContextMenuIconSlot>
                <Trash2 className="h-4 w-4" />
              </ContextMenuIconSlot>
              <span>Delete project</span>
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
