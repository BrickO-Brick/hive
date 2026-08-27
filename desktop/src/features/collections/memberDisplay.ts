import type {
  CollectionMember,
  CollectionReference,
  CollectionReferenceType,
} from "./types";

export const COLLECTION_REFERENCE_TYPES: CollectionReferenceType[] = [
  "channel",
  "repository",
  "task",
  "thread",
  "message",
  "note",
  "external",
];

export function collectionReferenceIdentity(
  reference: CollectionReference,
): string {
  switch (reference.type) {
    case "channel":
      return reference.channel_id;
    case "repository":
    case "note":
      return reference.coordinate;
    case "task":
      return `${reference.repository} · ${reference.event_id}`;
    case "thread":
      return `${reference.channel_id} · ${reference.root_event_id}`;
    case "message":
      return `${reference.channel_id} · ${reference.event_id}`;
    case "external":
      return reference.url;
  }
}

export function collectionMemberMatches(
  member: CollectionMember,
  search: string,
  type: CollectionReferenceType | "all",
): boolean {
  if (type !== "all" && member.reference.type !== type) return false;
  const query = search.trim().toLocaleLowerCase();
  if (!query) return true;
  return `${member.label ?? ""} ${collectionReferenceIdentity(member.reference)}`
    .toLocaleLowerCase()
    .includes(query);
}
