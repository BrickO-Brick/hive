import { isProjectInboxItem } from "@/features/home/lib/projectInbox";
import type { InboxItem } from "@/features/home/lib/inbox";
import { summarizeMessageLinkContent } from "@/features/messages/lib/messageLinkMetadata";

export type BestieFeedFilter = "all" | "messages" | "tasks";

export type BestiePanelState =
  | { mode: "closed" }
  | { itemId: string; mode: "reply" | "chat" };

export type BestiePanelAction =
  | { itemId: string; type: "open-reply" | "open-chat" }
  | { type: "close" };

function categoryRank(item: InboxItem) {
  if (item.isActionRequired) return 4;
  if (item.categories.includes("mention")) return 3;
  if (item.categories.includes("agent_activity")) return 2;
  return 1;
}

export function sortBestieFeedItems(items: readonly InboxItem[]) {
  return [...items].sort(
    (left, right) =>
      categoryRank(right) - categoryRank(left) ||
      right.latestActivityAt - left.latestActivityAt ||
      left.id.localeCompare(right.id),
  );
}

export function filterBestieFeedItems(
  items: readonly InboxItem[],
  filter: BestieFeedFilter,
) {
  if (filter === "all") return [...items];
  if (filter === "messages") {
    return items.filter(
      (item) =>
        !item.isActionRequired &&
        !item.categories.includes("agent_activity") &&
        !isProjectInboxItem(item.item),
    );
  }
  return items.filter(
    (item) =>
      item.isActionRequired ||
      item.categories.includes("agent_activity") ||
      isProjectInboxItem(item.item),
  );
}

export function getVisibleBestieFeedItems(
  items: readonly InboxItem[],
  snoozedUntilById: Readonly<Record<string, number>>,
  now: number,
) {
  return items.filter((item) => (snoozedUntilById[item.id] ?? 0) <= now);
}

export function bestieItemSourceLabel(item: InboxItem) {
  return item.channelLabel ?? (item.item.channelName.trim() || "Buzz");
}

const BESTIE_SUMMARY_MAX_LENGTH = 96;

function truncateBestieSummary(value: string) {
  const characters = Array.from(value);
  if (characters.length <= BESTIE_SUMMARY_MAX_LENGTH) return value;

  const clipped = characters.slice(0, BESTIE_SUMMARY_MAX_LENGTH - 1).join("");
  const lastSpace = clipped.lastIndexOf(" ");
  const summary = lastSpace > 56 ? clipped.slice(0, lastSpace) : clipped;
  return `${summary.trimEnd()}…`;
}

/** Builds a concise extractive headline using only text from the Buzz item. */
export function bestieItemSummary(item: InboxItem) {
  if (isProjectInboxItem(item.item)) return item.subject;

  const latestContent = [...item.groupItems]
    .sort((left, right) => right.createdAt - left.createdAt)
    .find((event) => event.content.trim().length > 0)?.content;
  const normalized = summarizeMessageLinkContent(latestContent ?? item.preview)
    .replace(/^(?:agent progress|mention|reminder)\s*:\s*/i, "")
    .replace(/^@[\p{L}\p{N}._-]+[:,]?\s*/u, "")
    .trim();
  if (!normalized || normalized === "No message text") return item.subject;

  const sentenceEnd = normalized.search(/[.!?](?:\s|$)/);
  const firstSentence =
    sentenceEnd >= 0 ? normalized.slice(0, sentenceEnd + 1).trim() : normalized;
  const [firstCharacter = "", ...remainingCharacters] =
    Array.from(firstSentence);
  return truncateBestieSummary(
    `${firstCharacter.toLocaleUpperCase()}${remainingCharacters.join("")}`,
  );
}

export function reduceBestiePanelState(
  _state: BestiePanelState,
  action: BestiePanelAction,
): BestiePanelState {
  if (action.type === "close") return { mode: "closed" };
  return {
    itemId: action.itemId,
    mode: action.type === "open-reply" ? "reply" : "chat",
  };
}
