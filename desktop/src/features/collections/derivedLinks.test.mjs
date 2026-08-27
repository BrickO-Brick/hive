import assert from "node:assert/strict";
import test from "node:test";

import {
  capCollectionPullRequestMentions,
  COLLECTION_PR_LIMIT_OVERALL,
  COLLECTION_PR_LIMIT_PER_SOURCE,
  calendarDocumentActivityToDerived,
  collectionChannelThreadProvenance,
  deduplicateDerivedCollectionActivity,
  deduplicateDerivedCollectionLinks,
  deduplicateDerivedCollectionWarnings,
  extractGitHubPullRequestLinks,
  githubPullRequestToDerived,
  projectCollectionActivity,
} from "./derivedLinks.ts";

test("projects low-signal agent chats while retaining sourced artifacts", () => {
  const message = (eventId, authorPubkey, threadRootId = "thread-1") => ({
    activityType: "channel-message",
    authorPubkey,
    channelId: "channel-1",
    createdAt: 1,
    eventId,
    kind: "thread",
    label: eventId,
    sourceMemberId: "thread-source",
    threadRootId,
    url: "",
  });
  const artifact = {
    activityType: "document-edit",
    createdAt: 2,
    kind: "document edit",
    label: "Design doc",
    sourceMemberId: "calendar-source",
    url: "https://docs.google.com/document/d/one",
  };

  assert.deepEqual(
    projectCollectionActivity(
      [message("agent", "agent"), message("human", "human"), artifact],
      { agent: true, human: false },
    ),
    [artifact],
  );
  assert.equal(
    projectCollectionActivity(
      [
        message("agent", "agent"),
        message("human-1", "human-1"),
        message("human-2", "human-2"),
      ],
      { agent: true, "human-1": false, "human-2": false },
    ).length,
    3,
  );
  assert.equal(
    projectCollectionActivity([message("unknown", "unknown")], {}).length,
    1,
  );
});

test("moves mentioned PR sources out of generic conversation activity", () => {
  const sourceMessage = {
    activityType: "channel-message",
    authorPubkey: "human",
    channelId: "channel-1",
    createdAt: 1,
    eventId: "message-1",
    kind: "thread",
    label: "Please review the PR",
    sourceMemberId: "thread-source",
    threadRootId: "thread-1",
    url: "",
  };
  const pullRequest = {
    ...sourceMessage,
    activityType: "github-pr",
    kind: "pull request",
    label: "PR #1",
    url: "https://github.com/block/buzz/pull/1",
  };
  const review = {
    ...pullRequest,
    activityType: "github-pr-activity",
    kind: "PR review",
  };

  assert.deepEqual(
    projectCollectionActivity([sourceMessage, pullRequest, review], {
      human: false,
    }),
    [review],
  );
});

test("deduplicates identical warnings while preserving attachment failures", () => {
  const warning = {
    failureSourceUrl: "https://docs.google.com/document/d/one",
    message: "buzz team weekly",
    sourceLabel: "Planning event",
    sourceMemberId: "calendar-member",
    warningType: "calendar",
  };
  const distinctAttachment = {
    ...warning,
    failureSourceUrl: "https://docs.google.com/document/d/two",
  };

  assert.deepEqual(
    deduplicateDerivedCollectionWarnings([
      warning,
      { ...warning },
      distinctAttachment,
      { ...warning, failureSourceUrl: undefined },
      { ...warning, failureSourceUrl: undefined },
    ]),
    [warning, distinctAttachment, { ...warning, failureSourceUrl: undefined }],
  );
});

test("caps and deduplicates newest PR mentions per source and overall", () => {
  assert.equal(COLLECTION_PR_LIMIT_PER_SOURCE, 4);
  assert.equal(COLLECTION_PR_LIMIT_OVERALL, 10);
  const mention = (sourceMemberId, number, createdAt) => ({
    activityType: "github-pr",
    createdAt,
    kind: "pull request",
    label: `PR #${number}`,
    sourceMemberId,
    url: `https://github.com/block/buzz/pull/${number}`,
  });
  const capped = capCollectionPullRequestMentions(
    [
      mention("source-a", 1, 10),
      mention("source-a", 2, 20),
      mention("source-a", 3, 30),
      mention("source-b", 1, 40),
      mention("source-b", 4, 50),
      mention("source-b", 5, 60),
    ],
    2,
    3,
  );

  assert.deepEqual(
    capped.map((item) => [item.sourceMemberId, item.url]),
    [
      ["source-b", "https://github.com/block/buzz/pull/5"],
      ["source-b", "https://github.com/block/buzz/pull/4"],
      ["source-a", "https://github.com/block/buzz/pull/3"],
    ],
  );
});

