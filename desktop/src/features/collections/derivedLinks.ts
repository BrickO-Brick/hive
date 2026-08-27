import type { RelayEvent } from "@/shared/api/types";

import type { CollectionMember } from "./types";

export type CollectionDiscoveredLink = {
  url: string;
  label: string;
  kind: string;
};

export type CollectionCalendarDocumentActivity = {
  action_type: "edit" | "comment";
  timestamp: string;
  actor_display_name: string | null;
  actor_email: string | null;
  document_title: string;
  document_url: string;
  document_file_id: string;
  source_calendar_url: string;
  source_attachment_url: string;
};

export type CollectionCalendarActivityResponse = {
  activities: CollectionCalendarDocumentActivity[];
  errors: Array<{ source_url: string; message: string }>;
};

export type CollectionGithubPullRequestActivity = {
  kind: "review" | "comment" | "merge";
  author: string | null;
  state: string | null;
  created_at: string;
  url: string | null;
  author_avatar_url: string | null;
};

export type CollectionGithubPullRequest = {
  url: string;
  title: string;
  state: string;
  author: string | null;
  author_avatar_url: string | null;
  updated_at: string;
  activity: CollectionGithubPullRequestActivity[];
};

export type DerivedCollectionLink = CollectionDiscoveredLink & {
  sourceMemberId: string;
};

export type DerivedCollectionWarning = {
  failureSourceUrl?: string;
  message: string;
  sourceLabel: string;
  sourceMemberId: string;
  warningType: "calendar" | "github-pr" | "source";
};

/** Collapse repeated resolver failures without hiding distinct attachments. */
export function deduplicateDerivedCollectionWarnings(
  warnings: readonly DerivedCollectionWarning[],
): DerivedCollectionWarning[] {
  const deduplicated = new Map<string, DerivedCollectionWarning>();
  for (const warning of warnings) {
    const identity = [
      warning.warningType,
      warning.sourceMemberId,
      warning.message,
      warning.failureSourceUrl ?? "",
    ].join(":");
    if (!deduplicated.has(identity)) deduplicated.set(identity, warning);
  }
  return [...deduplicated.values()];
}

export type DerivedCollectionActivity = DerivedCollectionLink & {
  activityType:
    | "calendar-document"
    | "channel-message"
    | "document-comment"
    | "document-edit"
    | "github-pr"
    | "github-pr-activity";
  actorLabel?: string;
  actorAvatarUrl?: string;
  actorIdentity?: string;
  authorPubkey?: string;
  channelId?: string;
  createdAt: number | null;
  derivedFromSource?: boolean;
  eventId?: string;
  provenanceLabel?: string;
  sourceEventIds?: string[];
  sourceMemberIds?: string[];
  sourceUrl?: string;
  stateLabel?: string;
  threadRootId?: string | null;
};

const WEB_URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const TRAILING_URL_PUNCTUATION = /[),.;:!?\]}]+$/u;
export const COLLECTION_PR_LIMIT_PER_SOURCE = 4;
export const COLLECTION_PR_LIMIT_OVERALL = 10;

/** Extract canonical GitHub pull-request URLs from message content. */
export function extractGitHubPullRequestLinks(
  events: readonly Pick<RelayEvent, "content">[],
): CollectionDiscoveredLink[] {
  const links = new Map<string, CollectionDiscoveredLink>();

  for (const event of events) {
    for (const match of event.content.matchAll(WEB_URL_PATTERN)) {
      const candidate = match[0].replace(TRAILING_URL_PUNCTUATION, "");
      let parsed: URL;
      try {
        parsed = new URL(candidate);
      } catch {
        continue;
      }
      if (
        parsed.protocol !== "https:" ||
        !["github.com", "www.github.com"].includes(
          parsed.hostname.toLocaleLowerCase(),
        )
      ) {
        continue;
      }

      const segments = parsed.pathname.split("/").filter(Boolean);
      if (
        segments.length < 4 ||
        segments[2]?.toLocaleLowerCase() !== "pull" ||
        !/^\d+$/u.test(segments[3] ?? "")
      ) {
        continue;
      }
      const [owner, repository, , number] = segments;
      if (!owner || !repository || !number) continue;

      const url = `https://github.com/${owner}/${repository}/pull/${number}`;
      const identity = url.toLocaleLowerCase();
      if (!links.has(identity)) {
        links.set(identity, {
          kind: "pull request",
          label: `${owner}/${repository} PR #${number}`,
          url,
        });
      }
    }
  }

  return [...links.values()];
}

function parseActivityTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1_000) : null;
}

