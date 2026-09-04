import { Clock3, RefreshCw, Send, WifiOff, X } from "lucide-react";
import type { FormEvent, KeyboardEvent, RefObject } from "react";
import type { RepositoryDiscussion } from "@/features/repos/repository-discussions-api";
import type { NostrEvent } from "@/shared/lib/nostr-client";

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
  replyAuthor: string;
  replyTo: NostrEvent | null;
  text: string;
};

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
  replyAuthor,
  replyTo,
  text,
}: Props) {
  const accessibleName = activeDiscussion
    ? `Message BrickO about ${activeDiscussion.repository}`
    : "Message BrickO";

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
        <div className="flex items-end gap-2 rounded border border-[#D8DEE8] bg-white p-2 shadow-[0_8px_24px_rgba(16,35,63,0.08)] transition focus-within:border-[#FF6F52]/60 focus-within:ring-4 focus-within:ring-[#FF6F52]/10">
          <textarea
            id="hive-message-composer"
            ref={composerRef}
            value={text}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
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
