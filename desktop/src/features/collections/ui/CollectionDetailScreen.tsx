import { useNavigate } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  Bot,
  Ellipsis,
  Plus,
  Search,
  UserRound,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { useChannelsQuery } from "@/features/channels/hooks";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { useOpenEntityLink } from "@/shared/ui/markdown/entityLinks";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import {
  COLLECTION_REFERENCE_TYPES,
  collectionMemberDisplayLabel,
  collectionMemberMatches,
} from "../memberDisplay";
import { collectionMemberNavigationTarget } from "../memberNavigation";
import {
  useCollectionMutations,
  useCollectionQuery,
  useDerivedCollectionLinks,
} from "../hooks";
import {
  filterCollectionActivityByType,
  projectCollectionActivity,
  type CollectionActivityTypeFilter,
} from "../derivedLinks";
import type { CollectionReference, CollectionReferenceType } from "../types";
import { useCollectionScope } from "../useCollectionScope";
import { AddCollectionReferenceForm } from "./AddCollectionReferenceForm";
import {
  CollectionMemberRow,
  CollectionRowActions,
  DerivedCollectionActivityRow,
} from "./CollectionDetailRows";

const PEOPLE_PREVIEW_LIMIT = 8;
const ACTIVITY_TYPE_FILTERS: ReadonlyArray<{
  label: string;
  value: CollectionActivityTypeFilter;
}> = [
  { label: "All activity", value: "all" },
  { label: "Messages & threads", value: "messages" },
  { label: "Pull requests", value: "pull-requests" },
  { label: "Meetings", value: "meetings" },
  { label: "Documents", value: "documents" },
];
import { CollectionGlyph } from "./CollectionGlyph";
import { CollectionIconDialog } from "./CollectionIconDialog";