test("preserves every explicit source when duplicate PR mentions collapse", () => {
  const mention = (sourceMemberId, createdAt, eventId = sourceMemberId) => ({
    activityType: "github-pr",
    createdAt,
    eventId,
    kind: "pull request",
    label: "PR #7",
    sourceMemberId,
    url: "https://github.com/block/buzz/pull/7",
  });
  const [pullRequest] = capCollectionPullRequestMentions([
    mention("thread-a", 20),
    mention("message-b", 10),
  ]);

  assert.deepEqual(pullRequest.sourceMemberIds, ["thread-a", "message-b"]);
  assert.deepEqual(pullRequest.sourceEventIds, ["thread-a", "message-b"]);
  const messages = ["thread-a", "message-b"].map((sourceMemberId) => ({
    activityType: "channel-message",
    actorIdentity: "buzz:human",
    authorPubkey: "human",
    channelId: "channel-1",
    createdAt: 1,
    eventId: sourceMemberId,
    kind: "message",
    label: sourceMemberId,
    sourceMemberId,
    url: "",
  }));
  assert.deepEqual(
    projectCollectionActivity([...messages, pullRequest], { human: false }),
    [],
  );
});

test("suppresses matching PR mention rows across sources but keeps unrelated channel activity", () => {
  const url = "https://github.com/block/buzz/pull/7";
  const pullRequest = {
    activityType: "github-pr",
    createdAt: 3,
    eventId: "thread-reply",
    kind: "pull request",
    label: "PR #7",
    sourceMemberId: "thread-source",
    sourceEventIds: ["thread-reply"],
    sourceMemberIds: ["thread-source"],
    url,
  };
  const channelMention = {
    activityType: "channel-message",
    actorIdentity: "buzz:human",
    authorPubkey: "human",
    channelId: "channel-1",
    createdAt: 2,
    eventId: "channel-mention",
    kind: "message",
    label: `Please review ${url}?tab=checks`,
    sourceMemberId: "channel-source",
    url: "",
  };
  const unrelated = {
    ...channelMention,
    createdAt: 1,
    eventId: "channel-unrelated",
    label: "Unrelated channel update",
  };

  assert.deepEqual(
    projectCollectionActivity([channelMention, unrelated, pullRequest], {
      human: false,
    }),
    [unrelated],
  );
});

test("names channel-derived live thread provenance", () => {
  assert.equal(
    collectionChannelThreadProvenance("#design"),
    "#design → live thread summary",
  );
});

test("maps live PR status and recent activity onto a sourced mention", () => {
  const url = "https://github.com/block/buzz/pull/4242";
  const mention = {
    activityType: "github-pr",
    channelId: "channel-1",
    createdAt: 100,
    eventId: "message-1",
    kind: "pull request",
    label: "block/buzz PR #4242",
    provenanceLabel: "Design thread → mentioned PR",
    sourceMemberId: "thread-member",
    threadRootId: "thread-1",
    url,
  };
  const derived = githubPullRequestToDerived(mention, {
    url,
    title: "Live collections activity feed",
    state: "open",
    author: "author",
    author_avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
    updated_at: "2026-08-27T14:00:00Z",
    activity: [
      {
        kind: "review",
        author: "reviewer",
        author_avatar_url: "https://avatars.githubusercontent.com/u/2?v=4",
        state: "approved",
        created_at: "2026-08-27T13:30:00Z",
        url: `${url}#pullrequestreview-1`,
      },
      {
        kind: "comment",
        author: null,
        author_avatar_url: null,
        state: null,
        created_at: "not-a-time",
        url: null,
      },
    ],
  });

  assert.equal(derived.length, 2);
  assert.deepEqual(
    derived.map((item) => ({
      activityType: item.activityType,
      actorLabel: item.actorLabel,
      actorAvatarUrl: item.actorAvatarUrl,
      actorIdentity: item.actorIdentity,
      label: item.label,
      provenanceLabel: item.provenanceLabel,
      stateLabel: item.stateLabel,
    })),
    [
      {
        activityType: "github-pr",
        actorLabel: "author",
        actorAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
        actorIdentity: "github:author",
        label: "Live collections activity feed",
        provenanceLabel: "Design thread → mentioned PR",
        stateLabel: "open",
      },
      {
        activityType: "github-pr-activity",
        actorLabel: "reviewer",
        actorAvatarUrl: "https://avatars.githubusercontent.com/u/2?v=4",
        actorIdentity: "github:reviewer",
        label: "Live collections activity feed",
        provenanceLabel: "Design thread → mentioned PR",
        stateLabel: "approved",
      },
    ],
  );
});

