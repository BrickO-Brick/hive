export const PROJECT_REVIEW_CONTEXT_RESULT_MARKER =
  "BUZZ_REVIEW_CONTEXT_RESULT_V1";

export const PROJECT_REVIEW_CONTEXT_STORAGE_PREFIX =
  "buzz.projects.review-context.v1";

export const MAX_PROJECT_REVIEW_CONTEXT_ITEMS = 8;

export type ProjectReviewContextReference = {
  title: string;
  summary: string;
  sourceUrl: string;
  channel?: string;
};

export type ProjectReviewContextResult = {
  requestId?: string;
  summary: string;
  priorArt: ProjectReviewContextReference[];
  futureVision: ProjectReviewContextReference[];
};

function normalizedText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : null;
}

function normalizedSourceUrl(
  value: unknown,
  kind: "prior-art" | "future-vision",
): string | null {
  const sourceUrl = normalizedText(value, 2_000);
  if (!sourceUrl) return null;
  try {
    const parsed = new URL(sourceUrl);
    if (kind === "prior-art") {
      if (parsed.protocol === "https:") return sourceUrl;
      if (
        parsed.protocol === "buzz:" &&
        parsed.hostname === "pr" &&
        /^[0-9a-f]{64}$/i.test(parsed.searchParams.get("id") ?? "") &&
        /^[0-9a-f]{64}$/i.test(parsed.searchParams.get("owner") ?? "") &&
        parsed.searchParams.get("d")
      ) {
        return sourceUrl;
      }
      return null;
    }
    if (parsed.protocol !== "buzz:" || parsed.hostname !== "message") {
      return null;
    }
    const channelId = parsed.searchParams.get("channel")?.trim();
    const messageId = parsed.searchParams.get("id")?.trim();
    return channelId && messageId && /^[0-9a-f]{64}$/i.test(messageId)
      ? sourceUrl
      : null;
  } catch {
    return null;
  }
}

function normalizedReference(
  value: unknown,
  kind: "prior-art" | "future-vision",
): ProjectReviewContextReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const title = normalizedText(raw.title, 240);
  const summary = normalizedText(raw.summary, 1_200);
  const sourceUrl = normalizedSourceUrl(raw.source_url ?? raw.sourceUrl, kind);
  if (!title || !summary || !sourceUrl) return null;
  const channel = normalizedText(raw.channel, 120)?.replace(/^#/, "");
  return {
    title,
    summary,
    sourceUrl,
    ...(kind === "future-vision" && channel ? { channel } : {}),
  };
}

function jsonObjectsAfterMarker(content: string): string[] {
  const markerIndex = content.lastIndexOf(PROJECT_REVIEW_CONTEXT_RESULT_MARKER);
  if (markerIndex < 0) return [];
  const tail = content.slice(
    markerIndex + PROJECT_REVIEW_CONTEXT_RESULT_MARKER.length,
  );
  const candidates: string[] = [];
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

/** Parse the bounded evidence contract emitted by the discovery agent. */
export function parseProjectReviewContextResult(
  content: unknown,
): ProjectReviewContextResult | null {
  if (typeof content !== "string") return null;
  for (const candidate of jsonObjectsAfterMarker(content)) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      const raw = parsed as Record<string, unknown>;
      const summary = normalizedText(raw.summary, 4_000);
      const rawPriorArt = raw.prior_art ?? raw.priorArt;
      const rawFutureVision = raw.future_vision ?? raw.futureVision;
      if (
        !summary ||
        !Array.isArray(rawPriorArt) ||
        !Array.isArray(rawFutureVision)
      ) {
        continue;
      }
      const requestId = normalizedText(raw.request_id ?? raw.requestId, 200);
      return {
        ...(requestId ? { requestId } : {}),
        summary,
        priorArt: rawPriorArt
          .map((value) => normalizedReference(value, "prior-art"))
          .filter(
            (value): value is ProjectReviewContextReference => value !== null,
          )
          .slice(0, MAX_PROJECT_REVIEW_CONTEXT_ITEMS),
        futureVision: rawFutureVision
          .map((value) => normalizedReference(value, "future-vision"))
          .filter(
            (value): value is ProjectReviewContextReference => value !== null,
          )
          .slice(0, MAX_PROJECT_REVIEW_CONTEXT_ITEMS),
      };
    } catch {
      // Agents occasionally wrap JSON in prose. Try the next bounded candidate.
    }
  }
  return null;
}

