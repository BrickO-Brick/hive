import { Check, Search } from "lucide-react";
import * as React from "react";

import { useRelayMembersQuery } from "@/features/community-members/hooks";
import {
  useFlattenedUserSearchResults,
  useInfiniteUserSearchQuery,
  useUsersBatchQuery,
} from "@/features/profile/hooks";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import type { UserProfileSummary, UserSearchResult } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { parsePubkeyInput } from "@/shared/lib/nostrUtils";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { PortalledScrollArea } from "@/shared/ui/PortalledScrollArea";

const AUTHOR_PAGE_SIZE = 50;

function authorLabel(
  pubkey: string,
  profile?: Pick<UserProfileSummary, "displayName" | "nip05Handle"> | null,
) {
  return (
    profile?.displayName?.trim() ||
    profile?.nip05Handle?.trim() ||
    truncatePubkey(pubkey)
  );
}

function toSearchResult(
  pubkey: string,
  profile?: UserProfileSummary | null,
): UserSearchResult {
  return {
    pubkey,
    displayName: profile?.displayName ?? profile?.name ?? null,
    avatarUrl: profile?.avatarUrl ?? null,
    nip05Handle: profile?.nip05Handle ?? null,
    ownerPubkey: profile?.ownerPubkey ?? null,
    isAgent: profile?.isAgent ?? false,
  };
}

function matchesPubkeyPrefix(pubkey: string, query: string) {
  return (
    query.length >= 8 &&
    /^[0-9a-f]+$/i.test(query) &&
    pubkey.startsWith(query.toLowerCase())
  );
}

export function AuthorGridPicker({
  ariaLabel = "Author",
  disabled,
  id,
  knownPubkeys = [],
  onChange,
  value,
}: {
  ariaLabel?: string;
  disabled?: boolean;
  id?: string;
  knownPubkeys?: string[];
  onChange: (value: string) => void;
  value: string;
}) {
  const [query, setQuery] = React.useState("");
  const [visibleMemberCount, setVisibleMemberCount] =
    React.useState(AUTHOR_PAGE_SIZE);
  const deferredQuery = React.useDeferredValue(query.trim());
  const normalizedValue = parsePubkeyInput(value);

  const membersQuery = useRelayMembersQuery(true);
  const memberAuthorIds = React.useMemo(
    () => [
      ...new Set(
        [
          ...knownPubkeys,
          ...(membersQuery.data ?? []).map((member) => member.pubkey),
        ]
          .map((pubkey) => pubkey.trim().toLowerCase())
          .filter((pubkey) => /^[0-9a-f]{64}$/.test(pubkey)),
      ),
    ],
    [knownPubkeys, membersQuery.data],
  );
  const visibleMemberPubkeys = React.useMemo(
    () => memberAuthorIds.slice(0, visibleMemberCount),
    [memberAuthorIds, visibleMemberCount],
  );
  const visibleProfilesQuery = useUsersBatchQuery(visibleMemberPubkeys);
  const visibleMemberResults = React.useMemo(
    () =>
      visibleMemberPubkeys.map((pubkey) =>
        toSearchResult(pubkey, visibleProfilesQuery.data?.profiles[pubkey]),
      ),
    [visibleMemberPubkeys, visibleProfilesQuery.data?.profiles],
  );

  const directorySearchQuery = useInfiniteUserSearchQuery(deferredQuery, {
    allowEmpty: true,
    enabled: true,
    limit: AUTHOR_PAGE_SIZE,
  });
  const directoryResults = useFlattenedUserSearchResults(
    directorySearchQuery.data,
  );
  const searchResults = React.useMemo(() => {
    if (deferredQuery.length === 0) {
      const resultsByPubkey = new Map<string, UserSearchResult>();
      for (const result of visibleMemberResults) {
        resultsByPubkey.set(result.pubkey.toLowerCase(), result);
      }
      for (const result of directoryResults) {
        const pubkey = result.pubkey.toLowerCase();
        resultsByPubkey.set(pubkey, { ...result, pubkey });
      }
      return [...resultsByPubkey.values()];
    }

    const resultsByPubkey = new Map<string, UserSearchResult>();
    for (const result of directoryResults) {
      const pubkey = result.pubkey.toLowerCase();
      resultsByPubkey.set(pubkey, { ...result, pubkey });
    }

    if (memberAuthorIds.length > 0) {
      for (const pubkey of memberAuthorIds) {
        if (
          matchesPubkeyPrefix(pubkey, deferredQuery) &&
          !resultsByPubkey.has(pubkey)
        ) {
          resultsByPubkey.set(pubkey, toSearchResult(pubkey));
        }
      }
    }

    return [...resultsByPubkey.values()];
  }, [deferredQuery, directoryResults, memberAuthorIds, visibleMemberResults]);
  const directPubkey = parsePubkeyInput(deferredQuery);
  const showDirectPubkey =
    directPubkey !== null &&
    !searchResults.some(
      (user) => user.pubkey.toLowerCase() === directPubkey.toLowerCase(),
    );

  function selectAuthor(pubkey: string) {
    const normalizedPubkey = pubkey.toLowerCase();
    onChange(normalizedPubkey === normalizedValue ? "" : normalizedPubkey);
  }

  function loadNextPage() {
    if (deferredQuery.length === 0) {
      if (visibleMemberCount < memberAuthorIds.length) {
        setVisibleMemberCount((count) =>
          Math.min(count + AUTHOR_PAGE_SIZE, memberAuthorIds.length),
        );
      }
      if (
        directorySearchQuery.hasNextPage &&
        !directorySearchQuery.isFetchingNextPage
      ) {
        void directorySearchQuery.fetchNextPage();
      }
      return;
    }
    if (
      directorySearchQuery.hasNextPage &&
      !directorySearchQuery.isFetchingNextPage
    ) {
      void directorySearchQuery.fetchNextPage();
    }
  }

  function handleListScroll(event: React.UIEvent<HTMLDivElement>) {
    const list = event.currentTarget;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 64) {
      loadNextPage();
    }
  }

  const hasMoreResults =
    deferredQuery.length === 0
      ? visibleMemberCount < memberAuthorIds.length ||
        directorySearchQuery.hasNextPage
      : directorySearchQuery.hasNextPage;
  const isSettling = deferredQuery !== query.trim();
  const isLoading =
    isSettling ||
    (searchResults.length === 0 &&
      (membersQuery.isLoading || directorySearchQuery.isLoading));
  const hasVisibleResults = showDirectPubkey || searchResults.length > 0;

  return (
    <div
      className={cn("space-y-1", disabled && "opacity-50")}
      data-testid="author-grid-picker"
    >
      <div className="flex items-center gap-2 rounded-lg border border-input/40 bg-background px-3 py-2">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          aria-label={`${ariaLabel} search`}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          className="min-w-0 flex-1 bg-transparent text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed"
          disabled={disabled}
          id={id}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search people or paste a public key..."
          spellCheck={false}
          value={query}
        />
      </div>
      <PortalledScrollArea
        className="h-72 overflow-y-auto rounded-lg border border-input/40 bg-background p-2"
        data-testid="author-grid-list"
        onScroll={handleListScroll}
      >
        <fieldset className="grid grid-cols-3 gap-2">
          <legend className="sr-only">{ariaLabel}</legend>
          {isLoading ? (
            <p className="col-span-3 px-3 py-6 text-center text-xs text-muted-foreground">
              Loading authors…
            </p>
          ) : showDirectPubkey && directPubkey ? (
            <>
              <AuthorOption
                isSelected={directPubkey === normalizedValue}
                label={truncatePubkey(directPubkey)}
                onSelect={() => selectAuthor(directPubkey)}
                pubkey={directPubkey}
              />
              {searchResults.map((user) => (
                <AuthorSearchOption
                  isSelected={user.pubkey.toLowerCase() === normalizedValue}
                  key={user.pubkey}
                  disabled={disabled}
                  onSelect={() => selectAuthor(user.pubkey)}
                  user={user}
                />
              ))}
            </>
          ) : searchResults.length > 0 ? (
            searchResults.map((user) => (
              <AuthorSearchOption
                isSelected={user.pubkey.toLowerCase() === normalizedValue}
                key={user.pubkey}
                disabled={disabled}
                onSelect={() => selectAuthor(user.pubkey)}
                user={user}
              />
            ))
          ) : (
            <p className="col-span-3 px-3 py-6 text-center text-xs text-muted-foreground">
              No authors found.
            </p>
          )}
          {!isLoading && hasVisibleResults && hasMoreResults ? (
            <button
              className="col-span-3 w-full rounded-lg border border-dashed border-border px-3 py-2 text-center text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
              disabled={disabled || directorySearchQuery.isFetchingNextPage}
              onClick={loadNextPage}
              type="button"
            >
              {directorySearchQuery.isFetchingNextPage
                ? "Loading more…"
                : "Load more authors"}
            </button>
          ) : null}
        </fieldset>
      </PortalledScrollArea>
    </div>
  );
}

