import {
  type ProjectSelectionItem,
  projectSelectionTitle,
} from "./projectSelection.ts";

const PROJECT_PAGE_CONTEXT_MARKER = "Current Buzz project page:";

export type ProjectDetailAgentContext = {
  branch?: string | null;
  file?: { kind: "file" | "folder"; path: string } | null;
  projectName: string;
  repoAddress: string;
  repositoryName: string;
  source: "local" | "remote";
  selection?: Pick<
    ProjectSelectionItem,
    "id" | "kind" | "shareLink" | "title"
  >[];
  view: string;
  workItem?: {
    id: string;
    kind: "commit" | "review" | "task";
    status?: string;
    title: string;
  } | null;
};

export function buildProjectsOverviewAgentContext(
  view: string,
): ProjectDetailAgentContext {
  return {
    projectName: "Projects",
    repoAddress: "projects:overview",
    repositoryName: "All projects",
    source: "remote",
    view,
  };
}

export function buildProjectSelectionAgentContext(
  items: ProjectSelectionItem[],
): ProjectDetailAgentContext {
  const kind = items[0]?.kind ?? "project";
  return {
    projectName: "Projects",
    repoAddress: `selection:${kind}`,
    repositoryName: "Selected items",
    selection: items.map(({ id, kind: itemKind, shareLink, title }) => ({
      id,
      kind: itemKind,
      shareLink,
      title,
    })),
    source: "remote",
    view: projectSelectionTitle(items),
  };
}

export function withProjectSelectionAgentContext(
  context: ProjectDetailAgentContext,
  items: ProjectSelectionItem[],
): ProjectDetailAgentContext {
  return {
    ...context,
    selection: items.map(({ id, kind, shareLink, title }) => ({
      id,
      kind,
      shareLink,
      title,
    })),
    view: projectSelectionTitle(items),
  };
}

export function buildProjectDetailAgentContext({
  activeTab,
  branch,
  file,
  project,
  repository,
  source,
  workItems,
}: {
  activeTab: string;
  branch?: string | null;
  file?: ProjectDetailAgentContext["file"];
  project: { name: string };
  repository: { name: string; repoAddress: string };
  source: "local" | "remote";
  workItems: readonly [
    { hash: string; subject?: string | null } | null,
    { id: string; status?: string; title: string } | null,
    { id: string; status?: string; title: string } | null,
  ];
}): ProjectDetailAgentContext {
  const [commit, issue, pullRequest] = workItems;
  const viewLabels: Record<string, string> = {
    activity: "Commits",
    channels: "Channels",
    contributors: "Contributors",
    files: "Files",
    issues: "Tasks",
    overview: "Overview",
    prs: "Reviews",
  };
  const workItem = pullRequest
    ? {
        id: pullRequest.id,
        kind: "review" as const,
        status: pullRequest.status,
        title: pullRequest.title,
      }
    : issue
      ? {
          id: issue.id,
          kind: "task" as const,
          status: issue.status,
          title: issue.title,
        }
      : commit
        ? {
            id: commit.hash,
            kind: "commit" as const,
            title: commit.subject || commit.hash.slice(0, 7),
          }
        : null;
  return {
    branch,
    file: activeTab === "files" ? file : null,
    projectName: project.name,
    repoAddress: repository.repoAddress,
    repositoryName: repository.name,
    source,
    view: workItem
      ? `${workItem.kind[0]?.toUpperCase()}${workItem.kind.slice(1)} detail`
      : (viewLabels[activeTab] ?? activeTab),
    workItem,
  };
}

export function projectDetailAgentContextBlock(
  context: ProjectDetailAgentContext,
) {
  const lines = [
    "",
    "---",
    PROJECT_PAGE_CONTEXT_MARKER,
    `- Project: ${context.projectName}`,
    `- Repository: ${context.repositoryName} (${context.repoAddress})`,
    `- View: ${context.view}`,
    `- Source: ${context.source}`,
  ];
  if (context.branch) lines.push(`- Branch: ${context.branch}`);
  if (context.file) {
    lines.push(
      `- ${context.file.kind === "file" ? "File" : "Folder"}: ${context.file.path || "/"}`,
    );
  }
  if (context.workItem) {
    lines.push(
      `- ${context.workItem.kind}: ${context.workItem.title} (${context.workItem.id})`,
    );
    if (context.workItem.status) {
      lines.push(`- Status: ${context.workItem.status}`);
    }
  }
  if (context.selection?.length) {
    lines.push(`- Selection: ${context.view}`);
    for (const item of context.selection) {
      lines.push(
        `  - ${item.kind}: ${item.title} (${item.shareLink || item.id})`,
      );
    }
  }
  lines.push(
    "Use this current UI context to interpret the user's request. Do not claim access to data not supplied here or available through your tools.",
  );
  return lines.join("\n");
}

export function stripProjectDetailAgentContext(content: string) {
  const markerIndex = content.indexOf(`---\n${PROJECT_PAGE_CONTEXT_MARKER}`);
  if (markerIndex === -1) return content;
  return content.slice(0, markerIndex).replace(/\n+$/, "");
}
