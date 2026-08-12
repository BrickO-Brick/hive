// Issue assignment mirrors PR review requests (projectPullRequests.mjs):
// a kind:1 comment labeled with this `t` tag whose `p` tags are the
// assignees. Labeled text notes stay readable for any client that treats
// them as plain comments, and the `p` tags route the assignment into the
// assignee's mention feed (inbox) for free.
export const ISSUE_ASSIGNMENT_LABEL = "assignment";

export const PROJECT_ISSUE_STATUS = {
  TRIAGE: "Triage",
  BACKLOG: "Backlog",
  IN_PROGRESS: "In Progress",
  IN_REVIEW: "In Review",
  DONE: "Done",
  CLOSED: "Closed",
};

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function getTag(event, name) {
  const value = event.tags.find((tag) => tag[0] === name)?.[1];
  return isNonEmptyString(value) ? value : undefined;
}

export function getAllTags(event, name) {
  return event.tags
    .filter((tag) => tag[0] === name && isNonEmptyString(tag[1]))
    .map((tag) => tag[1]);
}

export function getImetaTags(event) {
  return event.tags.filter((tag) => tag[0] === "imeta");
}

function repoOwnerFromAddress(repoAddress) {
  const owner = (repoAddress ?? "").split(":")[1] ?? "";
  return /^[a-fA-F0-9]{64}$/.test(owner) ? owner.toLowerCase() : null;
}

/**
 * Pubkeys allowed to change a root event's lifecycle (status, updates):
 * the root author and the owner of the repo the root event targets.
 * Anyone else's status/update events are ignored (NIP-34 scopes these
 * to the root author or a maintainer).
 */
export function allowedActorsForRoot(rootEvent) {
  const allowed = new Set([rootEvent.pubkey.toLowerCase()]);
  const owner = repoOwnerFromAddress(getTag(rootEvent, "a"));
  if (owner) allowed.add(owner);
  return allowed;
}

function latestStatusForIssue(issue, statusEvents) {
  const allowedActors = allowedActorsForRoot(issue);
  return statusEvents
    .filter(
      (event) =>
        allowedActors.has(event.pubkey.toLowerCase()) &&
        event.tags.some((tag) => tag[0] === "e" && tag[1] === issue.id),
    )
    .sort((left, right) => right.created_at - left.created_at)[0];
}

function statusFromEvent(issue, statusEvent) {
  if (statusEvent?.kind === 1631) return PROJECT_ISSUE_STATUS.DONE;
  if (statusEvent?.kind === 1632) return PROJECT_ISSUE_STATUS.CLOSED;
  // NIP-34 calls 1633 "Draft"; we surface it as Triage for issues. The
  // label-based fallbacks below are client-side heuristics, not protocol.
  if (statusEvent?.kind === 1633) return PROJECT_ISSUE_STATUS.TRIAGE;

  const labels = getAllTags(issue, "t").map((label) => label.toLowerCase());
  if (labels.includes("in-review") || labels.includes("review")) {
    return PROJECT_ISSUE_STATUS.IN_REVIEW;
  }
  if (labels.includes("in-progress") || labels.includes("active")) {
    return PROJECT_ISSUE_STATUS.IN_PROGRESS;
  }
  if (labels.includes("triage")) return PROJECT_ISSUE_STATUS.TRIAGE;
  return PROJECT_ISSUE_STATUS.BACKLOG;
}

/**
 * Assignees resolve from two trusted sources:
 *
 * 1. The issue event's own `p` tags: the author "sends" an issue to
 *    people by p-tagging them (which routes it to their inbox), and the
 *    author is a trusted assigner — so those recipients count as
 *    assignees. The repo owner's `p` tag is excluded because every
 *    issue carries it for routing (see `buildGitIssueTags`), not as an
 *    assignment; owners get assigned via an explicit assignment event.
 * 2. `p` tags of trusted assignment comments (kind:1 labeled
 *    `t: assignment`). Trusted signers are the issue author and repo
 *    owner (who may assign anyone), plus any community member whose
 *    assignment names only themselves — self-assignment is safe to open
 *    up because a signer can only volunteer for work, never route it to
 *    someone else.
 */
