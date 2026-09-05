import {
  Archive,
  BookOpen,
  Boxes,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitBranch,
  LoaderCircle,
  MessageCircle,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";

import type { OneBrickGitHubRepository } from "../onebrick-github-api";
import {
  GitHubCatalogError,
  useOneBrickGitHubCatalog,
} from "../onebrick-github-api";

type RepositoryCategory =
  | "All"
  | "AI & Data"
  | "Client Platform"
  | "Mantul"
  | "Operations"
  | "Knowledge"
  | "Product";

const CATEGORIES: RepositoryCategory[] = [
  "All",
  "AI & Data",
  "Client Platform",
  "Mantul",
  "Operations",
  "Knowledge",
  "Product",
];
const EMPTY_REPOSITORIES: OneBrickGitHubRepository[] = [];
const INITIAL_REPOSITORIES_PER_OWNER = 12;
const MORE_REPOSITORIES_STEP = 12;

function categoryFor(repository: OneBrickGitHubRepository): RepositoryCategory {
  const name = repository.name.toLowerCase();
  if (
    name === "etl" ||
    name.includes("clickhouse") ||
    name.includes("ai-ops") ||
    name.includes("northstar") ||
    name.includes("business-insight")
  ) {
    return "AI & Data";
  }
  if (name === "client" || name.startsWith("client-") || name === "bpjs") {
    return "Client Platform";
  }
  if (name === "mantul" || name.startsWith("mantul-")) return "Mantul";
  if (
    name.includes("stack") ||
    name.includes("logs") ||
    name.includes("automation") ||
    name === "brickr" ||
    name.includes("grc")
  ) {
    return "Operations";
  }
  if (
    name.includes("knowledge") ||
    name.includes("docs") ||
    name.includes("wiki") ||
    name.includes("readme")
  ) {
    return "Knowledge";
  }
  return "Product";
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown update";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatCatalogFreshness(updatedAt: number, now: number): string {
  if (!updatedAt) return "Waiting for catalog sync";
  const elapsedMinutes = Math.max(0, Math.floor((now - updatedAt) / 60_000));
  if (elapsedMinutes < 1) return "Catalog synced just now";
  if (elapsedMinutes === 1) return "Catalog synced 1 minute ago";
  return `Catalog synced ${elapsedMinutes} minutes ago`;
}

function CatalogErrorState({
  error,
  retry,
}: {
  error: Error;
  retry: () => void;
}) {
  const configurationMissing =
    error instanceof GitHubCatalogError && error.status === 503;
  return (
    <div className="mx-auto mt-12 max-w-xl rounded-xl border border-[#F4BDC2] bg-[#FFF3F4] p-6 text-center">
      <ShieldCheck className="mx-auto size-8 text-[#C93F4A]" />
      <h2 className="mt-3 text-base font-bold text-[#10233F]">
        {configurationMissing
          ? "GitHub catalog credentials are not configured"
          : "The GitHub catalog could not be loaded"}
      </h2>
      <p className="mt-2 text-sm leading-6 text-[#607086]">
        {configurationMissing
          ? "Hive requires server-side, read-only credentials for private BrickO-Brick, brick-io, and BrickI-Brick repositories. Credentials are never sent to the browser."
          : "Hive could not read repository metadata. No GitHub write action was performed."}
      </p>
      <button
        className="mx-auto mt-4 flex items-center gap-2 rounded-md border border-[#D8DEE8] bg-white px-3 py-2 text-xs font-bold text-[#42526B] hover:border-[#FF6F52]/50 hover:text-[#E35E43]"
        onClick={retry}
        type="button"
      >
        <RefreshCw size={14} /> Try again
      </button>
    </div>
  );
}

export function OneBrickRepositoryCatalog({
  onDiscuss,
}: {
  onDiscuss: (repository: OneBrickGitHubRepository) => void;
}) {
  const catalog = useOneBrickGitHubCatalog();
  const [now, setNow] = useState(Date.now);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<RepositoryCategory>("All");
  const [expandedOwners, setExpandedOwners] = useState<Set<string>>(
    () => new Set(),
  );
  const [collapsedOwners, setCollapsedOwners] = useState<Set<string>>(
    () => new Set(),
  );
  const [visibleByOwner, setVisibleByOwner] = useState<Record<string, number>>(
    {},
  );
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const repositories = catalog.data?.repositories ?? EMPTY_REPOSITORIES;
  const categorized = useMemo(
    () =>
      repositories.map((repository) => ({
        repository,
        category: categoryFor(repository),
      })),
    [repositories],
  );
  const filtered = useMemo(
    () =>
      categorized.filter(({ repository, category: repositoryCategory }) => {
        if (category !== "All" && category !== repositoryCategory) return false;
        return (
          !deferredQuery ||
          repository.owner.toLowerCase().includes(deferredQuery) ||
          repository.name.toLowerCase().includes(deferredQuery) ||
          repository.description.toLowerCase().includes(deferredQuery) ||
          repositoryCategory.toLowerCase().includes(deferredQuery)
        );
      }),
    [categorized, category, deferredQuery],
  );
  const repositoriesByOwner = useMemo(() => {
    const groups = new Map<
      string,
      Array<{
        repository: OneBrickGitHubRepository;
        category: RepositoryCategory;
      }>
    >();
    for (const item of filtered) {
      const repositoriesForOwner = groups.get(item.repository.owner) ?? [];
      repositoriesForOwner.push(item);
      groups.set(item.repository.owner, repositoriesForOwner);
    }
    return [...groups.entries()].map(([owner, ownerRepositories]) => ({
      owner,
      repositories: ownerRepositories,
    }));
  }, [filtered]);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  if (catalog.isLoading) {
    return (
      <div className="grid min-h-full place-items-center" aria-live="polite">
        <div className="text-center text-sm text-[#607086]">
          <LoaderCircle className="mx-auto mb-3 size-7 animate-spin text-[#FF6F52]" />
          Loading OneBrick repositories…
        </div>
      </div>
    );
  }
  if (catalog.error) {
    return (
      <CatalogErrorState
        error={catalog.error}
        retry={() => void catalog.refetch()}
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-[90rem] px-4 py-6 sm:px-6 [&_button]:focus-visible:outline-none [&_button]:focus-visible:ring-2 [&_button]:focus-visible:ring-[#2F6FED] [&_button]:focus-visible:ring-offset-2 [&_a]:focus-visible:outline-none [&_a]:focus-visible:ring-2 [&_a]:focus-visible:ring-[#2F6FED] [&_a]:focus-visible:ring-offset-2">
      <div className="flex min-w-0 flex-col gap-4 @5xl/hive-main:flex-row @5xl/hive-main:items-end @5xl/hive-main:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#E35E43]">
            <Boxes size={14} /> GitHub repositories
          </div>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-[#10233F]">
            Repositories
          </h2>
          <p className="mt-1 text-sm text-[#607086]">
            {repositories.length} repositories available. Start as many
            independent discussion topics as you need.
          </p>
        </div>
        <div className="relative w-full @5xl/hive-main:max-w-sm">
          <Search
            aria-hidden
            className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#8491A4]"
          />
          <input
            aria-label="Search repositories"
            className="h-10 w-full rounded-md border border-[#D8DEE8] bg-white pl-9 pr-3 text-sm outline-none focus:border-[#FF6F52]/70 focus:ring-4 focus:ring-[#FF6F52]/10"
            onChange={(event) => {
              setQuery(event.currentTarget.value);
            }}
            placeholder="Filter repository catalog…"
            value={query}
          />
        </div>
      </div>

      <fieldset className="mt-5 flex gap-2 overflow-x-auto pb-1">
        <legend className="sr-only">Repository categories</legend>
        {CATEGORIES.map((item) => (
          <button
            aria-pressed={category === item}
            className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-bold transition ${
              category === item
                ? "border-[#FF6F52] bg-[#FFF1EB] text-[#D95336]"
                : "border-[#D8DEE8] bg-white text-[#526178] hover:border-[#FF6F52]/50"
            }`}
            key={item}
            onClick={() => {
              setCategory(item);
            }}
            type="button"
          >
            {item}
          </button>
        ))}
      </fieldset>

      {filtered.length === 0 ? (
        <div className="mt-12 text-center text-sm text-[#607086]">
          No repositories match these filters.
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap items-center justify-start gap-x-4 gap-y-2 border-b border-[#E2E8F0] pb-3">
            <p className="text-xs text-[#607086]">
              {repositoriesByOwner.length} organizations · {filtered.length}{" "}
              repositories
            </p>
            <div className="flex items-center gap-2">
              <p
                className="text-[10px] font-medium text-[#607086]"
                role="status"
                aria-live="polite"
              >
                {catalog.isFetching
                  ? "Syncing repository catalog…"
                  : formatCatalogFreshness(catalog.dataUpdatedAt, now)}
              </p>
              <button
                type="button"
                className="grid size-8 place-items-center rounded-md border border-[#C7D4E5] bg-white text-[#42526B] transition hover:border-[#2F6FED]/50 hover:text-[#1F55C5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2F6FED] focus-visible:ring-offset-2 disabled:cursor-wait disabled:text-[#8491A4]"
                disabled={catalog.isFetching}
                onClick={() => void catalog.refetch()}
                aria-label="Refresh repository catalog"
                title="Refresh repository catalog"
              >
                <RefreshCw
                  className={catalog.isFetching ? "animate-spin" : ""}
                  size={14}
                />
              </button>
            </div>
          </div>
          {repositoriesByOwner.map(
            ({ owner, repositories: ownerRepositories }, ownerIndex) => {
              const isExpanded = deferredQuery
                ? true
                : !collapsedOwners.has(owner) &&
                  (ownerIndex === 0 || expandedOwners.has(owner));
              const visibilityKey = `${category}:${deferredQuery}:${owner}`;
              const visibleCount =
                visibleByOwner[visibilityKey] ?? INITIAL_REPOSITORIES_PER_OWNER;
              const visibleRepositories = ownerRepositories.slice(
                0,
                visibleCount,
              );
              const remainingRepositories = Math.max(
                0,
                ownerRepositories.length - visibleRepositories.length,
              );
              const toggleOwner = () => {
                if (isExpanded) {
                  setCollapsedOwners((current) => new Set([...current, owner]));
                  setExpandedOwners((current) => {
                    const next = new Set(current);
                    next.delete(owner);
                    return next;
                  });
                } else {
                  setExpandedOwners((current) => new Set([...current, owner]));
                  setCollapsedOwners((current) => {
                    const next = new Set(current);
                    next.delete(owner);
                    return next;
                  });
                }
              };
              return (
                <section
                  key={owner}
                  aria-labelledby={`repository-owner-${owner}`}
                >
                  <button
                    type="button"
                    onClick={toggleOwner}
                    className="mb-2 flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left transition hover:bg-white"
                    aria-expanded={isExpanded}
                    aria-controls={`repository-owner-list-${owner}`}
                  >
                    {isExpanded ? (
                      <ChevronDown size={16} className="text-[#607086]" />
                    ) : (
                      <ChevronRight size={16} className="text-[#607086]" />
                    )}
                    <h3
                      id={`repository-owner-${owner}`}
                      className="text-sm font-extrabold text-[#10233F]"
                    >
                      {owner}
                    </h3>
                    <span className="rounded-full bg-[#EEF3F8] px-2 py-0.5 text-[10px] font-bold text-[#607086]">
                      {ownerRepositories.length}
                    </span>
                    <span className="ml-auto text-[10px] font-semibold text-[#8491A4]">
                      {isExpanded ? "Collapse" : "Expand"}
                    </span>
                  </button>
                  {isExpanded && (
                    <div
                      id={`repository-owner-list-${owner}`}
                      className="overflow-hidden rounded-xl border border-[#D8DEE8] bg-white shadow-sm"
                    >
                      {visibleRepositories.map(
                        ({ repository, category: repositoryCategory }) => (
                          <article
                            className="flex min-w-0 flex-col items-stretch gap-2 border-b border-[#E2E8F0] p-3 last:border-b-0 @5xl/hive-main:flex-row @5xl/hive-main:items-center"
                            data-testid={`github-repository-${repository.owner}-${repository.name}`}
                            key={`${repository.owner}/${repository.name}`}
                          >
                            <div className="flex min-w-0 flex-1 items-center gap-3">
                              <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#EEF5FF] text-[#2F6FED]">
                                {repository.archived ? (
                                  <Archive size={17} />
                                ) : (
                                  <GitBranch size={17} />
                                )}
                              </div>
                              <div className="flex min-w-0 flex-1 items-center gap-2">
                                <h4 className="shrink-0 truncate text-sm font-bold text-[#10233F]">
                                  {repository.name}
                                </h4>
                                <div className="flex shrink-0 gap-1.5 text-[10px] font-bold uppercase tracking-wide text-[#607086]">
                                  <span>{repositoryCategory}</span>
                                  <span>·</span>
                                  <span>{repository.visibility}</span>
                                  {repository.language ? (
                                    <>
                                      <span>·</span>
                                      <span>{repository.language}</span>
                                    </>
                                  ) : null}
                                </div>
                                {repository.description && (
                                  <span className="min-w-0 flex-1 truncate text-xs text-[#607086]">
                                    {repository.description}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex min-w-0 flex-wrap items-center justify-start gap-3 @5xl/hive-main:shrink-0">
                              <div className="flex min-w-0 flex-wrap items-center gap-3 text-[10px] text-[#8491A4]">
                                <span className="flex items-center gap-1">
                                  <BookOpen size={11} />{" "}
                                  {repository.default_branch}
                                </span>
                                <span>
                                  Updated{" "}
                                  {formatUpdatedAt(repository.updated_at)}
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <button
                                  className="flex h-8 items-center gap-1.5 rounded-md bg-[#FF6F52] px-2.5 text-xs font-bold text-white hover:bg-[#E35E43] disabled:cursor-not-allowed disabled:bg-[#E2E8F0] disabled:text-[#607086]"
                                  disabled={repository.archived}
                                  onClick={() => onDiscuss(repository)}
                                  type="button"
                                  title={
                                    repository.archived
                                      ? "Archived repository"
                                      : "Start discussion"
                                  }
                                  aria-label={
                                    repository.archived
                                      ? `${repository.owner}/${repository.name} is archived`
                                      : `Start discussion in ${repository.owner}/${repository.name}`
                                  }
                                >
                                  {repository.archived ? (
                                    <Archive size={13} />
                                  ) : (
                                    <MessageCircle size={13} />
                                  )}
                                  <span className="hidden xl:inline">
                                    {repository.archived
                                      ? "Archived"
                                      : "Discuss"}
                                  </span>
                                </button>
                                <a
                                  className="grid size-8 place-items-center rounded-md border border-[#D8DEE8] text-[#42526B] hover:border-[#FF6F52]/50 hover:text-[#E35E43]"
                                  href={repository.url}
                                  rel="noreferrer"
                                  target="_blank"
                                  title="Open on GitHub"
                                  aria-label={`Open ${repository.owner}/${repository.name} on GitHub`}
                                >
                                  <ExternalLink size={13} />
                                </a>
                              </div>
                            </div>
                          </article>
                        ),
                      )}
                      {remainingRepositories > 0 && (
                        <div className="flex items-center justify-between gap-3 bg-[#F9FBFD] px-3 py-2.5">
                          <span className="text-[10px] font-semibold text-[#607086]">
                            {remainingRepositories} more in {owner}
                          </span>
                          <button
                            type="button"
                            className="rounded-md border border-[#C7D4E5] bg-white px-3 py-1.5 text-xs font-bold text-[#42526B] transition hover:border-[#2F6FED]/50 hover:text-[#1F55C5]"
                            onClick={() =>
                              setVisibleByOwner((current) => ({
                                ...current,
                                [visibilityKey]: Math.min(
                                  ownerRepositories.length,
                                  visibleCount + MORE_REPOSITORIES_STEP,
                                ),
                              }))
                            }
                          >
                            Show{" "}
                            {Math.min(
                              MORE_REPOSITORIES_STEP,
                              remainingRepositories,
                            )}{" "}
                            more
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              );
            },
          )}
        </div>
      )}
    </div>
  );
}
