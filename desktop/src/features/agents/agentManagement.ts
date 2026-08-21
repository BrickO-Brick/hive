import type {
  AgentPersona,
  CreatePersonaInput,
  ManagedAgent,
  RespondToMode,
  UpdatePersonaInput,
} from "@/shared/api/types";

/**
 * Wire contract for agent-initiated agent management. Mirrors
 * `crates/buzz-sdk/src/agent_management.rs`; keep the two in sync.
 *
 * Requests arrive as observer telemetry payloads from an owned agent
 * (`buzz agents create|update|delete`). Results go back as observer control
 * payloads so the requesting CLI can report what happened.
 */
export const AGENT_MANAGEMENT_REQUEST = "agent_management_request" as const;
export const AGENT_MANAGEMENT_RESULT = "agent_management_result" as const;

export const MAX_AGENT_NAME_CHARS = 120;
export const MAX_SYSTEM_PROMPT_CHARS = 20_000;
export const MAX_SHORT_FIELD_CHARS = 300;
export const MAX_AVATAR_URL_CHARS = 2_048;
export const MAX_PARALLELISM = 32;

/** Only the two non-allowlist modes are expressible from a request. */
export type RequestRespondTo = Extract<RespondToMode, "owner-only" | "anyone">;

/** Identify the agent a request targets: exactly one of the two is set. */
export type AgentTarget =
  | { agentPubkey: string; agentName?: undefined }
  | { agentName: string; agentPubkey?: undefined };

export type AgentManagementCreateRequest = {
  type: typeof AGENT_MANAGEMENT_REQUEST;
  action: "create";
  requestId: string;
  review?: boolean;
  request: {
    channelId: string;
    displayName: string;
    systemPrompt: string;
    runtime?: string;
    provider?: string;
    model?: string;
    respondTo?: RequestRespondTo;
    parallelism?: number;
    avatarUrl?: string;
    /** Absent means start. */
    start?: boolean;
  };
};

export type AgentManagementUpdateChanges = {
  displayName?: string;
  systemPrompt?: string;
  runtime?: string;
  provider?: string;
  model?: string;
  respondTo?: RequestRespondTo;
};

export type AgentManagementUpdateRequest = {
  type: typeof AGENT_MANAGEMENT_REQUEST;
  action: "update";
  requestId: string;
  review?: boolean;
  request: { channelId: string } & AgentTarget & AgentManagementUpdateChanges;
};

export type AgentManagementDeleteRequest = {
  type: typeof AGENT_MANAGEMENT_REQUEST;
  action: "delete";
  requestId: string;
  review?: boolean;
  request: { channelId: string } & AgentTarget;
};

export type AgentManagementRequest =
  | AgentManagementCreateRequest
  | AgentManagementUpdateRequest
  | AgentManagementDeleteRequest;

export type AgentManagementAction = AgentManagementRequest["action"];

export type AgentManagementStatus =
  | "executed"
  | "pending_owner_review"
  | "dismissed"
  | "rejected"
  | "failed";

export type AgentManagementResult = {
  type: typeof AGENT_MANAGEMENT_RESULT;
  requestId: string;
  action: AgentManagementAction;
  status: AgentManagementStatus;
  agentPubkey?: string;
  agentName?: string;
  personaId?: string;
  error?: string;
};

function isText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= max
  );
}

function isOptionalText(value: unknown, max: number): boolean {
  return value === undefined || isText(value, max);
}

function isRespondTo(value: unknown): value is RequestRespondTo | undefined {
  return value === undefined || value === "owner-only" || value === "anyone";
}

function isOptionalParallelism(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= MAX_PARALLELISM)
  );
}

