import { CheckCircle2, Reply } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { NostrEvent } from "@/shared/lib/nostr-client";
import { BrickOPet } from "./BrickOPet";
import { participantInitials } from "./useHiveParticipantDirectory";

type Props = {
  authorLabel: string;
  day: string;
  fromBrickO: boolean;
  message: NostrEvent;
  mine: boolean;
  onReply?: () => void;
  showDay: boolean;
};

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
}

export function HiveMessage({
  authorLabel,
  day,
  fromBrickO,
  message,
  mine,
  onReply,
  showDay,
}: Props) {
  return (
    <div>
      {showDay && (
        <div className="my-6 flex items-center gap-3">
          <div className="h-px flex-1 bg-[#D8DEE8]" />
          <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#607086]">
            {day}
          </span>
          <div className="h-px flex-1 bg-[#D8DEE8]" />
        </div>
      )}
      <article
        aria-label={`Message from ${authorLabel}`}
        className={`mb-5 flex items-end gap-2.5 ${mine ? "justify-end" : "justify-start"}`}
      >
        {!mine &&
          (fromBrickO ? (
            <BrickOPet mode="still" size="sm" />
          ) : (
            <div
              aria-hidden="true"
              className="grid size-8 shrink-0 place-items-center rounded-full bg-[#DDE7F5] text-[10px] font-extrabold text-[#27476F]"
            >
              {participantInitials(authorLabel)}
            </div>
          ))}
        <div
          className={`max-w-[86%] sm:max-w-[78%] ${mine ? "items-end" : "items-start"}`}
        >
          <div
            className={`mb-1.5 flex items-center gap-2 px-1 ${mine ? "justify-end" : "justify-start"}`}
          >
            <span className="text-[11px] font-bold text-[#42526B]">
              {authorLabel}
            </span>
            <time className="text-[10px] text-[#607086]">
              {formatTime(message.created_at)}
            </time>
          </div>
          <div
            className={`rounded px-4 py-3 text-sm leading-6 shadow-sm ${
              mine
                ? "border border-[#F2B09F] bg-[#FFF0EB] text-[#44201A] shadow-[#FF6F52]/10"
                : "border border-[#D8DEE8] bg-white text-[#172033]"
            }`}
          >
            <div
              className={`prose prose-sm max-w-none break-words prose-p:my-0 prose-p:leading-6 prose-pre:bg-[#10213F] prose-pre:text-white ${mine ? "prose-a:text-[#9D321F]" : "prose-a:text-[#E35E43]"}`}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content}
              </ReactMarkdown>
            </div>
          </div>
          {mine && (
            <div className="mt-1 flex items-center justify-end gap-1 px-1 text-[10px] text-[#607086]">
              <CheckCircle2 size={10} /> Sent
            </div>
          )}
          {onReply && (
            <button
              type="button"
              className="mt-1 flex items-center gap-1 px-1 text-[10px] font-bold text-[#526178] hover:text-[#1F55C5]"
              onClick={onReply}
              aria-label={`Reply to ${mine ? "your message" : authorLabel}`}
            >
              <Reply size={10} /> Reply in this thread
            </button>
          )}
        </div>
      </article>
    </div>
  );
}
