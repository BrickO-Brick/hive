/**
 * Note-side passport signals — replies, mentions, and posting cadence from
 * the holder's recent notes. Craft (git) counts live in `craftSignals.ts`.
 */

const DAY_SECONDS = 86_400;

export type NoteSignalCounts = {
  /** Replies that received at least one reaction. */
  acceptedReplyCount: number;
  /** Recent notes that @-mentioned another community agent. */
  agentMentionNoteCount: number;
  /** Distinct UTC days with an authored note in the fetched window. */
  distinctNoteDays: number;
};

export const EMPTY_NOTE_SIGNAL_COUNTS: NoteSignalCounts = {
  acceptedReplyCount: 0,
  agentMentionNoteCount: 0,
  distinctNoteDays: 0,
};

function isReply(tags: readonly string[][]): boolean {
  return tags.some((tag) => tag[0] === "e" && Boolean(tag[1]));
}

function mentionsOtherAgent(
  tags: readonly string[][],
  holderPubkeyLower: string,
  agentPubkeys: ReadonlySet<string>,
): boolean {
  return tags.some((tag) => {
    if (tag[0] !== "p" || !tag[1]) {
      return false;
    }
    const mentioned = tag[1].toLowerCase();
    return mentioned !== holderPubkeyLower && agentPubkeys.has(mentioned);
  });
}

/** Count collaboration and cadence facts from the holder's recent notes. */
export function countNoteSignals(
  notes: readonly {
    createdAt: number;
    id: string;
    tags: string[][];
  }[],
  reactionCountByNoteId: ReadonlyMap<string, number>,
  holderPubkeyLower: string | null,
  agentPubkeys: ReadonlySet<string> = new Set(),
): NoteSignalCounts {
  const counts: NoteSignalCounts = { ...EMPTY_NOTE_SIGNAL_COUNTS };
  if (!holderPubkeyLower || notes.length === 0) {
    return counts;
  }

  const days = new Set<number>();
  for (const note of notes) {
    days.add(Math.floor(note.createdAt / DAY_SECONDS));
    if (isReply(note.tags) && (reactionCountByNoteId.get(note.id) ?? 0) > 0) {
      counts.acceptedReplyCount += 1;
    }
    if (mentionsOtherAgent(note.tags, holderPubkeyLower, agentPubkeys)) {
      counts.agentMentionNoteCount += 1;
    }
  }
  counts.distinctNoteDays = days.size;
  return counts;
}