export function CollectionDetailScreen({
  collectionId,
}: {
  collectionId: string;
}) {
  const scope = useCollectionScope();
  const collectionQuery = useCollectionQuery(scope, collectionId);
  const channelsQuery = useChannelsQuery();
  const { addMember, remove, removeMember, setIcon } =
    useCollectionMutations(scope);
  const navigate = useNavigate();
  const { goChannel } = useAppNavigation();
  const openEntityLink = useOpenEntityLink();
  const [search, setSearch] = React.useState("");
  const [addOpen, setAddOpen] = React.useState(false);
  const [iconOpen, setIconOpen] = React.useState(false);
  const [selectedPerson, setSelectedPerson] = React.useState<string | null>(
    null,
  );
  const [activeTab, setActiveTab] = React.useState<
    "overview" | "activity" | "sources"
  >("overview");
  const [activityType, setActivityType] =
    React.useState<CollectionActivityTypeFilter>("all");
  const [type, setType] = React.useState<CollectionReferenceType | "all">(
    "all",
  );
  const data = collectionQuery.data;
  const channelNamesById = React.useMemo(
    () =>
      new Map(
        (channelsQuery.data ?? []).map((channel) => [channel.id, channel.name]),
      ),
    [channelsQuery.data],
  );
  const derived = useDerivedCollectionLinks(
    data?.members ?? [],
    channelNamesById,
  );
  const participantIdentities = [
    ...new Set(
      derived.links.flatMap((activity) =>
        activity.actorIdentity ? [activity.actorIdentity] : [],
      ),
    ),
  ];
  const actorPubkeys = participantIdentities.flatMap((identity) =>
    identity.startsWith("buzz:") ? [identity.slice("buzz:".length)] : [],
  );
  const profilesQuery = useUsersBatchQuery(actorPubkeys);
  const profiles = profilesQuery.data?.profiles ?? {};
  const peopleIdentities = participantIdentities.filter(
    (identity) =>
      !identity.startsWith("buzz:") ||
      !profiles[identity.slice("buzz:".length)]?.isAgent,
  );
  const visiblePeopleIdentities = peopleIdentities.slice(
    0,
    PEOPLE_PREVIEW_LIMIT,
  );
  const hiddenPeopleCount =
    peopleIdentities.length - visiblePeopleIdentities.length;
  const members = (data?.members ?? []).filter((member) =>
    collectionMemberMatches(member, search, type, channelNamesById),
  );
  const projectedActivity = projectCollectionActivity(
    derived.links,
    Object.fromEntries(
      actorPubkeys.flatMap((pubkey) => {
        const profile = profiles[pubkey.toLocaleLowerCase()];
        return profile
          ? [[pubkey.toLocaleLowerCase(), profile.isAgent] as const]
          : [];
      }),
    ),
  );
  const filteredActivity = selectedPerson
    ? projectedActivity.filter(
        (activity) =>
          activity.actorIdentity === selectedPerson ||
          activity.actorIdentities?.includes(selectedPerson),
      )
    : projectedActivity;
  const visibleActivity =
    activeTab === "activity"
      ? filterCollectionActivityByType(filteredActivity, activityType)
      : filteredActivity;
  const sourceGroups = [
    {
      label: "Channels",
      members: members.filter((member) => member.reference.type === "channel"),
    },
    {
      label: "Code",
      members: members.filter((member) =>
        ["repository", "task"].includes(member.reference.type),
      ),
    },
    {
      label: "Conversations",
      members: members.filter((member) =>
        ["thread", "message", "note"].includes(member.reference.type),
      ),
    },
    {
      label: "External",
      members: members.filter((member) => member.reference.type === "external"),
    },
  ];

  const addReference = async (
    reference: CollectionReference,
    label: string | null,
  ) => {
    try {
      await addMember.mutateAsync({ collectionId, label, reference });
      toast.success(`${reference.type} added`);
      setAddOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not add reference",
      );
      throw error;
    }
  };

  const removeSource = async (
    memberId: string,
    label: string,
    discoveredActivity: boolean,
  ) => {
    const prompt = discoveredActivity
      ? `Remove source “${label}” from this Collection? Related discovered activity will disappear.`
      : `Remove “${label}” from this Collection?`;
    if (!window.confirm(prompt)) return;
    try {
      await removeMember.mutateAsync({ collectionId, memberId });
      toast.success("Source removed from Collection");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not remove source",
      );
    }
  };

  const sourceDetails = (memberId: string) => {
    const member = data?.members.find((candidate) => candidate.id === memberId);
    return {
      label: member
        ? collectionMemberDisplayLabel(member, channelNamesById)
        : "source",
      memberId,
    };
  };

  const openMember = (reference: CollectionReference) => {
    const target = collectionMemberNavigationTarget(reference);
    if (!target || target.kind === "external") return;
    if (target.kind === "channel") {
      void goChannel(target.channelId);
    } else if (target.kind === "message") {
      void goChannel(target.channelId, {
        messageId: target.messageId,
        threadRootId: target.threadRootId,
      });
    } else {
      openEntityLink(target.entity);
    }
  };

  if (collectionQuery.isPending) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Loading collection…
      </div>
    );
  }
  if (collectionQuery.isError && !data) {
    return (
      <div className="grid h-full place-content-center gap-3 p-6 text-center text-sm text-muted-foreground">
        <p>Could not load this collection.</p>
        <Button
          onClick={() => void collectionQuery.refetch()}
          variant="outline"
        >
          Try again
        </Button>
      </div>
    );
  }
  if (!data) return null;

  return (
    <main className="h-full overflow-y-auto p-6" data-testid="collection-home">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <Button
              className="-ml-3 mb-2"
              onClick={() => void navigate({ to: "/collections" })}
              size="sm"
              variant="ghost"
            >
              <ArrowLeft className="h-4 w-4" />
              Collections
            </Button>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <Button
                aria-label="Change Collection icon"
                onClick={() => setIconOpen(true)}
                size="icon"
                variant="ghost"
              >
                <CollectionGlyph
                  className="h-6 w-6"
                  collection={data.collection}
                />
              </Button>
              {data.collection.name}
            </h1>
            <p className="mt-1 flex items-center text-sm text-muted-foreground">
              <button
                className="underline-offset-4 hover:underline"
                onClick={() => setActiveTab("sources")}
                type="button"
              >
                {data.members.length}{" "}
                {data.members.length === 1 ? "source" : "sources"}
              </button>
              {" · "}
              {derived.links.length}{" "}
              {derived.links.length === 1
                ? "discovered item"
                : "discovered items"}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              onClick={() => setAddOpen(true)}
              size="sm"
              variant="outline"
            >
              <Plus className="h-4 w-4" />
              Add
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label="Collection actions"
                  size="icon"
                  variant="ghost"
                >
                  <Ellipsis className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  disabled={remove.isPending}
                  onSelect={() => {
                    void (async () => {
                      if (!window.confirm(`Delete “${data.collection.name}”?`))
                        return;
                      try {
                        await remove.mutateAsync(collectionId);
                        await navigate({ to: "/collections" });
                      } catch (error) {
                        toast.error(
                          error instanceof Error
                            ? error.message
                            : "Could not delete collection",
                        );
                      }
                    })();
                  }}
                >
                  Delete Collection
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {collectionQuery.isError ? (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <span>Could not refresh this collection.</span>
            <Button
              onClick={() => void collectionQuery.refetch()}
              size="sm"
              variant="ghost"
            >
              Retry
            </Button>
          </div>
        ) : null}

        <Tabs
          className="mb-6"
          onValueChange={(value) =>
            setActiveTab(value as "overview" | "activity" | "sources")
          }
          value={activeTab}
        >
          <TabsList aria-label="Collection sections">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="sources">Sources</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
        </Tabs>

        {activeTab === "sources" ? (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search collection"
                className="pl-9"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search this collection"
                value={search}
              />
            </div>
            <select
              aria-label="Filter by type"
              className="h-9 rounded-lg border border-input/40 bg-background px-3 text-sm"
              onChange={(event) =>
                setType(event.target.value as CollectionReferenceType | "all")
              }
              value={type}
            >
              <option value="all">All types</option>
              {COLLECTION_REFERENCE_TYPES.map((value) => (
                <option key={value} value={value}>
                  {value[0].toUpperCase() + value.slice(1)}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {activeTab === "overview" ? (
          <>
            <div className="mb-8 grid gap-4 lg:grid-cols-2">
              <section
                className="rounded-xl border bg-card p-4"
                data-testid="collection-quick-navigation"
              >
                <h2 className="font-semibold">Quick navigation</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Explicit channel and repository sources.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {data.members
                    .filter((member) =>
                      ["channel", "repository"].includes(member.reference.type),
                    )
                    .map((member) => {
                      const target = collectionMemberNavigationTarget(
                        member.reference,
                      );
                      const label = collectionMemberDisplayLabel(
                        member,
                        channelNamesById,
                      );
                      const canOpen = target !== null;
                      return (
                        <div
                          className="group flex items-center"
                          key={member.id}
                        >
                          <Button
                            className="rounded-r-none"
                            disabled={!canOpen}
                            onClick={() => {
                              if (member.reference.type === "external") {
                                void openUrl(member.reference.url);
                              } else {
                                openMember(member.reference);
                              }
                            }}
                            size="sm"
                            variant="outline"
                          >
                            {label}
                          </Button>
                          <CollectionRowActions
                            disabled={removeMember.isPending}
                            label={label}
                            onRemove={() =>
                              removeSource(member.id, label, false)
                            }
                          />
                        </div>
                      );
                    })}
                  {!data.members.some((member) =>
                    ["channel", "repository"].includes(member.reference.type),
                  ) ? (
                    <span className="text-sm text-muted-foreground">
                      Add a channel or repository to create shortcuts.
                    </span>
                  ) : null}
                </div>
              </section>

              <section className="rounded-xl border bg-card p-4">
                <h2 className="font-semibold">Briefing</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  No sourced briefing is available yet.
                </p>
              </section>
            </div>

            {peopleIdentities.length > 0 ? (
              <section className="mb-8" data-testid="collection-people">
                <div className="mb-3">
                  <h2 className="text-lg font-semibold">People</h2>
                  <p className="text-sm text-muted-foreground">
                    Participants found in current sourced activity.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {visiblePeopleIdentities.map((identity) => {
                    const pubkey = identity.startsWith("buzz:")
                      ? identity.slice("buzz:".length)
                      : null;
                    const profile = pubkey ? profiles[pubkey] : undefined;
                    const providerActivity = derived.links.find(
                      (activity) => activity.actorIdentity === identity,
                    );
                    const label =
                      profile?.displayName ??
                      profile?.name ??
                      providerActivity?.actorLabel ??
                      identity.slice(identity.indexOf(":") + 1);
                    const ActorIcon = profile?.isAgent ? Bot : UserRound;
                    return (
                      <button
                        aria-pressed={selectedPerson === identity}
                        className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${selectedPerson === identity ? "bg-secondary ring-1 ring-ring" : "bg-card"}`}
                        key={identity}
                        onClick={() =>
                          setSelectedPerson((current) =>
                            current === identity ? null : identity,
                          )
                        }
                        type="button"
                      >
                        <UserAvatar
                          avatarUrl={
                            profile?.avatarUrl ??
                            providerActivity?.actorAvatarUrl ??
                            null
                          }
                          displayName={label}
                          size="xs"
                        />
                        <span>{label}</span>
                        <ActorIcon className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                    );
                  })}
                  {hiddenPeopleCount > 0 ? (
                    <span className="px-1 text-sm text-muted-foreground">
                      +{hiddenPeopleCount} more
                    </span>
                  ) : null}
                  {selectedPerson ? (
                    <Button
                      onClick={() => setSelectedPerson(null)}
                      size="xs"
                      variant="ghost"
                    >
                      Clear
                    </Button>
                  ) : null}
                </div>
              </section>
            ) : null}

            {derived.warnings.map((warning) => (
              <div
                className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm"
                data-testid={`collection-${warning.warningType}-warning-${warning.sourceMemberId}`}
                key={`${warning.warningType}:${warning.sourceMemberId}:${warning.message}:${warning.failureSourceUrl ?? ""}`}
              >
                {warning.warningType === "calendar"
                  ? "Calendar discovery"
                  : warning.warningType === "github-pr"
                    ? "GitHub PR resolution"
                    : "Source activity"}{" "}
                failed for {warning.sourceLabel}: {warning.message}
              </div>
            ))}
          </>
        ) : null}

        {activeTab !== "sources" ? (
          <section className="mb-8" data-testid="collection-activity">
            <div className="mb-3 flex items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">
                  {activeTab === "overview" ? "Recent activity" : "Activity"}
                </h2>
                <p className="text-sm text-muted-foreground">
                  Recent conversations and live context derived from your
                  sources.
                </p>
              </div>
              {activeTab === "activity" ? (
                <select
                  aria-label="Filter activity by type"
                  className="h-8 shrink-0 rounded-lg border border-input/40 bg-background px-2 text-sm"
                  onChange={(event) =>
                    setActivityType(
                      event.target.value as CollectionActivityTypeFilter,
                    )
                  }
                  value={activityType}
                >
                  {ACTIVITY_TYPE_FILTERS.map((filter) => (
                    <option key={filter.value} value={filter.value}>
                      {filter.label}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
            <div className="divide-y rounded-xl border bg-card">
              {(activeTab === "overview"
                ? visibleActivity.slice(0, 5)
                : visibleActivity
              ).map((activity) => (
                <DerivedCollectionActivityRow
                  activity={activity}
                  actorAvatarUrl={
                    activity.actorAvatarUrl ??
                    (activity.authorPubkey
                      ? (profiles[activity.authorPubkey.toLocaleLowerCase()]
                          ?.avatarUrl ?? undefined)
                      : undefined)
                  }
                  actorLabel={
                    activity.actorLabel ??
                    (activity.authorPubkey
                      ? (profiles[activity.authorPubkey.toLocaleLowerCase()]
                          ?.displayName ??
                        profiles[activity.authorPubkey.toLocaleLowerCase()]
                          ?.name ??
                        truncatePubkey(activity.authorPubkey))
                      : undefined)
                  }
                  key={`${activity.activityType}:${activity.eventId ?? activity.url}:${activity.createdAt}`}
                  onOpenMessage={() => {
                    if (!activity.channelId || !activity.eventId) return;
                    void goChannel(activity.channelId, {
                      messageId: activity.eventId,
                      threadRootId: activity.threadRootId ?? null,
                    });
                  }}
                  onRemoveSource={() => {
                    const source = sourceDetails(activity.sourceMemberId);
                    return removeSource(source.memberId, source.label, true);
                  }}
                />
              ))}
              {visibleActivity.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  {selectedPerson
                    ? "No activity from this person was found."
                    : activeTab === "activity" && activityType !== "all"
                      ? `No ${ACTIVITY_TYPE_FILTERS.find((filter) => filter.value === activityType)?.label.toLocaleLowerCase()} were found.`
                      : derived.isFetching
                        ? "Loading activity…"
                        : data.members.length === 0
                          ? "Add a source to discover collection activity."
                          : "No recent activity was found across linked sources."}
                </div>
              ) : null}
            </div>
            {activeTab === "overview" && visibleActivity.length > 5 ? (
              <Button
                className="mt-3"
                onClick={() => setActiveTab("activity")}
                size="sm"
                variant="outline"
              >
                View all activity
              </Button>
            ) : null}
          </section>
        ) : null}

        {activeTab === "sources" ? (
          <section data-testid="collection-sources">
            <div className="mb-3">
              <h2 className="text-lg font-semibold">Sources</h2>
              <p className="text-sm text-muted-foreground">
                Explicit context used to assemble this collection.
              </p>
            </div>
            <div className="space-y-5">
              {sourceGroups.map((group) =>
                group.members.length > 0 ? (
                  <section
                    aria-labelledby={`collection-source-group-${group.label}`}
                    data-testid={`collection-source-group-${group.label.toLocaleLowerCase()}`}
                    key={group.label}
                  >
                    <h3
                      className="mb-2 text-sm font-semibold text-muted-foreground"
                      id={`collection-source-group-${group.label}`}
                    >
                      {group.label}
                    </h3>
                    <div className="divide-y rounded-xl border bg-card">
                      {group.members.map((member) => {
                        const target = collectionMemberNavigationTarget(
                          member.reference,
                        );
                        return (
                          <CollectionMemberRow
                            canOpen={target !== null}
                            displayLabel={collectionMemberDisplayLabel(
                              member,
                              channelNamesById,
                            )}
                            isRemoving={removeMember.isPending}
                            key={member.id}
                            member={member}
                            onOpen={() => openMember(member.reference)}
                            onRemove={() =>
                              removeSource(
                                member.id,
                                collectionMemberDisplayLabel(
                                  member,
                                  channelNamesById,
                                ),
                                false,
                              )
                            }
                          />
                        );
                      })}
                    </div>
                  </section>
                ) : null,
              )}
              {members.length === 0 ? (
                <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
                  {data.members.length === 0
                    ? "No sources in this collection yet."
                    : "No items match these filters."}
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        <Dialog onOpenChange={setAddOpen} open={addOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add a source</DialogTitle>
              <DialogDescription>
                Paste an external link, or use advanced coordinates when an item
                cannot be added from its Buzz screen.
              </DialogDescription>
            </DialogHeader>
            <AddCollectionReferenceForm
              isAdding={addMember.isPending}
              onAdd={addReference}
            />
          </DialogContent>
        </Dialog>
        <CollectionIconDialog
          icon={data.collection.icon}
          isSaving={setIcon.isPending}
          onOpenChange={setIconOpen}
          onSave={async (icon) => {
            try {
              await setIcon.mutateAsync({ collectionId, icon });
              toast.success("Collection icon updated");
            } catch (error) {
              toast.error(
                error instanceof Error
                  ? error.message
                  : "Could not update Collection icon",
              );
              throw error;
            }
          }}
          open={iconOpen}
        />
      </div>
    </main>
  );
}
