import type {
  ProjectsFilter,
  ProjectsSort,
  ProjectsViewMode,
  ProjectsWorkItemScope,
} from "@/features/projects/lib/projectsViewHelpers";
import { ProjectsListScopeDropdown } from "@/features/projects/ui/ProjectsListScopeDropdown";
import { ProjectsViewModeToggle } from "@/features/projects/ui/ProjectsToolbar";

const PULL_REQUEST_SCOPE_OPTIONS: Array<{
  label: string;
  value: ProjectsWorkItemScope;
}> = [
  { label: "All", value: "all" },
  { label: "My Reviews", value: "mine" },
];
const ISSUE_SCOPE_OPTIONS: Array<{
  label: string;
  value: ProjectsWorkItemScope;
}> = [
  { label: "All", value: "all" },
  { label: "My Tasks", value: "mine" },
  { label: "Assigned to me", value: "assigned" },
];

type ProjectsListHeaderBarProps = {
  filter: ProjectsFilter;
  issueScope: ProjectsWorkItemScope;
  onIssueScopeChange: (scope: ProjectsWorkItemScope) => void;
  onPullRequestScopeChange: (scope: ProjectsWorkItemScope) => void;
  onSortChange: (sort: ProjectsSort) => void;
  onViewModeChange: (viewMode: ProjectsViewMode) => void;
  pullRequestScope: ProjectsWorkItemScope;
  sort: ProjectsSort;
  viewMode: ProjectsViewMode;
};

/**
 * Compact controls rendered in the Projects section header.
 */
export function ProjectsListHeaderBar({
  filter,
  issueScope,
  onIssueScopeChange,
  onPullRequestScopeChange,
  onSortChange,
  onViewModeChange,
  pullRequestScope,
  sort,
  viewMode,
}: ProjectsListHeaderBarProps) {
  const scopeDropdown =
    filter === "prs" ? (
      <ProjectsListScopeDropdown
        label="Filter reviews"
        onChange={onPullRequestScopeChange}
        options={PULL_REQUEST_SCOPE_OPTIONS}
        value={pullRequestScope}
      />
    ) : filter === "issues" ? (
      <ProjectsListScopeDropdown
        label="Filter tasks"
        onChange={onIssueScopeChange}
        options={ISSUE_SCOPE_OPTIONS}
        value={issueScope}
      />
    ) : null;

  return (
    <div
      className="ml-auto flex flex-wrap items-center justify-end gap-2"
      data-testid="projects-list-header"
    >
      {scopeDropdown}
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="sr-only">Sort projects</span>
        <select
          className="h-8 rounded-md bg-transparent px-2 text-xs text-foreground outline-hidden hover:bg-muted/50 focus:ring-1 focus:ring-ring"
          onChange={(event) => onSortChange(event.target.value as ProjectsSort)}
          value={sort}
        >
          <option value="updated">Recent activity</option>
          <option value="created">Created date</option>
          <option value="name">Name</option>
        </select>
      </label>
      <ProjectsViewModeToggle
        onViewModeChange={onViewModeChange}
        viewMode={viewMode}
      />
    </div>
  );
}
