import { isProjectInboxItem } from "@/features/home/lib/projectInbox";
import type { InboxItem } from "@/features/home/lib/inbox";

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