export function buildProjectReviewContextPrompt({
  branchName,
  channelId,
  commit,
  projectName,
  repoAddress,
  repoUrl,
  requestId,
  reviewId,
  reviewLink,
  reviewTitle,
  supersededEventId,
  supersededRequestId,
  targetBranch,
}: {
  branchName: string | null;
  channelId: string;
  commit: string | null;
  projectName: string;
  repoAddress: string;
  repoUrl: string | null;
  requestId: string;
  reviewId: string;
  reviewLink: string;
  reviewTitle: string;
  supersededEventId?: string;
  supersededRequestId?: string;
  targetBranch: string | null;
}): string {
  return [
    "Discover the prior art and future vision relevant to this project review.",
    "THREAD CONTRACT: This message is one independent review-context request.",
    "The enclosing Buzz event's Event ID (shown by the agent harness immediately above this message content) is THIS_REQUEST_EVENT_ID and is this request's thread root.",
    `Publish exactly one final result in this request's thread by providing the marker and JSON below on stdin to: buzz messages send --channel ${JSON.stringify(channelId)} --content - --reply-to <THIS_REQUEST_EVENT_ID>`,
    "Replace <THIS_REQUEST_EVENT_ID> with the exact 64-character Event ID enclosing this request. Never answer at the DM top level or in another request's thread.",
    "Research only. Do not modify code, push commits, or change the review.",
    "Use the repository, review-history, and Buzz search tools available to you. Do not rely only on the current diff.",
    "Treat this context as evidence for reviewers, not as a merge gate or an approval decision.",
    "Never invent a source. Omit an item unless you can provide a direct, verifiable source URL.",
    "",
    `Project: ${JSON.stringify(projectName)}`,
    `Repository address: ${JSON.stringify(repoAddress)}`,
    `Repository URL: ${repoUrl ? JSON.stringify(repoUrl) : "unavailable"}`,
    `Review: ${JSON.stringify(reviewTitle)} (${reviewId})`,
    `Review link: ${reviewLink}`,
    `Request id: ${JSON.stringify(requestId)}`,
    `Commit under review: ${commit ?? "unknown"}`,
    `Branch: ${branchName ?? "unknown"} -> ${targetBranch ?? "unknown"}`,
    ...(supersededRequestId && supersededEventId
      ? [
          "",
          "INTERRUPT DIRECTIVE: This replacement request supersedes exactly one earlier review-context request.",
          `Superseded request id: ${JSON.stringify(supersededRequestId)}`,
          `Superseded event id: ${supersededEventId}`,
          "Stop that superseded request and publish only the replacement result.",
        ]
      : []),
    "",
    "Prior art:",
    "- Find earlier pull requests or reviews that changed the same area, established the current approach, documented a constraint, or later reversed a related decision.",
    "- Inspect commits and blame only as leads; follow them to the review discussion when possible.",
    "- source_url must be an https URL to the exact review or a canonical buzz://pr link. Do not cite a generic repository page.",
    "",
    "Future vision:",
    "- Search project-linked Buzz channels and conversations for plans, intended direction, constraints, or outcomes this review should enable.",
    "- Prefer specific team conversations over broad channel descriptions, and distinguish stated intent from your inference.",
    "- source_url must be a canonical buzz://message?channel=<id>&id=<event-id> link copied from the exact source conversation.",
    "",
    "End the threaded result with exactly this marker and one JSON object:",
    PROJECT_REVIEW_CONTEXT_RESULT_MARKER,
    JSON.stringify({
      request_id: requestId,
      summary: "What the discovered evidence says about this review overall.",
      prior_art: [
        {
          title: "Earlier review title",
          summary: "The relevant decision and why it matters now.",
          source_url: "https://example.com/org/repo/pull/123",
        },
      ],
      future_vision: [
        {
          title: "Direction discussed by the team",
          summary: "The stated future direction and its relevance.",
          channel: "engineering",
          source_url:
            "buzz://message?channel=<channel-id>&id=<message-event-id>",
        },
      ],
    }),
    "Echo request_id exactly as provided so this result is matched to the correct concurrent request.",
    "Return an empty array when no supported evidence is found for a section. Keep each section to the most relevant eight sources.",
  ].join("\n");
}

export function projectReviewContextStorageKey({
  relayUrl,
  repoAddress,
  reviewId,
  signerPubkey,
}: {
  relayUrl: string | null | undefined;
  repoAddress: string | null | undefined;
  reviewId: string | null | undefined;
  signerPubkey: string | null | undefined;
}): string | null {
  const relay = relayUrl?.trim().toLowerCase();
  const signer = signerPubkey?.trim().toLowerCase();
  const repo = repoAddress?.trim().toLowerCase();
  const review = reviewId?.trim().toLowerCase();
  if (!relay || !signer || !repo || !review) return null;
  return [
    PROJECT_REVIEW_CONTEXT_STORAGE_PREFIX,
    encodeURIComponent(relay),
    signer,
    encodeURIComponent(repo),
    review,
  ].join(":");
}

export function readProjectReviewContextRun(
  storage: Pick<Storage, "getItem"> | null | undefined,
  key: string | null | undefined,
): Record<string, unknown> | null {
  if (!storage || !key) return null;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function writeProjectReviewContextRun(
  storage: Pick<Storage, "setItem"> | null | undefined,
  key: string | null | undefined,
  run: Record<string, unknown>,
): void {
  if (!storage || !key) return;
  storage.setItem(key, JSON.stringify(run));
}
