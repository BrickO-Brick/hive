import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getChannelWindowEvents } from "@/shared/api/channelWindow";
import { getEventById, getThreadReplies } from "@/shared/api/tauri";
import { getThreadReference } from "@/features/messages/lib/threading";
import { parseLiveThreadSummary } from "@/features/messages/lib/channelWindowResponse";
import {
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
} from "@/shared/constants/kinds";

import {
  addCollectionMember,
  createCollection,
  deleteCollection,
  discoverCollectionCalendarActivity,
  discoverCollectionCalendarLinks,
  getCollection,
  listCollections,
  removeCollectionMember,
  resolveCollectionGithubPullRequest,
  setCollectionIcon,
  setCollectionName,
} from "./api";
import type {
  DerivedCollectionActivity,
  DerivedCollectionWarning,
} from "./derivedLinks";
import {
  calendarDocumentActivityToDerived,
  capCollectionPullRequestMentions,
  collectionChannelThreadProvenance,
  deduplicateDerivedCollectionActivity,
  deduplicateDerivedCollectionWarnings,
  extractGitHubPullRequestLinks,
  githubPullRequestToDerived,
  isGoogleCalendarEventUrl,
} from "./derivedLinks";
import type {
  CollectionMember,
  CollectionReference,
  CollectionScope,
} from "./types";

export const collectionsQueryKey = (scope: CollectionScope) =>
  ["collections", scope.relayUrl, scope.ownerPubkey] as const;

// Collections are local SQLite state shared with the CLI. Poll only while a
// view is mounted so agent/CLI writes appear without requiring an app reload.
export const COLLECTIONS_REFETCH_INTERVAL_MS = 5_000;
export const COLLECTION_CHANNEL_DISCOVERY_LIMIT = 200;
const COLLECTION_CALENDAR_ACTIVITY_DAYS = 30;
export const COLLECTION_SOURCE_DISCOVERY_CONCURRENCY = 2;
export const COLLECTION_PR_RESOLUTION_CONCURRENCY = 3;

function sourceLabel(
  member: CollectionMember,
  channelNamesById: ReadonlyMap<string, string>,
): string {
  if (member.reference.type === "channel") {
    const channelName = channelNamesById
      .get(member.reference.channel_id)
      ?.trim();
    if (channelName) return channelName;
  }
  if (member.label) return member.label;
  if (member.reference.type === "external") return member.reference.url;
  if (member.reference.type === "channel") return member.reference.channel_id;
  if (member.reference.type === "thread") return member.reference.root_event_id;
  if (member.reference.type === "message") return member.reference.event_id;
  return member.reference.type;
}

function messageActivity(
  member: CollectionMember,
  events: Awaited<ReturnType<typeof getChannelWindowEvents>>,
  channelNamesById: ReadonlyMap<string, string>,
): DerivedCollectionActivity[] {
  const reference = member.reference;
  if (
    reference.type !== "channel" &&
    reference.type !== "thread" &&
    reference.type !== "message"
  ) {
    return [];
  }
  const channelId = reference.channel_id;
  return events.flatMap((event): DerivedCollectionActivity[] => {
    const thread = getThreadReference(event.tags);
    const compact = event.content.replace(/\s+/gu, " ").trim();
    const provenanceLabel = `${sourceLabel(member, channelNamesById)} → ${
      reference.type === "thread" ? "thread activity" : "message activity"
    }`;
    const message: DerivedCollectionActivity = {
      activityType: "channel-message",
      actorIdentity: `buzz:${event.pubkey.toLocaleLowerCase()}`,
      authorPubkey: event.pubkey,
      channelId,
      createdAt: event.created_at,
      derivedFromSource: reference.type === "channel",
      eventId: event.id,
      kind: thread.rootId ? "thread" : "message",
      label: Array.from(compact || "Channel message")
        .slice(0, 120)
        .join(""),
      provenanceLabel,
      sourceMemberId: member.id,
      threadRootId:
        reference.type === "thread" ? reference.root_event_id : thread.rootId,
      url: "",
    };
    const pullRequests = extractGitHubPullRequestLinks([event]).map(
      (link): DerivedCollectionActivity => ({
        ...link,
        activityType: "github-pr",
        actorIdentity: `buzz:${event.pubkey.toLocaleLowerCase()}`,
        authorPubkey: event.pubkey,
        channelId,
        createdAt: event.created_at,
        eventId: event.id,
        provenanceLabel: `${sourceLabel(member, channelNamesById)} → mentioned PR`,
        sourceMemberId: member.id,
        threadRootId:
          reference.type === "thread" ? reference.root_event_id : thread.rootId,
      }),
    );
    return [message, ...pullRequests];
  });
}

async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  mapper: (input: Input) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(inputs.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      const input = inputs[index];
      if (input !== undefined) results[index] = await mapper(input);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, () =>
      worker(),
    ),
  );
  return results;
}

