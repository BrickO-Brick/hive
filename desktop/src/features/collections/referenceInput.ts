import { parseAddressableCoordinate } from "@/shared/lib/addressableCoordinate";
import { KIND_REPO_ANNOUNCEMENT } from "@/shared/constants/kinds";

import type { CollectionReference } from "./types";

export type AddableCollectionReferenceType =
  | "external"
  | "repository"
  | "task"
  | "note";

type ReferenceInput = {
  coordinate: string;
  eventId: string;
  type: AddableCollectionReferenceType;
  url: string;
};

export type ReferenceInputResult =
  | { ok: true; reference: CollectionReference }
  | { ok: false; message: string };

const EVENT_ID_PATTERN = /^[a-fA-F0-9]{64}$/;

export function parseCollectionReferenceInput({
  coordinate,
  eventId,
  type,
  url,
}: ReferenceInput): ReferenceInputResult {
  if (type === "external") {
    try {
      return {
        ok: true,
        reference: { type, url: new URL(url.trim()).toString() },
      };
    } catch {
      return { ok: false, message: "Enter a valid URL" };
    }
  }

  const normalizedCoordinate = coordinate.trim();
  const parsed = parseAddressableCoordinate(normalizedCoordinate);
  if (!parsed) {
    return {
      ok: false,
      message: "Enter a coordinate as kind:owner-pubkey:identifier",
    };
  }

  if (type === "note") {
    return {
      ok: true,
      reference: { type, coordinate: normalizedCoordinate },
    };
  }

  if (parsed.kind !== KIND_REPO_ANNOUNCEMENT) {
    return {
      ok: false,
      message: `Repository coordinates must start with ${KIND_REPO_ANNOUNCEMENT}:`,
    };
  }
  if (type === "repository") {
    return {
      ok: true,
      reference: { type, coordinate: normalizedCoordinate },
    };
  }

  const normalizedEventId = eventId.trim().toLowerCase();
  if (!EVENT_ID_PATTERN.test(normalizedEventId)) {
    return { ok: false, message: "Enter a 64-character task event ID" };
  }
  return {
    ok: true,
    reference: {
      type,
      event_id: normalizedEventId,
      repository: normalizedCoordinate,
    },
  };
}