/** Enrich a sourced PR mention with live status and recent GitHub activity. */
export function githubPullRequestToDerived(
  mention: DerivedCollectionActivity,
  pullRequest: CollectionGithubPullRequest,
): DerivedCollectionActivity[] {
  const label = pullRequest.title ?? mention.label;
  const status: DerivedCollectionActivity = {
    ...mention,
    actorLabel: pullRequest.author ?? undefined,
    actorAvatarUrl: pullRequest.author_avatar_url ?? undefined,
    actorIdentity: pullRequest.author
      ? `github:${pullRequest.author.toLocaleLowerCase()}`
      : mention.actorIdentity,
    createdAt:
      parseActivityTimestamp(pullRequest.updated_at) ?? mention.createdAt,
    label,
    stateLabel: pullRequest.state ?? undefined,
    url: pullRequest.url,
  };
  const activity = pullRequest.activity.flatMap(
    (item): DerivedCollectionActivity[] => {
      const createdAt = parseActivityTimestamp(item.created_at);
      if (createdAt === null) return [];
      return [
        {
          activityType: "github-pr-activity",
          actorLabel: item.author ?? undefined,
          actorAvatarUrl: item.author_avatar_url ?? undefined,
          actorIdentity: item.author
            ? `github:${item.author.toLocaleLowerCase()}`
            : undefined,
          channelId: mention.channelId,
          createdAt,
          eventId: mention.eventId,
          kind: `PR ${item.kind}`,
          label,
          provenanceLabel: mention.provenanceLabel,
          sourceMemberId: mention.sourceMemberId,
          sourceMemberIds: mention.sourceMemberIds,
          stateLabel: item.state ?? undefined,
          threadRootId: mention.threadRootId,
          url: item.url ?? pullRequest.url,
        },
      ];
    },
  );
  return [status, ...activity];
}

/** Keep the newest distinct sourced PR mentions within fixed discovery caps. */
export function capCollectionPullRequestMentions(
  activity: readonly DerivedCollectionActivity[],
  perSourceLimit = COLLECTION_PR_LIMIT_PER_SOURCE,
  overallLimit = COLLECTION_PR_LIMIT_OVERALL,
): DerivedCollectionActivity[] {
  const sourceCounts = new Map<string, number>();
  const selectedByUrl = new Map<string, DerivedCollectionActivity>();
  const newestFirst = Array.from(activity).filter(
    (item) => item.activityType === "github-pr",
  );
  newestFirst.sort(
    (left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0),
  );
  for (const item of newestFirst) {
    const identity = item.url.toLocaleLowerCase();
    const sourceCount = sourceCounts.get(item.sourceMemberId) ?? 0;
    if (sourceCount >= perSourceLimit) continue;
    const selected = selectedByUrl.get(identity);
    if (selected) {
      const sourceMemberIds = new Set(
        selected.sourceMemberIds ?? [selected.sourceMemberId],
      );
      sourceMemberIds.add(item.sourceMemberId);
      selected.sourceMemberIds = [...sourceMemberIds];
      const sourceEventIds = new Set(selected.sourceEventIds ?? []);
      if (item.eventId) sourceEventIds.add(item.eventId);
      selected.sourceEventIds = [...sourceEventIds];
      sourceCounts.set(item.sourceMemberId, sourceCount + 1);
      continue;
    }
    if (selectedByUrl.size >= overallLimit) continue;
    selectedByUrl.set(identity, {
      ...item,
      sourceEventIds: item.eventId ? [item.eventId] : [],
      sourceMemberIds: [item.sourceMemberId],
    });
    sourceCounts.set(item.sourceMemberId, sourceCount + 1);
  }
  return [...selectedByUrl.values()];
}

export function collectionChannelThreadProvenance(sourceLabel: string) {
  return `${sourceLabel} → live thread summary`;
}

export function isGoogleCalendarEventUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      ["www.google.com", "calendar.google.com"].includes(
        url.hostname.toLocaleLowerCase(),
      ) &&
      url.pathname === "/calendar/event" &&
      Boolean(url.searchParams.get("eid"))
    );
  } catch {
    return false;
  }
}

/** Convert sourced Drive activity into ephemeral chronological feed rows. */
export function calendarDocumentActivityToDerived(
  sourceMemberId: string,
  sourceLabel: string,
  activities: readonly CollectionCalendarDocumentActivity[],
): DerivedCollectionActivity[] {
  return activities.flatMap((activity) => {
    const timestamp = Date.parse(activity.timestamp);
    if (!Number.isFinite(timestamp)) return [];
    return [
      {
        activityType:
          activity.action_type === "comment"
            ? "document-comment"
            : "document-edit",
        actorLabel:
          activity.actor_display_name ??
          activity.actor_email ??
          "Unknown Google Drive actor",
        actorIdentity: activity.actor_email
          ? `google:${activity.actor_email.toLocaleLowerCase()}`
          : undefined,
        createdAt: Math.floor(timestamp / 1_000),
        kind:
          activity.action_type === "comment"
            ? "document comment"
            : "document edit",
        label: activity.document_title,
        provenanceLabel: `${sourceLabel} → ${activity.document_title}`,
        sourceMemberId,
        sourceUrl: activity.source_calendar_url,
        url: activity.document_url,
      },
    ];
  });
}