async function resolveMentionedPullRequests(
  membersById: ReadonlyMap<string, CollectionMember>,
  items: DerivedCollectionActivity[],
  channelNamesById: ReadonlyMap<string, string>,
): Promise<{
  items: DerivedCollectionActivity[];
  warnings: DerivedCollectionWarning[];
}> {
  const mentions = capCollectionPullRequestMentions(items);
  const otherItems = items.filter((item) => item.activityType !== "github-pr");
  const resolved = await mapWithConcurrency(
    mentions,
    COLLECTION_PR_RESOLUTION_CONCURRENCY,
    async (mention) => {
      const member = membersById.get(mention.sourceMemberId);
      const memberLabel = member
        ? sourceLabel(member, channelNamesById)
        : mention.sourceMemberId;
      try {
        const pullRequest = await resolveCollectionGithubPullRequest(
          mention.url,
        );
        return {
          items: githubPullRequestToDerived(mention, pullRequest),
          warnings: [] as DerivedCollectionWarning[],
        };
      } catch (error) {
        const sourceMemberIds = mention.sourceMemberIds ?? [
          mention.sourceMemberId,
        ];
        return {
          items: [mention],
          warnings: sourceMemberIds.map((sourceMemberId) => {
            const sourceMember = membersById.get(sourceMemberId);
            return {
              message:
                error instanceof Error
                  ? error.message
                  : "GitHub PR activity is unavailable",
              sourceLabel: `${sourceMember ? sourceLabel(sourceMember, channelNamesById) : memberLabel} → ${mention.label}`,
              sourceMemberId,
              warningType: "github-pr" as const,
            };
          }),
        };
      }
    },
  );
  return {
    items: [...otherItems, ...resolved.flatMap((result) => result.items)],
    warnings: resolved.flatMap((result) => result.warnings),
  };
}

export function useCollectionsQuery(scope: CollectionScope | null) {
  return useQuery({
    enabled: scope !== null,
    refetchInterval: scope ? COLLECTIONS_REFETCH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    queryKey: scope ? collectionsQueryKey(scope) : ["collections", "disabled"],
    queryFn: () => listCollections(scope as CollectionScope),
  });
}

export function useCollectionQuery(
  scope: CollectionScope | null,
  collectionId: string,
) {
  return useQuery({
    enabled: scope !== null,
    refetchInterval: scope ? COLLECTIONS_REFETCH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    queryKey: scope
      ? [...collectionsQueryKey(scope), collectionId]
      : ["collections", "disabled", collectionId],
    queryFn: () => getCollection(scope as CollectionScope, collectionId),
  });
}

export function useCollectionMutations(scope: CollectionScope | null) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    scope
      ? queryClient.invalidateQueries({ queryKey: collectionsQueryKey(scope) })
      : Promise.resolve();

  const create = useMutation({
    mutationFn: (input: { name: string; icon: string | null }) =>
      createCollection(scope as CollectionScope, input.name, input.icon),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (collectionId: string) =>
      deleteCollection(scope as CollectionScope, collectionId),
    onSuccess: invalidate,
  });
  const addMember = useMutation({
    mutationFn: (input: {
      collectionId: string;
      reference: CollectionReference;
      label?: string | null;
    }) => addCollectionMember(scope as CollectionScope, input),
    onSuccess: invalidate,
  });
  const removeMember = useMutation({
    mutationFn: (input: { collectionId: string; memberId: string }) =>
      removeCollectionMember(
        scope as CollectionScope,
        input.collectionId,
        input.memberId,
      ),
    onSuccess: invalidate,
  });
  const setIcon = useMutation({
    mutationFn: (input: { collectionId: string; icon: string | null }) =>
      setCollectionIcon(
        scope as CollectionScope,
        input.collectionId,
        input.icon,
      ),
    onSuccess: invalidate,
  });
  const setName = useMutation({
    mutationFn: (input: { collectionId: string; name: string }) =>
      setCollectionName(
        scope as CollectionScope,
        input.collectionId,
        input.name,
      ),
    onSuccess: invalidate,
  });

  return { addMember, create, remove, removeMember, setIcon, setName };
}

