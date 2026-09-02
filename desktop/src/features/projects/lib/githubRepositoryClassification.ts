import type { GitHubRepositoryCatalogEntry } from "@/shared/api/githubRepositoryCatalog";

export type RepositoryCatalogCategoryId =
  | "collaboration"
  | "customer-products"
  | "mantul-platform"
  | "platform-operations"
  | "data-intelligence"
  | "knowledge"
  | "security-governance"
  | "uncategorized";

export type RepositoryCatalogCategory = {
  id: RepositoryCatalogCategoryId;
  label: string;
  description: string;
};

export type ClassifiedGitHubRepository = GitHubRepositoryCatalogEntry & {
  category: RepositoryCatalogCategory;
  signals: string[];
};

export const REPOSITORY_CATALOG_CATEGORIES: RepositoryCatalogCategory[] = [
  {
    id: "collaboration",
    label: "Collaboration",
    description: "Communication, agent, and shared engineering workspaces.",
  },
  {
    id: "customer-products",
    label: "Customer products",
    description: "Customer-facing applications and product services.",
  },
  {
    id: "mantul-platform",
    label: "Mantul platform",
    description: "Mantul applications, modules, contracts, and SDKs.",
  },
  {
    id: "platform-operations",
    label: "Platform operations",
    description: "Runtime, delivery, automation, and service operations.",
  },
  {
    id: "data-intelligence",
    label: "Data & intelligence",
    description: "Data pipelines, analytical systems, and metrics.",
  },
  {
    id: "knowledge",
    label: "Knowledge & documentation",
    description: "Documentation, wiki, and curated knowledge sources.",
  },
  {
    id: "security-governance",
    label: "Security & governance",
    description: "Security testing, compliance, risk, and governance.",
  },
  {
    id: "uncategorized",
    label: "Needs classification",
    description: "Repositories awaiting owner-confirmed categorization.",
  },
];

const CATEGORY_BY_ID = new Map(
  REPOSITORY_CATALOG_CATEGORIES.map((category) => [category.id, category]),
);

function category(id: RepositoryCatalogCategoryId) {
  const match = CATEGORY_BY_ID.get(id);
  if (!match) throw new Error(`Unknown repository catalog category: ${id}`);
  return match;
}

function includesAny(value: string, terms: string[]) {
  return terms.some((term) => value.includes(term));
}

/**
 * Conservative, inspectable first-pass categorization. These rules only use
 * repository metadata returned by GitHub; they are a proposal for the owner
 * to discuss and refine, never an inferred permission or ownership decision.
 */
export function classifyGitHubRepository(
  repository: GitHubRepositoryCatalogEntry,
): ClassifiedGitHubRepository {
  const name = repository.name.toLowerCase();
  const haystack = `${name} ${repository.description.toLowerCase()}`;
  let categoryId: RepositoryCatalogCategoryId = "uncategorized";
  const signals: string[] = [];

  if (name === "hive" || includesAny(haystack, ["collaboration workspace"])) {
    categoryId = "collaboration";
    signals.push("collaboration workspace");
  } else if (name.startsWith("mantul")) {
    categoryId = "mantul-platform";
    signals.push("mantul repository family");
  } else if (
    includesAny(name, ["brickr", "grc"]) ||
    includesAny(haystack, ["security", "compliance", "governance", "risk"])
  ) {
    categoryId = "security-governance";
    signals.push("security or governance metadata");
  } else if (
    includesAny(name, ["docs", "wiki", "knowledge", "readme"]) ||
    includesAny(haystack, ["documentation", "knowledge"])
  ) {
    categoryId = "knowledge";
    signals.push("documentation or knowledge metadata");
  } else if (
    includesAny(name, ["etl", "clickhouse"]) ||
    includesAny(haystack, ["analytics", "metric", "data pipeline"])
  ) {
    categoryId = "data-intelligence";
    signals.push("data or analytical metadata");
  } else if (
    includesAny(name, [
      "stack",
      "logs",
      "email-engine",
      "automation",
      "callback-test",
    ]) ||
    includesAny(haystack, [
      "deployment",
      "runtime",
      "monitoring",
      "operational",
    ])
  ) {
    categoryId = "platform-operations";
    signals.push("runtime or operations metadata");
  } else if (
    name === "bpjs" ||
    name === "cs" ||
    name === "client" ||
    name.startsWith("client-") ||
    name.startsWith("frontend-")
  ) {
    categoryId = "customer-products";
    signals.push("application repository naming");
  }

  if (repository.language) signals.push(repository.language);
  if (repository.archived) signals.push("archived");
  return { ...repository, category: category(categoryId), signals };
}

export function groupClassifiedGitHubRepositories(
  repositories: GitHubRepositoryCatalogEntry[],
) {
  const classified = repositories.map(classifyGitHubRepository);
  return REPOSITORY_CATALOG_CATEGORIES.map((catalogCategory) => ({
    category: catalogCategory,
    repositories: classified.filter(
      (repository) => repository.category.id === catalogCategory.id,
    ),
  })).filter((group) => group.repositories.length > 0);
}