function assigneesForIssue(issue, commentEvents) {
  const allowedActors = allowedActorsForRoot(issue);
  const assignees = new Set();
  const repoOwner = repoOwnerFromAddress(getTag(issue, "a"));
  for (const recipient of getAllTags(issue, "p")) {
    const normalized = recipient.toLowerCase();
    if (normalized !== repoOwner) assignees.add(normalized);
  }
  for (const event of commentEvents) {
    if (!event.tags.some((tag) => tag[0] === "e" && tag[1] === issue.id)) {
      continue;
    }
    if (!getAllTags(event, "t").includes(ISSUE_ASSIGNMENT_LABEL)) continue;
    const signer = event.pubkey.toLowerCase();
    const pubkeys = getAllTags(event, "p").map((pubkey) =>
      pubkey.toLowerCase(),
    );
    const isSelfAssignment = pubkeys.length === 1 && pubkeys[0] === signer;
    if (!allowedActors.has(signer) && !isSelfAssignment) continue;
    for (const pubkey of pubkeys) {
      assignees.add(pubkey);
    }
  }
  return [...assignees];
}

function commentsForIssue(issueId, commentEvents) {
  return commentEvents
    .filter((event) =>
      event.tags.some(
        (tag) => (tag[0] === "e" || tag[0] === "E") && tag[1] === issueId,
      ),
    )
    .sort((left, right) => left.created_at - right.created_at)
    .map((event) => ({
      id: event.id,
      content: event.content,
      tags: getImetaTags(event),
      author: event.pubkey,
      createdAt: event.created_at,
    }));
}

export function eventToProjectIssue(
  issue,
  statusEvents = [],
  commentEvents = [],
) {
  const latestStatus = latestStatusForIssue(issue, statusEvents);
  const comments = commentsForIssue(issue.id, commentEvents);
  const title =
    getTag(issue, "subject") ||
    issue.content.split("\n")[0] ||
    "Untitled issue";

  return {
    id: issue.id,
    title,
    content: issue.content,
    tags: getImetaTags(issue),
    author: issue.pubkey,
    createdAt: issue.created_at,
    repoAddress: getTag(issue, "a") ?? null,
    channelId: getTag(issue, "h") ?? null,
    originAgentName: getTag(issue, "buzz-origin-agent") ?? null,
    labels: getAllTags(issue, "t"),
    recipients: getAllTags(issue, "p"),
    assignees: assigneesForIssue(issue, commentEvents),
    status: statusFromEvent(issue, latestStatus),
    statusEventId: latestStatus?.id ?? null,
    updatedAt:
      [
        ...comments,
        ...(latestStatus ? [{ createdAt: latestStatus.created_at }] : []),
      ].sort((left, right) => right.createdAt - left.createdAt)[0]?.createdAt ??
      issue.created_at,
    comments,
  };
}

export function projectIssueEventsToIssues(
  issueEvents,
  statusEvents = [],
  commentEvents = [],
) {
  return [...issueEvents]
    .map((issue) => eventToProjectIssue(issue, statusEvents, commentEvents))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

/** Keep consecutive comments ordered across whole-second Nostr timestamps. */
export function nextProjectIssueCommentCreatedAt(issue, now, author) {
  const normalizedAuthor = author.toLowerCase();
  return Math.max(
    now,
    ...issue.comments
      .filter((comment) => comment.author.toLowerCase() === normalizedAuthor)
      .map((comment) => comment.createdAt + 1),
  );
}

export function buildGitIssueTags({
  repoAddress,
  repoOwner,
  title,
  labels = [],
}) {
  if (!repoAddress.startsWith("30617:")) {
    throw new Error("Issue repo address must reference a kind:30617 repo.");
  }
  if (!/^[a-fA-F0-9]{64}$/.test(repoOwner)) {
    throw new Error("Repo owner must be 64 hex characters.");
  }
  const subject = title.trim();
  if (!subject) {
    throw new Error("Issue title is required.");
  }
  if (subject.length > 256) {
    throw new Error("Issue title must be 256 characters or fewer.");
  }

  const tags = [
    ["a", repoAddress],
    ["p", repoOwner.toLowerCase()],
    ["subject", subject],
  ];

  for (const label of labels) {
    const trimmed = label.trim();
    if (trimmed) tags.push(["t", trimmed]);
  }

  return tags;
}

export function buildGitStatusTags({ issueId, repoAddress, repoOwner }) {
  if (!/^[a-fA-F0-9]{64}$/.test(issueId)) {
    throw new Error("Issue ID must be 64 hex characters.");
  }
  const tags = [["e", issueId, "", "root"]];
  if (repoAddress) tags.push(["a", repoAddress]);
  if (repoOwner && /^[a-fA-F0-9]{64}$/.test(repoOwner)) {
    tags.push(["p", repoOwner.toLowerCase()]);
  }
  return tags;
}
