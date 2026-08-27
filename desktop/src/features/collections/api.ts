import { invoke } from "@tauri-apps/api/core";

import type {
  Collection,
  CollectionMember,
  CollectionReference,
  CollectionScope,
  CollectionWithMembers,
} from "./types";
import type {
  CollectionCalendarActivityResponse,
  CollectionDiscoveredLink,
  CollectionGithubPullRequest,
} from "./derivedLinks";

export function listCollections(scope: CollectionScope): Promise<Collection[]> {
  return invoke("list_collections", {
    relayUrl: scope.relayUrl,
    ownerPubkey: scope.ownerPubkey,
  });
}

export function resolveCollectionGithubPullRequest(
  url: string,
): Promise<CollectionGithubPullRequest> {
  return invoke("resolve_collection_github_pull_request", { url });
}

export function getCollection(
  scope: CollectionScope,
  id: string,
): Promise<CollectionWithMembers> {
  return invoke("get_collection", {
    relayUrl: scope.relayUrl,
    ownerPubkey: scope.ownerPubkey,
    id,
  });
}

export function createCollection(
  scope: CollectionScope,
  name: string,
  icon: string | null,
): Promise<Collection> {
  return invoke("create_collection", {
    input: {
      relay_url: scope.relayUrl,
      owner_pubkey: scope.ownerPubkey,
      name,
      description: null,
      icon,
    },
  });
}

export function setCollectionIcon(
  scope: CollectionScope,
  collectionId: string,
  icon: string | null,
): Promise<Collection> {
  return invoke("set_collection_icon", {
    input: {
      relay_url: scope.relayUrl,
      owner_pubkey: scope.ownerPubkey,
      collection_id: collectionId,
      icon,
    },
  });
}

export function setCollectionName(
  scope: CollectionScope,
  collectionId: string,
  name: string,
): Promise<Collection> {
  return invoke("set_collection_name", {
    input: {
      relay_url: scope.relayUrl,
      owner_pubkey: scope.ownerPubkey,
      collection_id: collectionId,
      name,
    },
  });
}

export function deleteCollection(
  scope: CollectionScope,
  id: string,
): Promise<void> {
  return invoke("delete_collection", {
    relayUrl: scope.relayUrl,
    ownerPubkey: scope.ownerPubkey,
    id,
  });
}

export function addCollectionMember(
  scope: CollectionScope,
  input: {
    collectionId: string;
    reference: CollectionReference;
    label?: string | null;
  },
): Promise<CollectionMember> {
  return invoke("add_collection_member", {
    input: {
      relay_url: scope.relayUrl,
      owner_pubkey: scope.ownerPubkey,
      collection_id: input.collectionId,
      reference: input.reference,
      label: input.label ?? null,
    },
  });
}

export function removeCollectionMember(
  scope: CollectionScope,
  collectionId: string,
  memberId: string,
): Promise<void> {
  return invoke("remove_collection_member", {
    relayUrl: scope.relayUrl,
    ownerPubkey: scope.ownerPubkey,
    collectionId,
    memberId,
  });
}

export function discoverCollectionCalendarLinks(
  url: string,
): Promise<CollectionDiscoveredLink[]> {
  return invoke("discover_collection_calendar_links", { url });
}

export function discoverCollectionCalendarActivity(
  calendarUrl: string,
  startTime: string,
  endTime?: string | null,
): Promise<CollectionCalendarActivityResponse> {
  return invoke("discover_collection_calendar_activity", {
    calendarUrl,
    startTime,
    endTime: endTime ?? null,
  });
}
