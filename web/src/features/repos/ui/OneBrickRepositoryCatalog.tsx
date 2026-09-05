import {
  Archive,
  BookOpen,
  Boxes,
  ExternalLink,
  GitBranch,
  LoaderCircle,
  MessageCircle,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";

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
const REPOSITORIES_PAGE_SIZE = 24;

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
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<RepositoryCategory>("All");
  const [visibleCount, setVisibleCount] = useState(REPOSITORIES_PAGE_SIZE);
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
  const visibleByOwner = useMemo(() => {
    const groups = new Map<
      string,
      Array<{
        repository: OneBrickGitHubRepository;
        category: RepositoryCategory;
      }>
    >();
    for (const item of filtered.slice(0, visibleCount)) {
      const repositoriesForOwner = groups.get(item.repository.owner) ?? [];
      repositoriesForOwner.push(item);
      groups.set(item.repository.owner, repositoriesForOwner);
    }
    return [...groups.entries()];
  }, [filtered, visibleCount]);

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
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#E35E43]">
            <Boxes size={14} /> GitHub owners
          </div>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-[#10233F]">
            {catalog.data?.organizations.join(" + ")}
          </h2>
          <p className="mt-1 text-sm text-[#607086]">
            {repositories.length} repositories available. Start as many
            independent discussion topics as you need.
          </p>
        </div>
        <div className="relative w-full sm:max-w-sm">
          <Search
            aria-hidden
            className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#8491A4]"
          />
          <input
            aria-label="Search repositories"
            className="h-10 w-full rounded-md border border-[#D8DEE8] bg-white pl-9 pr-3 text-sm outline-none focus:border-[#FF6F52]/70 focus:ring-4 focus:ring-[#FF6F52]/10"
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setVisibleCount(REPOSITORIES_PAGE_SIZE);
            }}
            placeholder="Search repositories…"
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
              setVisibleCount(REPOSITORIES_PAGE_SIZE);
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
        <div className="mt-5 space-y-7">
          {visibleByOwner.map(([owner, ownerRepositories]) => (
            <section key={owner} aria-labelledby={`repository-owner-${owner}`}>
              <div className="mb-3 flex items-center gap-2">
                <h3
                  id={`repository-owner-${owner}`}
                  className="text-sm font-extrabold text-[#10233F]"
                >
                  {owner}
                </h3>
                <span className="rounded-full bg-[#EEF3F8] px-2 py-0.5 text-[10px] font-bold text-[#607086]">
                  {ownerRepositories.length}
                </span>
              </div>
              <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                {ownerRepositories.map(
                  ({ repository, category: repositoryCategory }) => (
                    <article
                      className="flex min-h-48 flex-col rounded-xl border border-[#D8DEE8] bg-white p-4 shadow-sm"
                      data-testid={`github-repository-${repository.owner}-${repository.name}`}
                      key={`${repository.owner}/${repository.name}`}
                    >
                      <div className="flex items-start gap-3">
                        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-[#EEF5FF] text-[#2F6FED]">
                          {repository.archived ? (
                            <Archive size={17} />
                          ) : (
                            <GitBranch size={17} />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <h4 className="truncate text-sm font-bold text-[#10233F]">
                            {repository.name}
                          </h4>
                          <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] font-bold uppercase tracking-wide text-[#607086]">
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
                        </div>
                      </div>
                      {repository.description && (
                        <p className="mt-3 line-clamp-3 flex-1 text-xs leading-5 text-[#607086]">
                          {repository.description}
                        </p>
                      )}
                      <div className="mt-auto flex items-center justify-between border-t border-[#E2E8F0] pt-3 text-[10px] text-[#8491A4]">
                        <span className="flex items-center gap-1">
                          <BookOpen size={11} /> {repository.default_branch}
                        </span>
                        <span>
                          Updated {formatUpdatedAt(repository.updated_at)}
                        </span>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <button
                          className="flex items-center justify-center gap-1.5 rounded-md bg-[#FF6F52] px-2 py-2 text-xs font-bold text-white hover:bg-[#E35E43]"
                          onClick={() => onDiscuss(repository)}
                          type="button"
                          aria-label={`Start discussion in ${repository.owner}/${repository.name}`}
                        >
                          <MessageCircle size={13} /> Start discussion
                        </button>
                        <a
                          className="flex items-center justify-center gap-1.5 rounded-md border border-[#D8DEE8] px-2 py-2 text-xs font-bold text-[#42526B] hover:border-[#FF6F52]/50 hover:text-[#E35E43]"
                          href={repository.url}
                          rel="noreferrer"
                          target="_blank"
                          aria-label={`Open ${repository.owner}/${repository.name} on GitHub`}
                        >
                          GitHub <ExternalLink size={12} />
                        </a>
                      </div>
                    </article>
                  ),
                )}
              </div>
            </section>
          ))}
          {visibleCount < filtered.length && (
            <button
              type="button"
              className="mx-auto flex items-center rounded-md border border-[#D8DEE8] bg-white px-4 py-2 text-xs font-bold text-[#42526B] hover:border-[#FF6F52]/50 hover:text-[#E35E43]"
              onClick={() =>
                setVisibleCount((current) => current + REPOSITORIES_PAGE_SIZE)
              }
            >
              Show more repositories ({filtered.length - visibleCount}{" "}
              remaining)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
