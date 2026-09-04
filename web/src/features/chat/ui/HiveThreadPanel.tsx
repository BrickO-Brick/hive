import { MessageSquareText, X } from "lucide-react";
import type { NostrEvent } from "@/shared/lib/nostr-client";
import { BrickOPet } from "./BrickOPet";
import type {
  HiveParticipant,
  ParticipantProfile,
} from "./useHiveParticipantDirectory";
import {
  participantInitials,
  participantPresentation,
} from "./useHiveParticipantDirectory";

function isThreadMessage(message: NostrEvent): boolean {
  return message.tags.some(
    (tag) => tag[0] === "e" && (tag[3] === "root" || tag[3] === "reply"),
  );
}

export function HiveHeaderCollaboration({
  onThreads,
  participants,
  threadCount,
}: {
  onThreads: () => void;
  participants: HiveParticipant[];
  threadCount: number;
}) {
  const visible = participants.slice(0, 4);
  return (
    <div className="hidden items-center gap-3 md:flex">
      <div className="flex -space-x-2" title="Conversation members">
        {visible.map((participant) =>
          participant.isAgent ? (
            <span
              key={participant.pubkey}
              className="grid size-8 place-items-center rounded-full border-2 border-white bg-[#FFF1EB]"
              title={participant.displayName}
            >
              <BrickOPet mode="still" size="sm" />
            </span>
          ) : (
            <span
              key={participant.pubkey}
              className="grid size-8 place-items-center rounded-full border-2 border-white bg-[#10213F] text-[9px] font-extrabold text-white"
              title={participant.displayName}
            >
              {participantInitials(participant.displayName)}
            </span>
          ),
        )}
      </div>
      <button
        type="button"
        onClick={onThreads}
        className="flex h-9 items-center gap-2 rounded-md border border-[#D8DEE8] px-3 text-xs font-bold text-[#42526B] transition hover:border-[#BFD4FF] hover:bg-[#EEF5FF] hover:text-[#1F55C5]"
        aria-label="Open threads"
      >
        <MessageSquareText size={15} /> Threads
        {threadCount > 0 && (
          <span className="rounded-full bg-[#EEF5FF] px-1.5 py-0.5 text-[10px] text-[#1F55C5]">
            {threadCount}
          </span>
        )}
      </button>
    </div>
  );
}

export function HiveThreadPanel({
  agentPubkey,
  identityPubkey,
  messages,
  onClose,
  onReply,
  profiles,
}: {
  agentPubkey: string | null;
  identityPubkey: string;
  messages: NostrEvent[];
  onClose: () => void;
  onReply: (message: NostrEvent) => void;
  profiles: Record<string, ParticipantProfile>;
}) {
  const threadMessages = messages.filter(isThreadMessage);
  return (
    <aside className="hidden w-80 shrink-0 flex-col border-l border-[#D8DEE8] bg-white xl:flex">
      <div className="flex h-14 items-center justify-between border-b border-[#D8DEE8] px-4">
        <div>
          <h2 className="text-sm font-bold text-[#10233F]">Threads</h2>
          <p className="text-[10px] text-[#607086]">
            Replies in this conversation
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="grid size-8 place-items-center rounded-md text-[#607086] hover:bg-[#F1F5FA]"
          aria-label="Close threads"
        >
          <X size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {threadMessages.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#C7D2E3] bg-[#F9FBFD] px-4 py-8 text-center">
            <MessageSquareText className="mx-auto text-[#8491A4]" size={22} />
            <p className="mt-2 text-xs font-bold text-[#42526B]">
              No replies yet
            </p>
            <p className="mt-1 text-[11px] leading-5 text-[#607086]">
              Use Reply in this thread below a message to keep details focused.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {threadMessages.map((message) => {
              const { authorLabel, fromBrickO } = participantPresentation(
                message.pubkey,
                identityPubkey,
                agentPubkey,
                profiles,
              );
              return (
                <article
                  key={message.id}
                  className="rounded-lg border border-[#D8DEE8] bg-[#F9FBFD] p-3"
                >
                  <div className="flex items-center gap-2 text-xs font-bold text-[#10233F]">
                    {fromBrickO ? (
                      <BrickOPet mode="still" size="sm" />
                    ) : (
                      <span className="grid size-7 place-items-center rounded-full bg-[#10213F] text-[9px] text-white">
                        {participantInitials(authorLabel)}
                      </span>
                    )}
                    {authorLabel}
                  </div>
                  <p className="mt-2 line-clamp-4 text-xs leading-5 text-[#42526B]">
                    {message.content}
                  </p>
                  <button
                    type="button"
                    onClick={() => onReply(message)}
                    className="mt-2 text-[11px] font-bold text-[#1F55C5] hover:underline"
                  >
                    Reply in thread
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
