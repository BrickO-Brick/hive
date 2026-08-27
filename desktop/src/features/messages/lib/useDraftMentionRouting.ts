import * as React from "react";

import type { DraftMentionRef } from "./useDrafts";
import {
  collectOccurrenceManagedNames,
  isOccurrenceManagedName,
  restoreMentionIdentityRefs,
  snapshotMentionIdentityRefs,
  type MentionIdentityRef,
} from "./mentionIdentityRefs";

import { trimMapToSize } from "@/shared/lib/trimMapToSize";
import {
  replaceWithDraftMentionRefs,
  snapshotDraftMentionRefs,
} from "./draftMentionRefs";

export function useDraftMentionRouting(params: {
  mentionMapRef: React.MutableRefObject<Map<string, string>>;
  mentionIdentityRefsRef: React.MutableRefObject<MentionIdentityRef[]>;
  occurrenceManagedNamesRef: React.MutableRefObject<Set<string>>;
  mentionTextRef: React.MutableRefObject<string>;
  personaMentionMapRef: React.MutableRefObject<Map<string, string>>;
  selectedAgentNamesRef: React.MutableRefObject<string[]>;
  cancelAutocomplete: () => void;
  setSelectedNames: (names: string[]) => void;
  setSelectedAgentNames: (names: string[]) => void;
}): {
  getDraftMentionRefs: (content: string) => DraftMentionRef[];
  restoreDraftMentionRefs: (
    refs: readonly DraftMentionRef[],
    content?: string,
  ) => void;
} {
  const getDraftMentionRefs = React.useCallback(
    (content: string) => {
      const occurrenceRefs = snapshotMentionIdentityRefs(
        params.mentionIdentityRefsRef.current,
      );
      const occurrencePubkeys = new Set(
        occurrenceRefs.map((ref) => ref.pubkey.toLowerCase()),
      );
      const occurrenceNames = new Set([
        ...params.occurrenceManagedNamesRef.current,
        ...occurrenceRefs.map((ref) => ref.displayName.trim().toLowerCase()),
      ]);
      return [
        ...occurrenceRefs,
        ...snapshotDraftMentionRefs(
          content,
          params.mentionMapRef.current,
          params.selectedAgentNamesRef.current,
        ).filter(
          (ref) =>
            !occurrencePubkeys.has(ref.pubkey.toLowerCase()) &&
            !isOccurrenceManagedName(ref.displayName, occurrenceNames),
        ),
      ];
    },
    [
      params.mentionIdentityRefsRef,
      params.mentionMapRef,
      params.occurrenceManagedNamesRef,
      params.selectedAgentNamesRef,
    ],
  );
  const restoreDraftMentionRefs = React.useCallback(
    (refs: readonly DraftMentionRef[], content?: string) => {
      params.cancelAutocomplete();
      if (refs.length === 0 && content === undefined) {
        params.mentionTextRef.current = "";
      } else if (content !== undefined) {
        params.mentionTextRef.current = content;
      }
      params.occurrenceManagedNamesRef.current =
        collectOccurrenceManagedNames(refs);
      params.mentionIdentityRefsRef.current = restoreMentionIdentityRefs(
        params.mentionTextRef.current,
        refs,
      ).map(({ id: _id, ...ref }) => ref);
      const { names, agentNames } = replaceWithDraftMentionRefs(
        refs,
        params.mentionMapRef.current,
        params.personaMentionMapRef.current,
      );
      trimMapToSize(params.mentionMapRef.current, 200);
      params.selectedAgentNamesRef.current = agentNames;
      params.setSelectedNames(names);
      params.setSelectedAgentNames(agentNames);
    },
    [params],
  );
  return { getDraftMentionRefs, restoreDraftMentionRefs };
}
