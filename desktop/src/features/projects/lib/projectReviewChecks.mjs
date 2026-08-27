import { parse as parseYaml } from "yaml";

export const PROJECT_REVIEW_CHECK_RESULT_MARKER = "BUZZ_CHECK_RESULT_V1";
export const PROJECT_REVIEW_CHECKS_CONFIG_PATH = ".buzz/review-checks.yml";

/**
 * Starter checks for the dev prototype. The execution model intentionally
 * accepts this array as data so a later project-owned config reader can replace
 * it without changing the result protocol or UI state.
 */
export const DEFAULT_PROJECT_REVIEW_CHECKS = [
  {
    id: "interface",
    name: "Interface & design system",
    description:
      "Reviews user-facing changes against the design system and their backend contracts.",
    instructions: [
      "Inspect user-facing changes and the backend behavior that supplies them.",
      "Check design-system component usage, interaction states, accessibility, and visual consistency.",
      "Flag hand-rolled UI where the project design system already provides the intended primitive.",
    ],
  },
  {
    id: "frontend",
    name: "Frontend quality",
    description:
      "Reviews frontend correctness, state boundaries, accessibility, and maintainability.",
    instructions: [
      "Inspect the frontend implementation changed by this review.",
      "Check data flow, loading and error states, accessibility, performance, and maintainability.",
      "Only report issues introduced by or made materially worse by this review.",
    ],
  },
  {
    id: "test-quality",
    name: "Test quality",
    description:
      "Evaluates whether tests prove the changed behavior instead of merely passing.",
    instructions: [
      "Compare the tests with the production behavior changed by this review.",
      "Look for missing behavioral coverage, assertions that cannot catch regressions, and over-mocked paths.",
      "Do not treat a green test command by itself as evidence of adequate test quality.",
    ],
  },
];

function requiredConfigText(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  if (value.trim().length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters.`);
  }
  return value.trim();
}

/** Parse and bound the repository-owned check definition file. */
export function parseProjectReviewChecksConfig(content) {
  let parsed;
  try {
    parsed = parseYaml(content);
  } catch (error) {
    throw new Error(
      `Could not parse ${PROJECT_REVIEW_CHECKS_CONFIG_PATH}: ${
        error instanceof Error ? error.message : "invalid YAML"
      }`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${PROJECT_REVIEW_CHECKS_CONFIG_PATH} must be an object.`);
  }
  if (parsed.version !== 1) {
    throw new Error(
      `${PROJECT_REVIEW_CHECKS_CONFIG_PATH} must declare version: 1.`,
    );
  }
  if (
    !Array.isArray(parsed.checks) ||
    parsed.checks.length === 0 ||
    parsed.checks.length > 12
  ) {
    throw new Error(
      `${PROJECT_REVIEW_CHECKS_CONFIG_PATH} must define between 1 and 12 checks.`,
    );
  }
  const ids = new Set();
  return parsed.checks.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`checks[${index}] must be an object.`);
    }
    const id = requiredConfigText(raw.id, `checks[${index}].id`, 49);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new Error(
        `checks[${index}].id may only use lowercase letters, numbers, and hyphens.`,
      );
    }
    if (ids.has(id)) throw new Error(`Duplicate check id: ${id}.`);
    ids.add(id);
    const name = requiredConfigText(raw.name, `checks[${index}].name`, 80);
    const description = requiredConfigText(
      raw.description,
      `checks[${index}].description`,
      240,
    );
    if (
      !Array.isArray(raw.instructions) ||
      raw.instructions.length === 0 ||
      raw.instructions.length > 12
    ) {
      throw new Error(
        `checks[${index}].instructions must contain between 1 and 12 items.`,
      );
    }
    const instructions = raw.instructions.map((instruction, instructionIndex) =>
      requiredConfigText(
        instruction,
        `checks[${index}].instructions[${instructionIndex}]`,
        500,
      ),
    );
    return { id, name, description, instructions };
  });
}

function normalizedText(value, maxLength) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : null;
}

function normalizedConclusion(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "approved" || normalized === "approve") {
    return "approved";
  }
  if (
    normalized === "fix-recommended" ||
    normalized === "recommended-fix" ||
    normalized === "changes-requested"
  ) {
    return "fix-recommended";
  }
  return null;
}

