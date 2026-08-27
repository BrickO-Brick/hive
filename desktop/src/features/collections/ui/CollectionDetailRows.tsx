import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CalendarDays,
  Ellipsis,
  ExternalLink,
  FileText,
  GitBranch,
  GitPullRequest,
  Hash,
  Link2,
  ListTodo,
  MessageSquare,
  MessagesSquare,
  StickyNote,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import type { DerivedCollectionActivity } from "../derivedLinks";
import { collectionReferenceIdentity } from "../memberDisplay";
import type { CollectionMember, CollectionReferenceType } from "../types";

export function DerivedCollectionActivityRow({
  activity,
  actorAvatarUrl,
  actorLabel,
  onOpenMessage,
  onRemoveSource,
}: {
  activity: DerivedCollectionActivity;
  actorAvatarUrl?: string;
  actorLabel?: string;
  onOpenMessage: () => void;
  onRemoveSource: () => Promise<void>;
}) {
  const isMessage = activity.activityType === "channel-message";
  const isMeeting = activity.activityType === "calendar-meeting";
  const isDerived = !isMessage || activity.derivedFromSource === true;
  const isDocumentActivity =
    activity.activityType === "document-edit" ||
    activity.activityType === "document-comment";
  const isPullRequest = activity.activityType === "github-pr";
  const isPullRequestActivity = activity.activityType === "github-pr-activity";
  const identity = isMessage
    ? activity.eventId
    : isDocumentActivity || isPullRequestActivity
      ? `${activity.url}:${activity.activityType}:${activity.createdAt}`
      : activity.url;
  const timestamp = activity.createdAt
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(activity.createdAt * 1_000))
    : null;
  const content = (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <ActivityTypeGlyph activity={activity} />
        {isDerived ? (
          <span
            className="text-muted-foreground"
            title={`Derived from ${activity.provenanceLabel ?? "an explicit Collection source"}`}
          >
            <Link2
              aria-label={`Derived from ${activity.provenanceLabel ?? "an explicit Collection source"}`}
              className="h-3.5 w-3.5"
            />
          </span>
        ) : null}
        <span className="truncate text-sm font-medium">{activity.label}</span>
      </div>
      {isMeeting ? (
        <MeetingActivitySummary activity={activity} timestamp={timestamp} />
      ) : isDocumentActivity ? (
        <div className="mt-1 text-sm">
          {activity.actorLabel}{" "}
          {activity.activityType === "document-edit"
            ? "edited"
            : "commented on"}{" "}
          <span className="font-medium">{activity.label}</span>
          {timestamp ? ` · ${timestamp}` : null}
        </div>
      ) : isPullRequestActivity ? (
        <div className="mt-1 text-sm">
          {activity.actorLabel ?? "Unknown GitHub actor"}{" "}
          {activity.kind.replace(/^PR /u, "")}
          {activity.stateLabel ? ` · ${activity.stateLabel}` : null}
          {timestamp ? ` · ${timestamp}` : null}
        </div>
      ) : isPullRequest ? (
        <div className="mt-1 text-sm">
          {activity.stateLabel ? (
            <span className="font-medium capitalize">
              {activity.stateLabel}
            </span>
          ) : (
            "Mentioned PR"
          )}
          {activity.actorLabel ? ` by ${activity.actorLabel}` : null}
          {timestamp ? ` · ${timestamp}` : null}
        </div>
      ) : isMessage ? (
        <div className="mt-1 text-sm">
          {actorLabel ?? "Unknown Buzz user"}
          {timestamp ? ` · ${timestamp}` : null}
        </div>
      ) : timestamp ? (
        <div className="mt-1 text-xs text-muted-foreground">{timestamp}</div>
      ) : null}
      {activity.provenanceLabel && !isMeeting ? (
        <div className="mt-1 text-xs text-muted-foreground">
          From {activity.provenanceLabel}
        </div>
      ) : null}
      {activity.url && !isMeeting ? (
        <div className="mt-1 truncate text-xs text-muted-foreground">
          {activity.url}
        </div>
      ) : null}
    </div>
  );
  return (
    <div
      className="group flex items-center gap-3 p-4"
      data-testid={`collection-derived-${encodeURIComponent(identity ?? "activity")}`}
    >
      {actorLabel ? (
        <UserAvatar
          avatarUrl={actorAvatarUrl ?? null}
          displayName={actorLabel}
          size="sm"
        />
      ) : null}
      {isMessage ? (
        <button
          className="min-w-0 flex-1 text-left hover:underline"
          onClick={onOpenMessage}
          type="button"
        >
          {content}
        </button>
      ) : (
        content
      )}
      {!isMessage ? (
        <Button
          aria-label={`Open derived link ${activity.label}`}
          onClick={() => {
            void openUrl(activity.url).catch(() =>
              toast.error("Failed to open link"),
            );
          }}
          size="icon"
          variant="ghost"
        >
          <ExternalLink className="h-4 w-4" />
        </Button>
      ) : null}
      <CollectionRowActions
        derived={isDerived}
        label={activity.label}
        onRemove={onRemoveSource}
      />
    </div>
  );
}

