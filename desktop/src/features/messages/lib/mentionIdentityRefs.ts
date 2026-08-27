import { getMentionOffsets } from "./hasMention";
import type { DraftMentionRef } from "./useDrafts";

export type MentionTextChange = {
  oldFrom: number;
  oldTo: number;
  newFrom: number;
  newTo: number;
};

export type MentionIdentityRef = DraftMentionRef & {
  offset: number;
  /** Ephemeral selection token; never persisted with a draft/edit snapshot. */
  id?: string;
};

export function collectOccurrenceManagedNames(
  refs: readonly DraftMentionRef[],
): Set<string> {
  return new Set(
    refs.map((ref) => ref.displayName.trim().toLowerCase()).filter(Boolean),
  );
}

export function isOccurrenceManagedName(
  displayName: string | null | undefined,
  managedNames: ReadonlySet<string>,
): boolean {
  return Boolean(
    displayName && managedNames.has(displayName.trim().toLowerCase()),
  );
}

function inferSingleTextChange(
  previousText: string,
  nextText: string,
): MentionTextChange {
  let prefix = 0;
  const maxPrefix = Math.min(previousText.length, nextText.length);
  while (
    prefix < maxPrefix &&
    previousText.charCodeAt(prefix) === nextText.charCodeAt(prefix)
  ) {
    prefix += 1;
  }

  let suffix = 0;
  const maxSuffix = Math.min(
    previousText.length - prefix,
    nextText.length - prefix,
  );
  while (
    suffix < maxSuffix &&
    previousText.charCodeAt(previousText.length - 1 - suffix) ===
      nextText.charCodeAt(nextText.length - 1 - suffix)
  ) {
    suffix += 1;
  }

  return {
    oldFrom: prefix,
    oldTo: previousText.length - suffix,
    newFrom: prefix,
    newTo: nextText.length - suffix,
  };
}

function isMentionAt(text: string, ref: MentionIdentityRef): boolean {
  return getMentionOffsets(text, ref.displayName).includes(ref.offset);
}

function isValidChange(
  change: MentionTextChange,
  previousText: string,
  nextText: string,
): boolean {
  return (
    Number.isInteger(change.oldFrom) &&
    Number.isInteger(change.oldTo) &&
    Number.isInteger(change.newFrom) &&
    Number.isInteger(change.newTo) &&
    change.oldFrom >= 0 &&
    change.oldFrom <= change.oldTo &&
    change.oldTo <= previousText.length &&
    change.newFrom >= 0 &&
    change.newFrom <= change.newTo &&
    change.newTo <= nextText.length
  );
}

/**
 * Rebase occurrence-bound mention identities through one editor update.
 * An edit intersecting a token drops that identity; edits before it shift it.
 * A `null` change means the editor update could not be projected safely, so
 * only identities that remain at their exact offsets survive.
 */
export function reconcileMentionIdentityRefs(
  refs: readonly MentionIdentityRef[],
  previousText: string,
  nextText: string,
  suppliedChange?: MentionTextChange | null,
  allowedOverlappingIds: ReadonlySet<string> = new Set(),
): MentionIdentityRef[] {
  if (refs.length === 0) return [];
  if (previousText === nextText) return [...refs];
  if (suppliedChange === null) {
    return refs.filter((ref) => isMentionAt(nextText, ref));
  }

  const change =
    suppliedChange ?? inferSingleTextChange(previousText, nextText);
  if (!isValidChange(change, previousText, nextText)) return [];

  const oldRemovedLength = change.oldTo - change.oldFrom;
  const insertedLength = change.newTo - change.newFrom;
  const delta = insertedLength - oldRemovedLength;

  return refs
    .flatMap((ref) => {
      const tokenEnd = ref.offset + 1 + ref.displayName.length;
      let offset = ref.offset;

      if (oldRemovedLength === 0) {
        if (change.oldFrom <= ref.offset) {
          offset += delta;
        } else if (change.oldFrom < tokenEnd) {
          return [];
        }
      } else if (tokenEnd <= change.oldFrom) {
        // The mention is wholly before the replaced range.
      } else if (ref.offset >= change.oldTo) {
        offset += delta;
      } else if (
        !ref.id ||
        !allowedOverlappingIds.has(ref.id) ||
        !isMentionAt(nextText, ref)
      ) {
        return [];
      }

      const rebased = { ...ref, offset };
      return isMentionAt(nextText, rebased) ? [rebased] : [];
    })
    .sort((left, right) => left.offset - right.offset);
}

/** Restore persisted refs by assigning same-name identities to occurrences in order. */
export function restoreMentionIdentityRefs(
  text: string,
  refs: readonly DraftMentionRef[],
): MentionIdentityRef[] {
  const nextOffsetByName = new Map<string, number>();
  const offsetsByName = new Map<string, number[]>();
  const restored: MentionIdentityRef[] = [];

  for (const ref of refs) {
    const displayName = ref.displayName.trim();
    const pubkey = ref.pubkey.trim().toLowerCase();
    if (
      !displayName ||
      !pubkey ||
      (ref.offset !== undefined &&
        (!Number.isInteger(ref.offset) || ref.offset < 0))
    ) {
      continue;
    }

    const key = displayName.toLowerCase();
    const offsets =
      offsetsByName.get(key) ?? getMentionOffsets(text, displayName);
    offsetsByName.set(key, offsets);
    const persistedOffset = ref.offset;
    const offset =
      persistedOffset !== undefined
        ? offsets.includes(persistedOffset)
          ? persistedOffset
          : undefined
        : offsets[nextOffsetByName.get(key) ?? 0];
    if (offset === undefined) continue;

    nextOffsetByName.set(
      key,
      Math.max(nextOffsetByName.get(key) ?? 0, offsets.indexOf(offset) + 1),
    );
    restored.push({ ...ref, displayName, pubkey, offset });
  }

  return restored.sort((left, right) => left.offset - right.offset);
}

export function snapshotMentionIdentityRefs(
  refs: readonly MentionIdentityRef[],
): DraftMentionRef[] {
  return [...refs]
    .sort((left, right) => left.offset - right.offset)
    .map(({ displayName, pubkey, isAgent, offset }) => ({
      displayName,
      pubkey: pubkey.toLowerCase(),
      isAgent,
      offset,
    }));
}
