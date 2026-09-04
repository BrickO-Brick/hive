import type { NostrEvent } from "@/shared/lib/nostr-client";
import type { BrickOCelebration } from "./BrickOPet";

export type HivePresence = "online" | "away" | "offline" | "unknown";

export function celebrationForEvent(eventId: string): BrickOCelebration {
  const variants: BrickOCelebration[] = ["sparkle", "check", "code"];
  const fingerprint = [...eventId].reduce(
    (sum, character) => sum + character.charCodeAt(0),
    0,
  );
  return variants[fingerprint % variants.length] ?? "sparkle";
}

export function eventTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

export function formatMessageDay(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(timestamp * 1000));
}

export function normalizePresence(value: string): HivePresence {
  if (value === "online" || value === "away" || value === "offline") {
    return value;
  }
  return "unknown";
}

export function threadRootId(event: NostrEvent): string {
  return (
    event.tags.find((tag) => tag[0] === "e" && tag[3] === "root")?.[1] ??
    event.id
  );
}