async function discoverCollectionMemberActivity(
  member: CollectionMember,
  channelNamesById: ReadonlyMap<string, string>,
): Promise<{
  items: DerivedCollectionActivity[];
  warnings: DerivedCollectionWarning[];
}> {
  if (member.reference.type === "channel") {
    const channelId = member.reference.channel_id;
    const events = await getChannelWindowEvents(
      channelId,
      null,
      COLLECTION_CHANNEL_DISCOVERY_LIMIT,
    );
    const messages = events.filter((event) =>
      [
        KIND_STREAM_MESSAGE,
        KIND_STREAM_MESSAGE_V2,
        KIND_FORUM_POST,
        KIND_FORUM_COMMENT,
      ].includes(event.kind),
    );
    const threadActivity = events.flatMap(
      (event): DerivedCollectionActivity[] => {
        const summary = parseLiveThreadSummary(event);
        if (!summary) return [];
        const root = messages.find((message) => message.id === summary.rootId);
        if (!root) return [];
        const compact = root.content.replace(/\s+/gu, " ").trim();
        return [
          {
            activityType: "channel-message",
            actorIdentity: `buzz:${root.pubkey.toLocaleLowerCase()}`,
            authorPubkey: root.pubkey,
            channelId,
            createdAt: summary.live.summary.lastReplyAt ?? root.created_at,
            derivedFromSource: true,
            eventId: root.id,
            kind: "thread",
            label: Array.from(compact || "Channel thread")
              .slice(0, 120)
              .join(""),
            provenanceLabel: collectionChannelThreadProvenance(
              sourceLabel(member, channelNamesById),
            ),
            sourceMemberId: member.id,
            threadRootId: root.id,
            url: "",
          },
        ];
      },
    );
    return {
      items: [
        ...threadActivity,
        ...messageActivity(member, messages, channelNamesById),
      ],
      warnings: [],
    };
  }
  if (member.reference.type === "thread") {
    const root = await getEventById(member.reference.root_event_id);
    const replies = await getThreadReplies(
      member.reference.root_event_id,
      member.reference.channel_id,
      { limit: COLLECTION_CHANNEL_DISCOVERY_LIMIT },
    );
    return {
      items: messageActivity(
        member,
        [root, ...replies.events],
        channelNamesById,
      ),
      warnings: [],
    };
  }
  if (member.reference.type === "message") {
    const event = await getEventById(member.reference.event_id);
    return {
      items: messageActivity(member, [event], channelNamesById),
      warnings: [],
    };
  }
  if (member.reference.type === "external") {
    const calendarUrl = member.reference.url;
    const startTime = new Date(
      Date.now() - COLLECTION_CALENDAR_ACTIVITY_DAYS * 86_400_000,
    ).toISOString();
    // Sequential within a source; the outer pool bounds simultaneous Calendar
    // commands across a collection to COLLECTION_SOURCE_DISCOVERY_CONCURRENCY.
    const links = await discoverCollectionCalendarLinks(calendarUrl);
    const activity = await discoverCollectionCalendarActivity(
      calendarUrl,
      startTime,
    );
    return {
      items: [
        ...links.map(
          (link): DerivedCollectionActivity => ({
            ...link,
            activityType: "calendar-document",
            createdAt: null,
            provenanceLabel: `${sourceLabel(member, channelNamesById)} → attached document`,
            sourceMemberId: member.id,
            sourceUrl: calendarUrl,
          }),
        ),
        ...calendarDocumentActivityToDerived(
          member.id,
          sourceLabel(member, channelNamesById),
          activity.activities,
        ),
      ],
      warnings: activity.errors.map((error) => ({
        failureSourceUrl: error.source_url,
        message: error.message,
        sourceLabel: sourceLabel(member, channelNamesById),
        sourceMemberId: member.id,
        warningType: "calendar" as const,
      })),
    };
  }
  return { items: [], warnings: [] };
}

export function useDerivedCollectionLinks(
  members: readonly CollectionMember[],
  channelNamesById: ReadonlyMap<string, string> = new Map(),
) {
  const sources = members.filter(
    (member) =>
      member.reference.type === "channel" ||
      member.reference.type === "thread" ||
      member.reference.type === "message" ||
      (member.reference.type === "external" &&
        isGoogleCalendarEventUrl(member.reference.url)),
  );
  const discovery = useQuery({
    enabled: sources.length > 0,
    queryKey: [
      "collection-derived-links",
      sources.map((member) => [
        member.id,
        sourceLabel(member, channelNamesById),
        member.reference,
      ]),
    ],
    queryFn: async () => {
      const sourceResults = await mapWithConcurrency(
        sources,
        COLLECTION_SOURCE_DISCOVERY_CONCURRENCY,
        async (member) => {
          try {
            return await discoverCollectionMemberActivity(
              member,
              channelNamesById,
            );
          } catch (error) {
            return {
              items: [],
              warnings: [
                {
                  message:
                    error instanceof Error
                      ? error.message
                      : "Source activity is unavailable",
                  sourceLabel: sourceLabel(member, channelNamesById),
                  sourceMemberId: member.id,
                  warningType:
                    member.reference.type === "external"
                      ? ("calendar" as const)
                      : ("source" as const),
                },
              ],
            };
          }
        },
      );
      const baseItems = sourceResults.flatMap((result) => result.items);
      const pullRequests = await resolveMentionedPullRequests(
        new Map(sources.map((member) => [member.id, member])),
        baseItems,
        channelNamesById,
      );
      return {
        items: pullRequests.items,
        warnings: [
          ...sourceResults.flatMap((result) => result.warnings),
          ...pullRequests.warnings,
        ],
      };
    },
    staleTime: 30_000,
  });

  return {
    isFetching: discovery.isFetching,
    links: deduplicateDerivedCollectionActivity(discovery.data?.items ?? []),
    warnings: deduplicateDerivedCollectionWarnings(
      discovery.data?.warnings ?? [],
    ),
  };
}
