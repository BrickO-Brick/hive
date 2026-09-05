import { CheckCircle2, RotateCcw, Reply } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { NostrEvent } from "@/shared/lib/nostr-client";
import { agentFailureDisplayContent } from "./agentFailure";
import { BrickOPet } from "./BrickOPet";
import { participantInitials } from "./useHiveParticipantDirectory";

type Props = {
  authorLabel: string;
  day: string;
  fromBrickO: boolean;
  message: NostrEvent;
  mine: boolean;
  onReply?: () => void;
  onRestoreRequest?: () => void;
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
  onRestoreRequest,
  showDay,
}: Props) {
  const displayContent = fromBrickO
    ? agentFailureDisplayContent(message.content)
    : message.content;
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
        className="mb-4 flex items-end gap-2.5"
      >
        {fromBrickO ? (
          <BrickOPet mode="still" size="sm" />
        ) : mine ? (
          <div
            aria-hidden="true"
            className="grid size-8 shrink-0 place-items-center rounded-full bg-[#FFE0D7] text-[10px] font-extrabold text-[#9D321F]"
          >
            YOU
          </div>
        ) : (
          <div
            aria-hidden="true"
            className="grid size-8 shrink-0 place-items-center rounded-full bg-[#DDE7F5] text-[10px] font-extrabold text-[#27476F]"
          >
            {participantInitials(authorLabel)}
          </div>
        )}
        <div className="min-w-0 max-w-[52rem] flex-1">
          <div className="mb-1.5 flex items-center gap-2 px-1">
            <span className="text-[11px] font-bold text-[#42526B]">
              {authorLabel}
            </span>
            <time className="text-[10px] text-[#607086]">
              {formatTime(message.created_at)}
            </time>
          </div>
          <div
            className={`w-fit max-w-full rounded px-4 py-3 text-sm leading-6 shadow-sm ${
              mine
                ? "border border-[#F2B09F] bg-[#FFF0EB] text-[#44201A] shadow-[#FF6F52]/10"
                : "border border-[#D8DEE8] bg-white text-[#172033]"
            }`}
          >
            <div
              className={`prose prose-sm max-w-none break-words prose-p:my-0 prose-p:leading-6 prose-pre:bg-[#10213F] prose-pre:text-white ${mine ? "prose-a:text-[#9D321F]" : "prose-a:text-[#E35E43]"}`}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {displayContent}
              </ReactMarkdown>
            </div>
          </div>
          {mine && (
            <div className="mt-1 flex items-center gap-1 px-1 text-[10px] text-[#607086]">
              <CheckCircle2 size={10} /> Sent
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-3 px-1">
            {onReply && (
              <button
                type="button"
                className="flex min-h-7 items-center gap-1 text-[10px] font-bold text-[#526178] hover:text-[#1F55C5]"
                onClick={onReply}
                aria-label={`Reply to ${mine ? "your message" : authorLabel}`}
              >
                <Reply size={10} /> Reply in this thread
              </button>
            )}
            {onRestoreRequest && (
              <button
                type="button"
                className="flex min-h-7 items-center gap-1 rounded bg-[#EEF5FF] px-2 text-[10px] font-bold text-[#1F55C5] hover:bg-[#DDEAFF] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#2F6FED]"
                onClick={onRestoreRequest}
              >
                <RotateCcw size={11} /> Restore failed request
              </button>
            )}
          </div>
        </div>
      </article>
    </div>
  );
}
