import type { Project } from "@/features/projects/projectModels";
import {
  isProjectMine,
  isProjectOwnedByCurrentUser,
} from "@/features/projects/lib/projectsViewHelpers";

const SIDEBAR_PROJECTS_FILTER_KEY = "buzz.sidebar.projects.filter";
const SIDEBAR_PROJECTS_SORT_KEY = "buzz.sidebar.projects.sort";

export type SidebarProjectsFilter = "mine" | "owned";
export type SidebarProjectsSort = "name" | "created";

export function selectedProjectRouteId(pathname: string): string | undefined {
  if (!pathname.startsWith("/projects/")) return undefined;
  const raw = pathname.slice("/projects/".length).split("/")[0];
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function readSidebarProjectsFilter(): SidebarProjectsFilter {
  try {
    const value = globalThis.localStorage?.getItem(SIDEBAR_PROJECTS_FILTER_KEY);
    return value === "owned" ? "owned" : "mine";
  } catch {
    return "mine";
  }
}

export function writeSidebarProjectsFilter(filter: SidebarProjectsFilter) {
  try {
    globalThis.localStorage?.setItem(SIDEBAR_PROJECTS_FILTER_KEY, filter);
  } catch {
    // Persistence is best-effort; the in-memory toggle still works.
  }
}

export function readSidebarProjectsSort(): SidebarProjectsSort {
  try {
    const value = globalThis.localStorage?.getItem(SIDEBAR_PROJECTS_SORT_KEY);
    return value === "created" ? "created" : "name";
  } catch {
    return "name";
  }
}

export function writeSidebarProjectsSort(sort: SidebarProjectsSort) {
  try {
    globalThis.localStorage?.setItem(SIDEBAR_PROJECTS_SORT_KEY, sort);
  } catch {
    // Persistence is best-effort; the in-memory toggle still works.
  }
}

export function listSidebarProjects({
  currentPubkey,
  filter,
  projects,
  sort,
}: {
  currentPubkey: string | undefined;
  filter: SidebarProjectsFilter;
  projects: readonly Project[];
  sort: SidebarProjectsSort;
}): Project[] {
  return [...projects]
    .filter((project) =>
      filter === "owned"
        ? isProjectOwnedByCurrentUser(project, currentPubkey)
        : isProjectMine(project, currentPubkey),
    )
    .sort((left, right) => {
      if (sort === "created") {
        return (
          right.createdAt - left.createdAt ||
          left.name.localeCompare(right.name)
        );
      }
      return left.name.localeCompare(right.name);
    });
}