function normalizedFinding(value) {
  if (typeof value === "string") {
    const title = normalizedText(value, 240);
    return title ? { title, detail: null, file: null, line: null } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const title = normalizedText(value.title, 240);
  if (!title) return null;
  const line =
    Number.isInteger(value.line) && value.line > 0 && value.line <= 10_000_000
      ? value.line
      : null;
  return {
    title,
    detail: normalizedText(value.detail, 1_000),
    file: normalizedText(value.file, 500),
    line,
  };
}

function jsonObjectsAfterMarker(content) {
  const markerIndex = content.lastIndexOf(PROJECT_REVIEW_CHECK_RESULT_MARKER);
  if (markerIndex < 0) return [];
  const tail = content.slice(
    markerIndex + PROJECT_REVIEW_CHECK_RESULT_MARKER.length,
  );
  const candidates = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of tail.matchAll(fenced)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  candidates.push(tail.trim());
  const firstBrace = tail.indexOf("{");
  const lastBrace = tail.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(tail.slice(firstBrace, lastBrace + 1));
  }
  return [...new Set(candidates.filter(Boolean))];
}

/** Parse the deliberately small response contract emitted by check agents. */
export function parseProjectReviewCheckResult(content) {
  if (typeof content !== "string") return null;
  for (const candidate of jsonObjectsAfterMarker(content)) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      const conclusion = normalizedConclusion(parsed.conclusion);
      const summary = normalizedText(parsed.summary, 4_000);
      if (!conclusion || !summary) continue;
      const findings = Array.isArray(parsed.findings)
        ? parsed.findings.map(normalizedFinding).filter(Boolean).slice(0, 20)
        : [];
      return { conclusion, summary, findings };
    } catch {
      // Agents occasionally wrap the JSON with prose. Try the next bounded
      // candidate instead of accepting an unstructured response as a result.
    }
  }
  return null;
}

export function buildProjectReviewCheckPrompt({
  check,
  projectName,
  repoAddress,
  reviewId,
  reviewLink,
  reviewTitle,
  commit,
  branchName,
  targetBranch,
}) {
  const scope = [
    `Project: ${JSON.stringify(projectName)}`,
    `Repository address: ${JSON.stringify(repoAddress)}`,
    `Review: ${JSON.stringify(reviewTitle)} (${reviewId})`,
    `Review link: ${reviewLink}`,
    `Commit under review: ${commit ?? "unknown"}`,
    `Branch: ${branchName ?? "unknown"} -> ${targetBranch ?? "unknown"}`,
  ];
  return [
    `Run the project review check ${JSON.stringify(check.name)}.`,
    "Review only; do not modify code, push commits, or change the review.",
    "Use the repository and Buzz tools available to you to inspect the exact review commit.",
    "",
    ...scope,
    "",
    "Check definition:",
    ...check.instructions.map((instruction) => `- ${instruction}`),
    "",
    "End your response with exactly this marker and one JSON object:",
    PROJECT_REVIEW_CHECK_RESULT_MARKER,
    '{"conclusion":"approved|fix-recommended","summary":"short explanation","findings":[{"title":"concise actionable fix","detail":"why this matters and what to change","file":"relative/path.ext","line":123}]}',
    "Return an empty findings array when approved. For every recommended fix, return one finding object.",
    "Use null for file or line when the finding is not tied to a precise source location.",
    "Use approved only when no material fix is recommended. Use fix-recommended otherwise.",
  ].join("\n");
}

export function projectReviewChecksStorageKey({
  relayUrl,
  signerPubkey,
  repoAddress,
  reviewId,
}) {
  if (!relayUrl || !signerPubkey || !repoAddress || !reviewId) return null;
  return [
    "buzz.projects.review-checks.v1",
    relayUrl.trim().toLowerCase(),
    signerPubkey.trim().toLowerCase(),
    repoAddress.trim().toLowerCase(),
    reviewId.trim().toLowerCase(),
  ].join(":");
}

export function readProjectReviewCheckRuns(storage, key) {
  if (!storage || !key) return {};
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export function writeProjectReviewCheckRuns(storage, key, runs) {
  if (!storage || !key) return;
  storage.setItem(key, JSON.stringify(runs));
}
