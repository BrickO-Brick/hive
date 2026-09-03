const CONVERSATION_STORAGE_PREFIX = "buzz.projects.agentConversation";
const GIT_WORKSPACE_STORAGE_PREFIX = "buzz.projects.gitWorkspace";

/** Builds the identity boundary for Projects conversation pointers and drafts. */
export function projectsConversationScope(
  surface: string,
  relayUrl: string | null,
  signerPubkey: string | null,
  resource: string,
): string | null {
  if (!relayUrl || !signerPubkey || !resource) return null;
  return `${surface}:${relayUrl}:${signerPubkey.toLowerCase()}:${resource}`;
}

/**
 * The exact opening prompt of an inline Projects conversation, identified by
 * the signed event the relay accepted. `createdAt` alone (epoch seconds)
 * cannot isolate the conversation — every unrelated event sharing the
 * opener's second would pass a timestamp cutoff — so the event id
 * participates in the same `(created_at, event_id)` ordering the message
 * timeline uses.
 */
export type ProjectsConversationOpener = {
  createdAt: number;
  eventId: string;
};

/**
 * Minimal workspace-scoped pointer to the last inline Projects conversation.
 * `opener` anchors the thread to the first Projects prompt — messages the
 * reused DM channel held before that event must never render on the
 * Projects page.
 */
export type StoredProjectsAgentConversation = {
  agentPubkey: string;
  channelId: string;
  opener: ProjectsConversationOpener;
  workspaceId?: string;
};

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** Creates the durable Git boundary for one repository discussion lifecycle. */
export function createProjectsWorkspaceId(): string {
  return globalThis.crypto.randomUUID();
}

/** Restores the Git workspace before a conversation opener exists. */
export function readStoredProjectsWorkspaceId(
  conversationScope: string | null,
): string | null {
  if (!conversationScope) return null;
  try {
    const value = globalThis.localStorage?.getItem(
      scopedKey(GIT_WORKSPACE_STORAGE_PREFIX, conversationScope),
    );
    return value && WORKSPACE_ID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** Persists the discussion-to-worktree binding independently of chat history. */
export function writeStoredProjectsWorkspaceId(
  conversationScope: string | null,
  workspaceId: string,
) {
  if (!conversationScope || !WORKSPACE_ID_PATTERN.test(workspaceId)) return;
  try {
    globalThis.localStorage?.setItem(
      scopedKey(GIT_WORKSPACE_STORAGE_PREFIX, conversationScope),
      workspaceId,
    );
  } catch {
    // Persistence is best-effort; the in-memory workspace remains usable.
  }
}

function scopedKey(prefix: string, workspaceId: string) {
  return `${prefix}.${encodeURIComponent(workspaceId)}`;
}

function isValidOpener(value: unknown): value is ProjectsConversationOpener {
  if (!value || typeof value !== "object") return false;
  const opener = value as Partial<ProjectsConversationOpener>;
  return (
    typeof opener.eventId === "string" &&
    opener.eventId.length > 0 &&
    typeof opener.createdAt === "number" &&
    Number.isFinite(opener.createdAt) &&
    opener.createdAt > 0
  );
}

/** Reads the last inline Projects conversation without persisting its content. */
export function readStoredProjectsAgentConversation(
  workspaceId: string | null,
): StoredProjectsAgentConversation | null {
  if (!workspaceId) return null;
  try {
    const raw = globalThis.localStorage?.getItem(
      scopedKey(CONVERSATION_STORAGE_PREFIX, workspaceId),
    );
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredProjectsAgentConversation>;
    if (
      typeof value.agentPubkey !== "string" ||
      value.agentPubkey.length === 0 ||
      typeof value.channelId !== "string" ||
      value.channelId.length === 0 ||
      // Legacy pointers carried only a timestamp cutoff. They cannot uphold
      // the isolation invariant (same-second history would leak), so they
      // are not restorable.
      !isValidOpener(value.opener)
    ) {
      return null;
    }
    return {
      agentPubkey: value.agentPubkey,
      channelId: value.channelId,
      opener: {
        createdAt: value.opener.createdAt,
        eventId: value.opener.eventId,
      },
      ...(typeof value.workspaceId === "string" &&
      WORKSPACE_ID_PATTERN.test(value.workspaceId)
        ? { workspaceId: value.workspaceId }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Saves only the channel pointer needed to restore the Projects conversation. */
export function writeStoredProjectsAgentConversation(
  workspaceId: string | null,
  conversation: StoredProjectsAgentConversation,
) {
  if (!workspaceId) return;
  try {
    globalThis.localStorage?.setItem(
      scopedKey(CONVERSATION_STORAGE_PREFIX, workspaceId),
      JSON.stringify(conversation),
    );
  } catch {
    // Persistence is best-effort; the in-memory conversation remains usable.
  }
}

/** Deletes the saved pointer so no prior conversation is restored. */
export function clearStoredProjectsAgentConversation(
  workspaceId: string | null,
) {
  if (!workspaceId) return;
  try {
    globalThis.localStorage?.removeItem(
      scopedKey(CONVERSATION_STORAGE_PREFIX, workspaceId),
    );
  } catch {
    // Persistence is best-effort; the current page still clears immediately.
  }
}