function isHexPubkey(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

const CREATE_KEYS = [
  "channelId",
  "displayName",
  "systemPrompt",
  "runtime",
  "provider",
  "model",
  "respondTo",
  "parallelism",
  "avatarUrl",
  "start",
] as const;

const TARGET_KEYS = ["agentPubkey", "agentName"] as const;

const UPDATE_KEYS = [
  "channelId",
  ...TARGET_KEYS,
  "displayName",
  "systemPrompt",
  "runtime",
  "provider",
  "model",
  "respondTo",
] as const;

const DELETE_KEYS = ["channelId", ...TARGET_KEYS] as const;

function parseTarget(request: Record<string, unknown>): AgentTarget | null {
  const { agentPubkey, agentName } = request;
  if (agentPubkey !== undefined && agentName !== undefined) return null;
  if (agentPubkey !== undefined) {
    return isHexPubkey(agentPubkey)
      ? { agentPubkey: agentPubkey.toLowerCase() }
      : null;
  }
  if (isText(agentName, MAX_AGENT_NAME_CHARS)) return { agentName };
  return null;
}

function parseUpdateChanges(
  request: Record<string, unknown>,
): AgentManagementUpdateChanges | null {
  if (
    !isRespondTo(request.respondTo) ||
    !isOptionalText(request.displayName, MAX_AGENT_NAME_CHARS) ||
    !isOptionalText(request.systemPrompt, MAX_SYSTEM_PROMPT_CHARS) ||
    !isOptionalText(request.runtime, MAX_SHORT_FIELD_CHARS) ||
    !isOptionalText(request.provider, MAX_SHORT_FIELD_CHARS) ||
    !isOptionalText(request.model, MAX_SHORT_FIELD_CHARS)
  ) {
    return null;
  }
  const changes: AgentManagementUpdateChanges = {
    ...(request.displayName !== undefined
      ? { displayName: request.displayName as string }
      : {}),
    ...(request.systemPrompt !== undefined
      ? { systemPrompt: request.systemPrompt as string }
      : {}),
    ...(request.runtime !== undefined
      ? { runtime: request.runtime as string }
      : {}),
    ...(request.provider !== undefined
      ? { provider: request.provider as string }
      : {}),
    ...(request.model !== undefined ? { model: request.model as string } : {}),
    ...(request.respondTo ? { respondTo: request.respondTo } : {}),
  };
  return Object.keys(changes).length === 0 ? null : changes;
}

/**
 * Parses the no-secret agent-management request contract. Unknown fields
 * reject the whole request so nothing credential-shaped can ride along.
 */
export function parseAgentManagementRequest(
  value: unknown,
): AgentManagementRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const payload = value as Record<string, unknown>;
  if (
    payload.type !== AGENT_MANAGEMENT_REQUEST ||
    !isText(payload.requestId, MAX_SHORT_FIELD_CHARS) ||
    (payload.review !== undefined && typeof payload.review !== "boolean") ||
    typeof payload.request !== "object" ||
    payload.request === null
  ) {
    return null;
  }
  const request = payload.request as Record<string, unknown>;
  if (!isText(request.channelId, MAX_SHORT_FIELD_CHARS)) return null;
  const common = {
    type: AGENT_MANAGEMENT_REQUEST,
    requestId: payload.requestId,
    ...(payload.review === true ? { review: true } : {}),
  } as const;

  if (payload.action === "create") {
    if (
      !hasOnlyKeys(request, CREATE_KEYS) ||
      !isText(request.displayName, MAX_AGENT_NAME_CHARS) ||
      !isText(request.systemPrompt, MAX_SYSTEM_PROMPT_CHARS) ||
      !isOptionalText(request.runtime, MAX_SHORT_FIELD_CHARS) ||
      !isOptionalText(request.provider, MAX_SHORT_FIELD_CHARS) ||
      !isOptionalText(request.model, MAX_SHORT_FIELD_CHARS) ||
      !isRespondTo(request.respondTo) ||
      !isOptionalParallelism(request.parallelism) ||
      !isOptionalText(request.avatarUrl, MAX_AVATAR_URL_CHARS) ||
      (request.start !== undefined && typeof request.start !== "boolean")
    ) {
      return null;
    }
    return {
      ...common,
      action: "create",
      request: {
        channelId: request.channelId,
        displayName: request.displayName,
        systemPrompt: request.systemPrompt,
        ...(request.runtime !== undefined
          ? { runtime: request.runtime as string }
          : {}),
        ...(request.provider !== undefined
          ? { provider: request.provider as string }
          : {}),
        ...(request.model !== undefined
          ? { model: request.model as string }
          : {}),
        ...(request.respondTo ? { respondTo: request.respondTo } : {}),
        ...(request.parallelism !== undefined
          ? { parallelism: request.parallelism }
          : {}),
        ...(request.avatarUrl !== undefined
          ? { avatarUrl: request.avatarUrl as string }
          : {}),
        ...(request.start !== undefined
          ? { start: request.start as boolean }
          : {}),
      },
    };
  }

  if (payload.action === "update") {
    if (!hasOnlyKeys(request, UPDATE_KEYS)) return null;
    const target = parseTarget(request);
    const changes = parseUpdateChanges(request);
    if (!target || !changes) return null;
    return {
      ...common,
      action: "update",
      request: { channelId: request.channelId, ...target, ...changes },
    };
  }

  if (payload.action === "delete") {
    if (!hasOnlyKeys(request, DELETE_KEYS)) return null;
    const target = parseTarget(request);
    if (!target) return null;
    return {
      ...common,
      action: "delete",
      request: { channelId: request.channelId, ...target },
    };
  }

  return null;
}

