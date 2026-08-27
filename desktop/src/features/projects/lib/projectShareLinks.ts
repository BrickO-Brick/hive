/**
 * Share links for the Projects read models.
 *
 * Every builder returns `null` instead of throwing when the entity cannot be
 * addressed by a `buzz://` link — addressable d-tags accept a wider charset
 * (and 1024 bytes) than the link format's `[a-zA-Z0-9._-]{1,64}`, and issues
 * and pull requests loaded outside a repository have no coordinate at all.
 * Callers hide the share affordance on `null` rather than copying a link that
 * would not parse on the receiving side.
 */

import {
  KIND_PROJECT_ANNOUNCEMENT,
  KIND_REPO_ANNOUNCEMENT,
} from "@/shared/constants/kinds";
import {
  buildCommitLink,
  buildIssueLink,
  buildProjectLink,
  buildPullRequestLink,
  buildRepoLink,
  type EntityLinkTab,
  isLinkableCoordinate,
} from "@/shared/lib/entityLink";
import {
  type AddressableCoordinate,
  parseAddressableCoordinate,
} from "@/shared/lib/addressableCoordinate";

import type { ProjectIssue } from "../projectIssues.mjs";
import type { Project, Repository } from "../projectModels";
import type { ProjectPullRequest } from "../projectPullRequests.mjs";

const HEX64_RE = /^[a-fA-F0-9]{64}$/;
const GIT_OBJECT_ID_RE = /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;

function repositoryCoordinate(
  repoAddress: string | null | undefined,
): AddressableCoordinate | null {
  const coordinate = parseAddressableCoordinate(repoAddress);
  return coordinate?.kind === KIND_REPO_ANNOUNCEMENT ? coordinate : null;
}

/**
 * Map a workspace tab id (`WorkspaceTabs` vocabulary) onto the link format's
 * tab value. The overview tab is the link's default and PR-detail sub-tabs
 * have their own `buzz://pr` links, so both map to `undefined` (no tab).
 */
export function shareTabForWorkspaceTab(
  workspaceTab: string,
): EntityLinkTab | undefined {
  switch (workspaceTab) {
    case "files":
    case "issues":
    case "prs":
    case "contributors":
    case "channels":
      return workspaceTab;
    case "activity":
      return "commits";
    default:
      return undefined;
  }
}

/** Inverse of `shareTabForWorkspaceTab`, for the receiving side. */
export function workspaceTabForShareTab(tab: EntityLinkTab): string {
  return tab === "commits" ? "activity" : tab;
}

/**
 * Link to a project. Legacy (implicit) projects are backed by a repository
 * announcement rather than a kind:30621 event, so they share as `buzz://repo`
 * — which resolves to the same project route on the receiving side.
 */
export function projectShareLink(
  project: Project,
  tab?: EntityLinkTab,
): string | null {
  const coordinate = parseAddressableCoordinate(project.projectAddress);
  if (!coordinate || !isLinkableCoordinate(coordinate.owner, coordinate.dtag)) {
    return null;
  }

  if (coordinate.kind === KIND_PROJECT_ANNOUNCEMENT) {
    return buildProjectLink({ ...coordinate, tab });
  }
  return coordinate.kind === KIND_REPO_ANNOUNCEMENT
    ? buildRepoLink({ ...coordinate, tab })
    : null;
}

export function repositoryShareLink(repository: Repository): string | null {
  const coordinate = repositoryCoordinate(repository.repoAddress);
  return coordinate && isLinkableCoordinate(coordinate.owner, coordinate.dtag)
    ? buildRepoLink(coordinate)
    : null;
}

export function commitShareLink(
  repository: Repository,
  commitHash: string,
): string | null {
  const coordinate = repositoryCoordinate(repository.repoAddress);
  return coordinate &&
    GIT_OBJECT_ID_RE.test(commitHash) &&
    isLinkableCoordinate(coordinate.owner, coordinate.dtag)
    ? buildCommitLink({ ...coordinate, commitHash })
    : null;
}

export function issueShareLink(issue: ProjectIssue): string | null {
  const coordinate = repositoryCoordinate(issue.repoAddress);
  return coordinate &&
    HEX64_RE.test(issue.id) &&
    isLinkableCoordinate(coordinate.owner, coordinate.dtag)
    ? buildIssueLink({ ...coordinate, id: issue.id })
    : null;
}

export function pullRequestShareLink(
  pullRequest: ProjectPullRequest,
): string | null {
  const coordinate = repositoryCoordinate(pullRequest.repoAddress);
  return coordinate &&
    HEX64_RE.test(pullRequest.id) &&
    isLinkableCoordinate(coordinate.owner, coordinate.dtag)
    ? buildPullRequestLink({ ...coordinate, id: pullRequest.id })
    : null;
}
