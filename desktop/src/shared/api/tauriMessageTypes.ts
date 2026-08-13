import type { RelayEvent } from "@/shared/api/types";

export type RawThreadRepliesResponse = {
  events: RelayEvent[];
  has_more: boolean;
  next_cursor: { created_at: number; event_id: string } | null;
};

export type RawSendChannelMessageResult = {
  event_id: string;
  parent_event_id: string | null;
  root_event_id: string | null;
  depth: number;
  created_at: number;
};
