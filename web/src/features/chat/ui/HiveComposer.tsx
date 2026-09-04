import { AtSign, Clock3, RefreshCw, Send, WifiOff, X } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  useMemo,
  useState,
} from "react";
import type { RepositoryDiscussion } from "@/features/repos/repository-discussions-api";
import type { NostrEvent } from "@/shared/lib/nostr-client";
import { BrickOPet } from "./BrickOPet";
import {
  type HiveParticipant,
  participantInitials,
} from "./useHiveParticipantDirectory";

type Props = {
  activeDiscussion: RepositoryDiscussion | null;
  busy: boolean;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  connected: boolean;
  error: string;
  onCancelReply: () => void;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: (event: FormEvent) => void;
  participants: HiveParticipant[];
  replyAuthor: string;
  replyTo: NostrEvent | null;
  text: string;
};

type MentionMatch = {
  end: number;
  query: string;
  start: number;
};

function activeMention(text: string, cursor: number): MentionMatch | null {
  const beforeCursor = text.slice(0, cursor);
  const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) return null;
  const query = match[1] ?? "";
  return {
    end: cursor,
    query: query.toLowerCase(),
    start: cursor - query.length - 1,
  };
}

export function HiveComposer({
  activeDiscussion,
  busy,
  composerRef,
  connected,
  error,
  onCancelReply,
  onChange,
  onKeyDown,
  onSubmit,
  participants,
  replyAuthor,
  replyTo,
  text,
}: Props) {
  const [cursor, setCursor] = useState(0);
  const [mentionClosed, setMentionClosed] = useState(false);
  const [selectedMention, setSelectedMention] = useState(0);
  const accessibleName = activeDiscussion
    ? `Message BrickO about ${activeDiscussion.repository}`
    : "Message BrickO";
  const mention = mentionClosed ? null : activeMention(text, cursor);
  const mentionOptions = useMemo(() => {
    if (!mention) return [];
    return participants
      .filter((participant) => !participant.isCurrentUser)
      .filter((participant) =>
        participant.displayName.toLowerCase().includes(mention.query),
      )
      .slice(0, 8);
  }, [mention, participants]);
  const mentionOpen = Boolean(mention && mentionOptions.length > 0);

  const insertMention = (participant: HiveParticipant) => {
    if (!mention) return;
    const next = `${text.slice(0, mention.start)}@${participant.displayName} ${text.slice(mention.end)}`;
    const nextCursor = mention.start + participant.displayName.length + 2;
    onChange(next);
    setCursor(nextCursor);
    setMentionClosed(true);
    requestAnimationFrame(() => {
      const textarea = composerRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setSelectedMention(
          (current) =>
            (current + direction + mentionOptions.length) %
            mentionOptions.length,
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionClosed(true);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const participant = mentionOptions[selectedMention];
        if (participant) insertMention(participant);
        return;
      }
    }
    onKeyDown(event);
  };

  return (
    <form
      onSubmit={onSubmit}
      className="shrink-0 border-t border-[#D8DEE8] bg-white px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-5"
    >
      <div className="mx-auto max-w-4xl">
        {error && (
          <div
            className="mb-3 flex items-center gap-2 rounded border border-[#F4BDC2] bg-[#FFF3F4] px-3 py-2 text-xs text-[#A5303B]"
            role="alert"
          >
            <WifiOff size={13} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {replyTo && (
          <div className="mb-2 flex items-start justify-between rounded border border-[#BFD4FF] bg-[#EEF5FF] px-3 py-2 text-xs text-[#29466F]">
            <span className="line-clamp-2 leading-5">
              <strong>Replying to {replyAuthor}:</strong> {replyTo.content}
            </span>
            <button
              type="button"
              className="ml-3 grid size-7 shrink-0 place-items-center rounded hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#2F6FED]"
              onClick={onCancelReply}
              aria-label="Cancel reply"
            >
              <X size={13} />
            </button>
          </div>
        )}
        <label className="sr-only" htmlFor="hive-message-composer">
          {accessibleName}
        </label>
        <div className="relative flex items-end gap-2 rounded-lg border border-[#D8DEE8] bg-white p-2 shadow-[0_8px_24px_rgba(16,35,63,0.08)] transition focus-within:border-[#2F6FED]/60 focus-within:ring-4 focus-within:ring-[#2F6FED]/10">
          {mentionOpen && (
            <div
              className="absolute bottom-[calc(100%+0.5rem)] left-0 z-30 w-[min(25rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-[#C7D2E3] bg-white shadow-[0_18px_50px_rgba(16,35,63,0.18)]"
              role="listbox"
              aria-label="Mention someone"
              data-testid="mention-picker"
            >
              <div className="flex h-10 items-center gap-2 border-b border-[#E2E8F0] px-3 text-xs font-semibold text-[#607086]">
                <AtSign size={13} /> Mention someone
              </div>
              <div className="max-h-72 overflow-y-auto p-1.5">
                {mentionOptions.map((participant, index) => {
                  const selected = index === selectedMention;
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      key={participant.pubkey}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertMention(participant)}
                      className={`flex min-h-12 w-full items-center gap-2.5 rounded-md px-2.5 text-left ${
                        selected
                          ? "bg-[#2F6FED] text-white"
                          : "text-[#172033] hover:bg-[#F1F5FA]"
                      }`}
                    >
                      {participant.isAgent ? (
                        <BrickOPet mode="still" size="sm" />
                      ) : (
                        <span
                          className={`grid size-8 shrink-0 place-items-center rounded-full text-[10px] font-extrabold ${
                            selected
                              ? "bg-white/18 text-white"
                              : "bg-[#E9EEF6] text-[#344054]"
                          }`}
                        >
                          {participantInitials(participant.displayName)}
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold">
                          {participant.displayName}
                        </span>
                        <span
                          className={`block truncate text-[11px] ${selected ? "text-white/75" : "text-[#607086]"}`}
                        >
                          {participant.role}
                        </span>
                      </span>
                      {participant.isAgent && (
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                            selected
                              ? "border-white/35 bg-white/12"
                              : "border-[#BFD4FF] bg-[#EEF5FF] text-[#1F55C5]"
                          }`}
                        >
                          Agent
                        </span>
                      )}
                      <span className="flex items-center gap-1 text-[10px] font-semibold">
                        <span className="size-2 rounded-full bg-[#1FA971] ring-2 ring-white/60" />
                        Online
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="border-t border-[#E2E8F0] bg-[#F7FAFC] px-3 py-1.5 text-[10px] text-[#607086]">
                ↑↓ to navigate · Enter to mention · Esc to close
              </div>
            </div>
          )}
          <textarea
            id="hive-message-composer"
            ref={composerRef}
            value={text}
            onChange={(event) => {
              onChange(event.target.value);
              setCursor(event.target.selectionStart);
              setMentionClosed(false);
              setSelectedMention(0);
            }}
            onClick={(event) => setCursor(event.currentTarget.selectionStart)}
            onKeyDown={handleKeyDown}
            maxLength={65_536}
            rows={1}
            aria-describedby="hive-composer-help hive-composer-connection"
            placeholder={`${accessibleName}…`}
            className="max-h-36 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-3 py-2.5 text-sm leading-6 text-[#172033] outline-none placeholder:text-[#8491A4]"
          />
          <button
            type="submit"
            disabled={busy || !text.trim() || !connected}
            className="grid size-11 shrink-0 place-items-center rounded bg-[#FF6F52] text-white transition hover:bg-[#E35E43] disabled:cursor-not-allowed disabled:bg-[#E2E8F0] disabled:text-[#8491A4]"
            aria-label="Send"
            aria-describedby="hive-composer-connection"
          >
            {busy ? (
              <RefreshCw size={17} className="animate-spin" />
            ) : (
              <Send size={17} />
            )}
          </button>
        </div>
        <div
          id="hive-composer-help"
          className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-xs text-[#526178]"
        >
          <span className="flex items-center gap-1.5">
            <Clock3 size={11} /> Enter to send · Shift+Enter for a new line
          </span>
          <span className="font-semibold text-[#573129]">
            Interface: English · Chat: any language
          </span>
          <span>{text.length.toLocaleString("en-US")}/65,536</span>
        </div>
        <p
          id="hive-composer-connection"
          className={`mt-1 px-1 text-[11px] ${connected ? "sr-only" : "font-semibold text-[#8A4B00]"}`}
          aria-live="polite"
        >
          {connected
            ? "Chat connected."
            : "Sending is paused while chat reconnects. Your draft is safe."}
        </p>
      </div>
    </form>
  );
}
