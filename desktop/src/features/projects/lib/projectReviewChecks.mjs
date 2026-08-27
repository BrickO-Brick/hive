export const PROJECT_REVIEW_CHECK_RESULT_MARKER = "BUZZ_CHECK_RESULT_V1";

/**
 * Starter checks for the dev prototype. The execution model intentionally
 * accepts this array as data so a later project-owned config reader can replace
 * it without changing the result protocol or UI state.
 */
export const DEFAULT_PROJECT_REVIEW_CHECKS = [
  {
    id: "interface",
    name: "Interface & frontend",
    description:
      "Reviews the user-facing experience and frontend implementation as one surface.",
    instructions: [
      "Inspect the user-facing behavior and frontend implementation changed by this review.",
      "Check design-system usage, interaction states, accessibility, loading and error states, performance, and visual consistency.",
      "Flag hand-rolled UI where the project design system already provides the intended primitive.",
    ],
  },
  {
    id: "code-correctness",
    name: "Code correctness",
    description:
      "Checks whether the changed code behaves correctly in normal, edge, and failure paths.",
    instructions: [
      "Trace the changed behavior through its callers, data flow, and external contracts.",
      "Look for logic errors, invalid state transitions, missed edge cases, unsafe error handling, races, and resource-lifecycle defects.",
      "Report behavior-level defects introduced by or made materially worse by this review; leave codebase conventions to their own check.",
    ],
  },
  {
    id: "codebase-patterns",
    name: "Codebase patterns",
    description:
      "Checks whether the implementation follows the architecture and established patterns of this codebase.",
    instructions: [
      "Compare the change with contributor guidance and analogous code already in the repository.",
      "Check architectural boundaries, shared abstractions, naming, error handling, and framework idioms for consistency with established patterns.",
      "Report departures that create meaningful maintenance or integration risk; leave functional defects to the code correctness check.",
    ],
  },
  {
    id: "historical-intent",
    name: "Historical intent",
    description:
      "Explores the history of the changed area to identify intentional or accidental shifts in project philosophy.",
    instructions: [
      "Inspect relevant line and path history with git blame and git log, then follow related commits into pull requests or review discussion when available.",
      "Look for prior design rationale, analogous changes, reversions, and decisions from maintainers or frequent contributors to this area.",
      "Evaluate whether this review continues, deliberately revises, or accidentally contradicts the philosophy behind the existing implementation; clearly distinguish historical evidence from inference.",
      "Do not reject a change merely because it differs from precedent. Recommend a fix only when an unexplained philosophical shift creates material product, architecture, or maintenance risk.",
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

function normalizedEventId(value) {
  if (typeof value !== "string") return null;
  const eventId = value.trim().toLowerCase();
  return eventId && /^[0-9a-f]{64}$/.test(eventId) ? eventId : null;
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
      const requestId = normalizedText(
        parsed.request_id ?? parsed.requestId,
        200,
      );
      const rawDiffEventId = parsed.diff_event_id ?? parsed.diffEventId;
      const diffEventId = normalizedEventId(rawDiffEventId);
      if (
        (rawDiffEventId !== undefined &&
          rawDiffEventId !== null &&
          !diffEventId) ||
        (conclusion === "approved" && diffEventId)
      ) {
        continue;
      }
      const findings = Array.isArray(parsed.findings)
        ? parsed.findings.map(normalizedFinding).filter(Boolean).slice(0, 20)
        : [];
      return {
        ...(requestId ? { requestId } : {}),
        ...(conclusion === "fix-recommended" && diffEventId
          ? { diffEventId }
          : {}),
        conclusion,
        summary,
        findings,
      };
    } catch {
      // Agents occasionally wrap the JSON with prose. Try the next bounded
      // candidate instead of accepting an unstructured response as a result.
    }
  }
  return null;
}

function eventTag(event, name, maxLength) {
  if (!Array.isArray(event.tags)) return null;
  const value = event.tags.find(
    (tag) => Array.isArray(tag) && tag[0] === name,
  )?.[1];
  return normalizedText(value, maxLength);
}

/** Resolve a result's event-id reference to one exact native Buzz diff. */
export function parseProjectReviewCheckDiffEvent(event, expected) {
  if (
    !event ||
    typeof event !== "object" ||
    Array.isArray(event) ||
    !expected ||
    typeof expected !== "object" ||
    Array.isArray(expected)
  ) {
    return null;
  }
  const eventId = normalizedEventId(event.id);
  const expectedEventId = normalizedEventId(expected?.eventId);
  const author = normalizedText(event.pubkey, 64)?.toLowerCase() ?? null;
  const expectedAuthor = normalizedText(
    expected?.agentPubkey,
    64,
  )?.toLowerCase();
  if (
    event.kind !== 40008 ||
    !eventId ||
    eventId !== expectedEventId ||
    !author ||
    author !== expectedAuthor ||
    typeof event.content !== "string" ||
    !event.content.trim() ||
    !/^diff --git /m.test(event.content) ||
    new TextEncoder().encode(event.content).byteLength > 60 * 1024
  ) {
    return null;
  }

  const repoUrl = eventTag(event, "repo", 2_000);
  const commitSha = eventTag(event, "commit", 128);
  if (
    !repoUrl ||
    repoUrl !== expected.repoUrl ||
    !commitSha ||
    (expected.commit &&
      commitSha.toLowerCase() !== expected.commit.toLowerCase())
  ) {
    return null;
  }

  return {
    eventId,
    content: event.content,
    repoUrl,
    commitSha,
    filePath: eventTag(event, "file", 1_000),
    description: eventTag(event, "description", 1_000),
    truncated: eventTag(event, "truncated", 16) === "true",
  };
}

export function buildProjectReviewCheckPrompt({
  check,
  projectName,
  repoAddress,
  repoUrl,
  channelId,
  reviewId,
  reviewLink,
  reviewTitle,
  requestId,
  commit,
  branchName,
  targetBranch,
}) {
  const scope = [
    `Project: ${JSON.stringify(projectName)}`,
    `Repository address: ${JSON.stringify(repoAddress)}`,
    `Repository URL for diff metadata: ${repoUrl ? JSON.stringify(repoUrl) : "unavailable"}`,
    `Buzz channel for a diff proposal: ${JSON.stringify(channelId)}`,
    `Review: ${JSON.stringify(reviewTitle)} (${reviewId})`,
    `Review link: ${reviewLink}`,
    `Request id: ${JSON.stringify(requestId)}`,
    `Commit under review: ${commit ?? "unknown"}`,
    `Branch: ${branchName ?? "unknown"} -> ${targetBranch ?? "unknown"}`,
  ];
  return [
    `Run the project review check ${JSON.stringify(check.name)}.`,
    "THREAD CONTRACT: This message is one independent project review check request.",
    "The enclosing Buzz event's Event ID (shown by the agent harness immediately above this message content) is THIS_REQUEST_EVENT_ID and is this request's thread root.",
    "If one turn contains multiple project review check events, process every event independently. A newer event must never replace, cancel, combine with, or stand in for an earlier event.",
    `For every check event, publish exactly one final result in that event's own thread by providing the marker and JSON below on stdin to: buzz messages send --channel ${JSON.stringify(channelId)} --content - --reply-to <THIS_REQUEST_EVENT_ID>`,
    "Replace <THIS_REQUEST_EVENT_ID> with the exact 64-character Event ID enclosing this request, without angle brackets. Never use the newest or another check event's ID as a shortcut.",
    "Never post a check result at the DM top level or in another check's thread. Do not finish the turn after answering only the last event; every request_id delivered in the turn needs its own threaded result.",
    "Review only; do not modify code, push commits, or change the review.",
    "Use the repository and Buzz tools available to you to inspect the exact review commit.",
    "",
    ...scope,
    "",
    "Check definition:",
    ...check.instructions.map((instruction) => `- ${instruction}`),
    "",
    "End this request's threaded result with exactly this marker and one JSON object:",
    PROJECT_REVIEW_CHECK_RESULT_MARKER,
    JSON.stringify({
      request_id: requestId,
      conclusion: "fix-recommended",
      summary: "short explanation",
      diff_event_id: null,
      findings: [
        {
          title: "concise actionable fix",
          detail: "why this matters and what to change",
          file: "relative/path.ext",
          line: 123,
        },
      ],
    }),
    "Echo request_id exactly as provided so this result is matched to the correct concurrent check.",
    "Return an empty findings array when approved. For every recommended fix, return one finding object.",
    "Use null for file or line when the finding is not tied to a precise source location.",
    "Use approved only when no material fix is recommended. Use fix-recommended otherwise.",
    ...(repoUrl && commit
      ? [
          "When recommending a fix and you can express it safely as code, create one valid unified diff against the exact commit without modifying or committing the review branch.",
          `Pipe that patch into this command before the final result to publish one native Buzz diff message (kind 40008) in this request's thread: buzz messages send-diff --channel ${JSON.stringify(channelId)} --diff - --repo ${JSON.stringify(repoUrl)} --commit ${JSON.stringify(commit)} --description ${JSON.stringify(`Review check ${requestId}`)} --reply-to <THIS_REQUEST_EVENT_ID>`,
          "Only after send-diff succeeds, copy its exact 64-character event_id into diff_event_id in the final JSON. Never invent or reuse an event id. Do not paste the patch into the JSON.",
          "Use diff_event_id: null when there is no safe code patch. Approved results must use diff_event_id: null.",
        ]
      : [
          "Use diff_event_id: null because this review does not expose the repository URL and exact commit required for a native diff proposal.",
        ]),
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
