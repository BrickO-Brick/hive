import { useQuery } from "@tanstack/react-query";

import { getLongFormNote, listLongFormNotes } from "@/shared/api/social";

export const longFormNotesQueryKeys = {
  list: ["long-form-notes"] as const,
  detail: (author: string, slug: string) =>
    ["long-form-note", author.toLowerCase(), slug] as const,
};

export function useLongFormNotesQuery() {
  return useQuery({
    queryKey: longFormNotesQueryKeys.list,
    queryFn: () => listLongFormNotes({ limit: 50 }),
    staleTime: 30_000,
  });
}

export function useLongFormNoteQuery(author?: string, slug?: string) {
  return useQuery({
    queryKey: longFormNotesQueryKeys.detail(author ?? "", slug ?? ""),
    queryFn: () => getLongFormNote(author ?? "", slug ?? ""),
    enabled: Boolean(author && slug),
    staleTime: 30_000,
  });
}