function AuthorSearchOption({
  disabled,
  isSelected,
  onSelect,
  user,
}: {
  disabled?: boolean;
  isSelected: boolean;
  onSelect: () => void;
  user: UserSearchResult;
}) {
  const label = authorLabel(user.pubkey, user);
  return (
    <AuthorOption
      avatarUrl={user.avatarUrl}
      disabled={disabled}
      isSelected={isSelected}
      label={label}
      onSelect={onSelect}
      pubkey={user.pubkey}
    />
  );
}

function AuthorOption({
  avatarUrl,
  disabled,
  isSelected,
  label,
  onSelect,
  pubkey,
}: {
  avatarUrl?: string | null;
  disabled?: boolean;
  isSelected: boolean;
  label: string;
  onSelect: () => void;
  pubkey: string;
}) {
  return (
    <button
      aria-pressed={isSelected}
      className={cn(
        "relative flex min-h-24 min-w-0 flex-col items-center justify-center gap-2 rounded-lg border border-border bg-muted/20 p-3 text-center transition-colors hover:border-foreground/20 hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed",
        isSelected && "border-primary bg-primary/10",
      )}
      data-testid={`workflow-author-result-${pubkey}`}
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      <ProfileAvatar
        avatarUrl={avatarUrl ?? null}
        className="h-9 w-9"
        iconClassName="h-5 w-5"
        label={label}
      />
      <span className="min-w-0 max-w-full">
        <span className="block truncate text-sm font-medium">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {truncatePubkey(pubkey)}
        </span>
      </span>
      <Check
        className={cn(
          "absolute right-2 top-2 h-4 w-4",
          isSelected ? "opacity-100" : "opacity-0",
        )}
      />
    </button>
  );
}
