import { useQuery } from "@tanstack/react-query";

import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

export type OneBrickParticipant = {
  pubkey: string;
  displayName: string | null;
  role: string;
};

async function fetchParticipants(
  channelId: string,
): Promise<OneBrickParticipant[]> {
  const url = `${relayHttpBaseUrl().replace(/\/+$/, "")}/api/onebrick/channels/${encodeURIComponent(channelId)}/participants`;
  const authorization = await makeNip98AuthHeader(url, "GET");
  const response = await fetch(url, {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    participants?: unknown;
  };
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `HTTP ${response.status}`,
    );
  }
  if (!Array.isArray(payload.participants)) {
    throw new Error("invalid_participant_directory_response");
  }
  const participants = payload.participants.filter(
    (participant): participant is OneBrickParticipant =>
      typeof participant === "object" &&
      participant !== null &&
      typeof (participant as OneBrickParticipant).pubkey === "string" &&
      (typeof (participant as OneBrickParticipant).displayName === "string" ||
        (participant as OneBrickParticipant).displayName === null) &&
      typeof (participant as OneBrickParticipant).role === "string",
  );
  if (participants.length !== payload.participants.length) {
    throw new Error("invalid_participant_directory_response");
  }
  return participants;
}

export function useOneBrickParticipants(channelId: string | null) {
  return useQuery({
    queryKey: ["onebrick-participants", channelId],
    queryFn: () => fetchParticipants(channelId ?? ""),
    enabled: Boolean(channelId),
    retry: false,
    staleTime: 60_000,
  });
}