export function requestTargetsEditablePersona(
  persona: AgentPersona | undefined,
): persona is AgentPersona {
  return Boolean(persona && !persona.sourceTeam);
}

export function createInputFromRequest(
  request: AgentManagementCreateRequest,
): CreatePersonaInput {
  const fields = request.request;
  const behavior =
    fields.respondTo || fields.parallelism !== undefined
      ? {
          behavior: {
            ...(fields.respondTo ? { respondTo: fields.respondTo } : {}),
            ...(fields.parallelism !== undefined
              ? { parallelism: fields.parallelism }
              : {}),
          },
        }
      : {};
  return {
    displayName: fields.displayName,
    systemPrompt: fields.systemPrompt,
    ...(fields.runtime ? { runtime: fields.runtime } : {}),
    ...(fields.provider ? { provider: fields.provider } : {}),
    ...(fields.model ? { model: fields.model } : {}),
    ...(fields.avatarUrl ? { avatarUrl: fields.avatarUrl } : {}),
    ...behavior,
  };
}

export function updateInputFromRequest(
  request: AgentManagementUpdateRequest,
  current: UpdatePersonaInput,
): UpdatePersonaInput {
  const changes = request.request;
  return {
    ...current,
    displayName: changes.displayName ?? current.displayName,
    systemPrompt: changes.systemPrompt ?? current.systemPrompt,
    runtime: changes.runtime ?? current.runtime,
    provider: changes.provider ?? current.provider,
    model: changes.model ?? current.model,
    ...(changes.respondTo
      ? {
          behavior: {
            respondTo: changes.respondTo,
            respondToAllowlist: [],
            parallelism: current.behavior?.parallelism,
          },
        }
      : {}),
  };
}

export type AgentTargetResolution =
  | { ok: true; agent: ManagedAgent }
  | { ok: false; error: string };

/** Resolve a request target against the owner's managed agents. */
export function resolveAgentTarget(
  agents: readonly ManagedAgent[] | undefined,
  target: AgentTarget,
): AgentTargetResolution {
  if (target.agentPubkey !== undefined) {
    const wanted = target.agentPubkey.toLowerCase();
    const agent = (agents ?? []).find(
      (candidate) => candidate.pubkey.toLowerCase() === wanted,
    );
    return agent
      ? { ok: true, agent }
      : { ok: false, error: "No agent you own has that pubkey." };
  }
  const wanted = target.agentName.trim().toLocaleLowerCase();
  const matches = (agents ?? []).filter(
    (candidate) => candidate.name.trim().toLocaleLowerCase() === wanted,
  );
  if (matches.length === 1) return { ok: true, agent: matches[0] };
  if (matches.length > 1) {
    return {
      ok: false,
      error:
        "More than one of your agents has that name. Target it by pubkey instead.",
    };
  }
  return { ok: false, error: "No agent you own has that name." };
}

export function buildAgentManagementResult(
  request: Pick<AgentManagementRequest, "requestId" | "action">,
  status: AgentManagementStatus,
  details: Omit<
    AgentManagementResult,
    "type" | "requestId" | "action" | "status"
  > = {},
): AgentManagementResult {
  return {
    type: AGENT_MANAGEMENT_RESULT,
    requestId: request.requestId,
    action: request.action,
    status,
    ...details,
  };
}