/** Flatten per-member results while deduplicating links across all sources. */
export function deduplicateDerivedCollectionLinks(
  results: readonly {
    member: CollectionMember;
    links: readonly CollectionDiscoveredLink[];
  }[],
): DerivedCollectionLink[] {
  const links = new Map<string, DerivedCollectionLink>();
  for (const result of results) {
    for (const link of result.links) {
      const identity = link.url.toLocaleLowerCase();
      if (!links.has(identity)) {
        links.set(identity, { ...link, sourceMemberId: result.member.id });
      }
    }
  }
  return [...links.values()];
}

/** Deduplicate and order ephemeral activity, with current documents first. */
export function deduplicateDerivedCollectionActivity(
  activity: readonly DerivedCollectionActivity[],
): DerivedCollectionActivity[] {
  const deduplicated = new Map<string, DerivedCollectionActivity>();
  for (const item of activity) {
    let identity: string;
    if (item.activityType === "channel-message") {
      identity = `message:${item.eventId}`;
    } else if (
      item.activityType === "document-edit" ||
      item.activityType === "document-comment" ||
      item.activityType === "github-pr-activity"
    ) {
      identity = [
        item.activityType,
        item.url.toLocaleLowerCase(),
        item.createdAt,
        item.actorLabel,
      ].join(":");
    } else {
      identity = `url:${item.url.toLocaleLowerCase()}`;
    }
    if (!deduplicated.has(identity)) deduplicated.set(identity, item);
  }
  return [...deduplicated.values()].sort(
    (left, right) =>
      (right.createdAt ?? Number.POSITIVE_INFINITY) -
      (left.createdAt ?? Number.POSITIVE_INFINITY),
  );
}

/** Apply sourced homepage projection without hiding concrete artifact activity. */
export function projectCollectionActivity(
  activity: readonly DerivedCollectionActivity[],
  actorIsAgent: Readonly<Record<string, boolean | undefined>>,
): DerivedCollectionActivity[] {
  const conversationIdentity = (item: DerivedCollectionActivity) =>
    item.channelId
      ? `${item.channelId}:${item.threadRootId ?? item.eventId ?? item.sourceMemberId}`
      : null;
  const pullRequestUrls = new Set(
    activity
      .filter((item) => item.activityType === "github-pr")
      .map((item) => item.url.toLocaleLowerCase()),
  );
  const pullRequestConversations = new Set(
    activity
      .filter((item) => item.activityType === "github-pr")
      .flatMap((item) => {
        const identity = conversationIdentity(item);
        return identity ? [identity] : [];
      }),
  );
  const pullRequestEvents = new Set(
    activity
      .filter((item) => item.activityType === "github-pr")
      .flatMap((item) => item.sourceEventIds ?? []),
  );
  const messages = activity.filter((item) => {
    if (item.activityType !== "channel-message") return false;
    const mentionsResolvedPullRequest = extractGitHubPullRequestLinks([
      { content: item.label },
    ]).some((mention) => pullRequestUrls.has(mention.url.toLocaleLowerCase()));
    return (
      !mentionsResolvedPullRequest &&
      !pullRequestConversations.has(conversationIdentity(item) ?? "") &&
      (!item.eventId || !pullRequestEvents.has(item.eventId))
    );
  });
  const conversations = new Map<string, DerivedCollectionActivity[]>();
  for (const message of messages) {
    const identity = `${message.channelId ?? ""}:${message.threadRootId ?? message.eventId ?? message.sourceMemberId}`;
    const items = conversations.get(identity) ?? [];
    items.push(message);
    conversations.set(identity, items);
  }
  const visibleMessages = new Set<DerivedCollectionActivity>();
  for (const items of conversations.values()) {
    const participants = new Map<string, boolean | undefined>();
    for (const item of items) {
      if (!item.authorPubkey) {
        participants.set("unknown", undefined);
      } else {
        const pubkey = item.authorPubkey.toLocaleLowerCase();
        participants.set(pubkey, actorIsAgent[pubkey]);
      }
    }
    const classifications = [...participants.values()];
    const hasUnknown = classifications.some((value) => value === undefined);
    const hasAgent = classifications.some((value) => value === true);
    const humanCount = classifications.filter(
      (value) => value === false,
    ).length;
    if (hasUnknown || !hasAgent || humanCount >= 2) {
      for (const item of items) visibleMessages.add(item);
    }
  }
  return activity.filter(
    (item) =>
      item.activityType !== "github-pr" &&
      (item.activityType !== "channel-message" || visibleMessages.has(item)),
  );
}
