import type { ProjectChannelRequest } from "@/features/projects/projectChannelRequest";

export type AcceptedProjectChannelRequest = {
  agentPubkey: string;
  request: ProjectChannelRequest;
};

export type ProjectChannelRequestQueue = {
  activeRequestId: string | null;
  pending: AcceptedProjectChannelRequest[];
  seenRequestIds: Set<string>;
};

export function createProjectChannelRequestQueue(): ProjectChannelRequestQueue {
  return {
    activeRequestId: null,
    pending: [],
    seenRequestIds: new Set(),
  };
}

export function enqueueProjectChannelRequest(
  queue: ProjectChannelRequestQueue,
  candidate: AcceptedProjectChannelRequest,
): AcceptedProjectChannelRequest | null {
  const requestId = candidate.request.requestId;
  if (queue.seenRequestIds.has(requestId)) return null;
  queue.seenRequestIds.add(requestId);

  if (queue.activeRequestId === null) {
    queue.activeRequestId = requestId;
    return candidate;
  }

  queue.pending.push(candidate);
  return null;
}

export function advanceProjectChannelRequestQueue(
  queue: ProjectChannelRequestQueue,
): AcceptedProjectChannelRequest | null {
  const next = queue.pending.shift() ?? null;
  queue.activeRequestId = next?.request.requestId ?? null;
  return next;
}
