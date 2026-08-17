/**
 * Parses the `buzz-workstream-card` sentinel that a channel canvas may embed
 * to describe the workstream running in that channel.
 *
 * Wire format (authored by hand or by an orchestrating agent):
 *
 * ```
 * ```buzz-workstream-card
 * {"version":1,"synopsis":"…","orchestrator":"…","assignees":[…]}
 * ```
 * ```
 *
 * Only one block per canvas is supported. A missing block, malformed JSON,
 * an unrecognized version, or missing/invalid required fields are all
 * card-local parse failures — the caller degrades just that card, it never
 * throws.
 */

const FENCE_OPEN = "```buzz-workstream-card";
const FENCE_CLOSE = "```";

export type WorkstreamCardV1 = {
  version: 1;
  synopsis: string;
  orchestrator: string;
  assignees: string[];
  pullRequests: unknown[];
  waitingOn: unknown[];
};

export type WorkstreamCardParseFailureReason =
  | "not-found"
  | "invalid-json"
  | "duplicate-block"
  | "unknown-version"
  | "invalid-fields";

export type WorkstreamCardParseResult =
  | { ok: true; card: WorkstreamCardV1 }
  | { ok: false; reason: WorkstreamCardParseFailureReason };

function findFencedBlocks(content: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;

  while (true) {
    const openIdx = content.indexOf(FENCE_OPEN, cursor);
    if (openIdx === -1) break;

    const jsonStart = content.indexOf("\n", openIdx);
    if (jsonStart === -1) break;

    const closeIdx = content.indexOf(`\n${FENCE_CLOSE}`, jsonStart);
    if (closeIdx === -1) break;

    blocks.push(content.slice(jsonStart + 1, closeIdx).trim());
    cursor = closeIdx + `\n${FENCE_CLOSE}`.length;
  }

  return blocks;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * Parse the single `buzz-workstream-card` block out of a channel canvas.
 * Never throws — every failure mode maps to a `WorkstreamCardParseFailureReason`.
 */
export function parseWorkstreamCard(
  content: string | null | undefined,
): WorkstreamCardParseResult {
  if (!content) {
    return { ok: false, reason: "not-found" };
  }

  const blocks = findFencedBlocks(content);
  if (blocks.length === 0) {
    return { ok: false, reason: "not-found" };
  }
  if (blocks.length > 1) {
    return { ok: false, reason: "duplicate-block" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(blocks[0]);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "invalid-fields" };
  }

  const raw = parsed as Record<string, unknown>;

  if (raw.version !== 1) {
    return { ok: false, reason: "unknown-version" };
  }

  if (typeof raw.synopsis !== "string" || raw.synopsis.trim() === "") {
    return { ok: false, reason: "invalid-fields" };
  }
  if (typeof raw.orchestrator !== "string" || raw.orchestrator.trim() === "") {
    return { ok: false, reason: "invalid-fields" };
  }

  const assignees = raw.assignees ?? [];
  if (!isStringArray(assignees)) {
    return { ok: false, reason: "invalid-fields" };
  }

  const pullRequests = raw.pullRequests ?? [];
  if (!Array.isArray(pullRequests)) {
    return { ok: false, reason: "invalid-fields" };
  }

  const waitingOn = raw.waitingOn ?? [];
  if (!Array.isArray(waitingOn)) {
    return { ok: false, reason: "invalid-fields" };
  }

  return {
    ok: true,
    card: {
      version: 1,
      synopsis: raw.synopsis,
      orchestrator: raw.orchestrator,
      assignees,
      pullRequests,
      waitingOn,
    },
  };
}
