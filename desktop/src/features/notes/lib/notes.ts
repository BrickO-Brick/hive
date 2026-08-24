import type { LongFormNote } from "@/shared/api/socialTypes";

export function longFormNoteCoordinate(author: string, slug: string): string {
  return `30023:${author.trim().toLowerCase()}:${slug}`;
}

export function plainTextExcerpt(note: LongFormNote): string {
  const source = note.summary || note.content;
  return source
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function noteDisplayTimestamp(note: LongFormNote): number {
  return note.updatedAt ?? note.publishedAt ?? note.createdAt;
}