function ActivityTypeGlyph({
  activity,
}: {
  activity: DerivedCollectionActivity;
}) {
  const Icon =
    activity.activityType === "calendar-meeting"
      ? CalendarDays
      : activity.activityType === "github-pr" ||
          activity.activityType === "github-pr-activity"
        ? GitPullRequest
        : activity.activityType === "calendar-document"
          ? CalendarDays
          : activity.activityType === "channel-message"
            ? activity.kind === "thread"
              ? MessagesSquare
              : MessageSquare
            : FileText;
  return (
    <Icon
      aria-label={activity.kind}
      className="h-4 w-4 shrink-0 text-muted-foreground"
    />
  );
}

function MeetingActivitySummary({
  activity,
  timestamp,
}: {
  activity: DerivedCollectionActivity;
  timestamp: string | null;
}) {
  const documents = activity.meetingDocuments ?? [];
  const editCount = documents.reduce(
    (total, document) => total + document.editCount,
    0,
  );
  const commentCount = documents.reduce(
    (total, document) => total + document.commentCount,
    0,
  );
  const updates = [
    editCount > 0 ? `${editCount} ${editCount === 1 ? "edit" : "edits"}` : null,
    commentCount > 0
      ? `${commentCount} ${commentCount === 1 ? "comment" : "comments"}`
      : null,
  ].filter(Boolean);

  return (
    <div className="mt-2 space-y-2">
      <div className="text-sm text-muted-foreground">
        {updates.length > 0 ? updates.join(" · ") : "Attached documents"}
        {timestamp ? ` · ${timestamp}` : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {documents.map((document) => (
          <Button
            className="h-7 max-w-full gap-1.5 px-2 text-xs"
            key={document.url}
            onClick={() => {
              void openUrl(document.url).catch(() =>
                toast.error("Failed to open document"),
              );
            }}
            size="sm"
            variant="outline"
          >
            <FileText className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{document.label}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}

export function CollectionMemberRow({
  canOpen,
  isRemoving,
  member,
  onOpen,
  onRemove,
}: {
  canOpen: boolean;
  isRemoving: boolean;
  member: CollectionMember;
  onOpen: () => void;
  onRemove: () => Promise<void>;
}) {
  const identity = collectionReferenceIdentity(member.reference);
  const label = member.label || identity;
  const content = (
    <div className="flex items-center gap-2">
      <SourceTypeGlyph type={member.reference.type} />
      <span className="truncate text-sm font-medium">{label}</span>
      {member.reference.type === "external" ? (
        <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {new URL(member.reference.url).hostname}
        </span>
      ) : null}
    </div>
  );

  return (
    <div
      className="group flex items-center gap-3 p-4"
      data-testid={`collection-member-${member.id}`}
    >
      <div className="min-w-0 flex-1">
        {canOpen && member.reference.type !== "external" ? (
          <button
            className="w-full text-left hover:underline"
            onClick={onOpen}
            type="button"
          >
            {content}
          </button>
        ) : (
          content
        )}
        <details className="mt-1 text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer">Details</summary>
          <code className="mt-1 block break-all">{identity}</code>
        </details>
      </div>
      {member.reference.type === "external" ? (
        <Button asChild size="icon" variant="ghost">
          <a href={member.reference.url} rel="noreferrer" target="_blank">
            <ExternalLink className="h-4 w-4" />
            <span className="sr-only">Open external reference</span>
          </a>
        </Button>
      ) : null}
      <CollectionRowActions
        disabled={isRemoving}
        label={member.label ?? member.reference.type}
        onRemove={onRemove}
      />
    </div>
  );
}

function SourceTypeGlyph({ type }: { type: CollectionReferenceType }) {
  const Icon =
    type === "channel"
      ? Hash
      : type === "repository"
        ? GitBranch
        : type === "task"
          ? ListTodo
          : type === "thread"
            ? MessagesSquare
            : type === "message"
              ? MessageSquare
              : type === "note"
                ? StickyNote
                : ExternalLink;
  return (
    <Icon
      aria-label={`${type} source`}
      className="h-4 w-4 shrink-0 text-muted-foreground"
    />
  );
}

export function CollectionRowActions({
  derived = false,
  disabled = false,
  label,
  onRemove,
}: {
  derived?: boolean;
  disabled?: boolean;
  label: string;
  onRemove: () => Promise<void>;
}) {
  const removeLabel = derived
    ? "Remove source from Collection"
    : "Remove from Collection";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`Actions for ${label}`}
          className="opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
          size="icon"
          variant="ghost"
        >
          <Ellipsis className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          disabled={disabled}
          onSelect={() => void onRemove()}
        >
          {removeLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
