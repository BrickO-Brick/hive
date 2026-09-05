import type { NostrSubscriptionState } from "@/shared/lib/nostr-client";
import type { BrickOCelebration, BrickOPetMode } from "./BrickOPet";
import type { HivePresence } from "./hiveMessageUtils";

export function deriveBrickOStatus({
  celebration,
  connected,
  connection,
  presence,
  typing,
  waiting,
}: {
  celebration: BrickOCelebration | null;
  connected: boolean;
  connection: NostrSubscriptionState;
  presence: HivePresence;
  typing: boolean;
  waiting: boolean;
}) {
  const agentState = !connected
    ? {
        label: connection === "connecting" ? "Connecting…" : "Reconnecting…",
        detail: "Waiting for a secure connection to Hive",
        tone: "amber" as const,
      }
    : typing
      ? {
          label: "Writing a response…",
          detail: "BrickO is coding and composing a reply",
          tone: "violet" as const,
        }
      : waiting
        ? {
            label: "Preparing a response…",
            detail: "Your message was received and is being processed",
            tone: "violet" as const,
          }
        : presence === "online"
          ? {
              label: "Online and ready",
              detail: "BrickO is ready for the next instruction",
              tone: "emerald" as const,
            }
          : presence === "away"
            ? {
                label: "Idle",
                detail: "BrickO is still connected to the workspace",
                tone: "amber" as const,
              }
            : presence === "offline"
              ? {
                  label: "Offline",
                  detail: "Messages remain safely stored in the channel",
                  tone: "slate" as const,
                }
              : {
                  label: "Checking status…",
                  detail: "Hive connection is active",
                  tone: "slate" as const,
                };

  const toneClasses = {
    emerald: "bg-[#1FA971] shadow-[#1FA971]/30",
    violet: "animate-pulse bg-[#2F6FED] shadow-[#2F6FED]/30",
    amber: "bg-[#D9861C] shadow-[#D9861C]/30",
    slate: "bg-[#8491A4] shadow-[#8491A4]/30",
  }[agentState.tone];
  const petMode: BrickOPetMode =
    typing || waiting
      ? "thinking"
      : celebration
        ? "celebrate"
        : connected && presence !== "offline"
          ? "idle"
          : "offline";
  const petStatus = typing
    ? "BrickO is coding and composing a response…"
    : waiting
      ? "BrickO is thinking through the next step…"
      : celebration === "check"
        ? "Done — BrickO gives it the all-clear."
        : celebration === "code"
          ? "Done — BrickO wraps up the coding session."
          : celebration
            ? "Done — BrickO celebrates the result."
            : connected && presence === "online"
              ? "BrickO is ready to be your coding partner."
              : connected && presence === "away"
                ? "BrickO is connected but currently idle."
                : connected
                  ? "Chat is connected; waiting for BrickO to come online."
                  : "Chat is reconnecting. Your messages and draft remain safe.";

  return { agentState, petMode, petStatus, toneClasses };
}