test("maps sourced document edits and comments into distinct chronological activity", () => {
  const url = "https://docs.google.com/document/d/mock-design";
  const activity = calendarDocumentActivityToDerived(
    "calendar-member",
    "Planning event",
    [
      {
        action_type: "edit",
        timestamp: "2026-08-26T14:30:00Z",
        actor_display_name: "Avery Editor",
        actor_email: "avery@example.com",
        document_title: "Mock Collections Design Doc",
        document_url: url,
        document_file_id: "mock-design",
        source_calendar_url:
          "https://calendar.google.com/calendar/event?eid=mock",
        source_attachment_url: url,
      },
      {
        action_type: "comment",
        timestamp: "2026-08-26T15:45:00Z",
        actor_display_name: null,
        actor_email: "casey@example.com",
        document_title: "Mock Collections Design Doc",
        document_url: url,
        document_file_id: "mock-design",
        source_calendar_url:
          "https://calendar.google.com/calendar/event?eid=mock",
        source_attachment_url: url,
      },
    ],
  );

  const ordered = deduplicateDerivedCollectionActivity(activity);
  assert.equal(ordered.length, 2);
  assert.deepEqual(
    ordered.map((item) => [
      item.activityType,
      item.actorLabel,
      item.actorIdentity,
      item.provenanceLabel,
    ]),
    [
      [
        "document-comment",
        "casey@example.com",
        "google:casey@example.com",
        "Planning event → Mock Collections Design Doc",
      ],
      [
        "document-edit",
        "Avery Editor",
        "google:avery@example.com",
        "Planning event → Mock Collections Design Doc",
      ],
    ],
  );
});

test("extracts canonical GitHub pull-request URLs from channel messages", () => {
  const links = extractGitHubPullRequestLinks([
    {
      content:
        "Review https://github.com/block/buzz/pull/123/files, then (https://www.github.com/Block/Buzz/pull/456?notification_referrer=x).",
    },
    {
      content:
        "Ignore http://github.com/block/buzz/pull/999 and https://github.com/block/buzz/issues/123.",
    },
  ]);

  assert.deepEqual(links, [
    {
      kind: "pull request",
      label: "block/buzz PR #123",
      url: "https://github.com/block/buzz/pull/123",
    },
    {
      kind: "pull request",
      label: "Block/Buzz PR #456",
      url: "https://github.com/Block/Buzz/pull/456",
    },
  ]);
});

test("deduplicates pull requests within and across source members", () => {
  const first = {
    added_at: "2026-08-27T14:00:00Z",
    collection_id: "collection-1",
    id: "member-1",
    label: "Channel one",
    reference: { type: "channel", channel_id: "channel-1" },
  };
  const second = {
    ...first,
    id: "member-2",
    reference: { type: "channel", channel_id: "channel-2" },
  };
  const extracted = extractGitHubPullRequestLinks([
    {
      content:
        "https://github.com/block/buzz/pull/123 https://github.com/BLOCK/BUZZ/pull/123?tab=checks",
    },
  ]);

  assert.equal(extracted.length, 1);
  assert.deepEqual(
    deduplicateDerivedCollectionLinks([
      { member: first, links: extracted },
      { member: second, links: extracted },
    ]),
    [{ ...extracted[0], sourceMemberId: "member-1" }],
  );
});
