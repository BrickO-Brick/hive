export type CollectionReference =
  | { type: "channel"; channel_id: string }
  | { type: "repository"; coordinate: string }
  | { type: "task"; event_id: string; repository: string }
  | { type: "thread"; channel_id: string; root_event_id: string }
  | { type: "message"; channel_id: string; event_id: string }
  | { type: "note"; coordinate: string }
  | { type: "external"; url: string };

export type Collection = {
  id: string;
  relay_url: string;
  owner_pubkey: string;
  name: string;
  description: string | null;
  icon: string | null;
  created_at: string;
  updated_at: string;
};

export type CollectionMember = {
  id: string;
  collection_id: string;
  reference: CollectionReference;
  label: string | null;
  added_at: string;
};

export type CollectionWithMembers = {
  collection: Collection;
  members: CollectionMember[];
};

export type CollectionScope = {
  relayUrl: string;
  ownerPubkey: string;
};

export type CollectionReferenceType = CollectionReference["type"];
