import { ArrowLeft, MessageSquareText, Reply, X } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { NostrEvent } from "@/shared/lib/nostr-client";
import { BrickOPet } from "./BrickOPet";
import type {
  HiveParticipant,
  ParticipantProfile,
} from "./useHiveParticipantDirectory";
import {
  normalizePubkey,
  participantInitials,
  participantPresentation,
} from "./useHiveParticipantDirectory";
import {
  messageContentPreview,
  normalizeMessageContent,
} from "./messageContent";

type ThreadGroup = {
  replies: NostrEvent[];
  root: NostrEvent | null;
  rootId: string;
};

function threadAnchorId(message: NostrEvent): string | null {
  return (
    message.tags.find(
      (tag) => tag[0] === "e" && tag[3] === "root" && tag[1],
    )?.[1] ??
    message.tags.find(
      (tag) => tag[0] === "e" && tag[3] === "reply" && tag[1],
    )?.[1] ??
    null
  );
}

export function groupConversationThreads(
  messages: NostrEvent[],
): ThreadGroup[] {
  const messagesById = new Map(
    messages.map((message) => [message.id, message]),
  );
  const repliesByRoot = new Map<string, NostrEvent[]>();
  for (const message of messages) {
    const rootId = threadAnchorId(message);
    if (!rootId || rootId === message.id) continue;
    const replies = repliesByRoot.get(rootId) ?? [];
    replies.push(message);
    repliesByRoot.set(rootId, replies);
  }
  return [...repliesByRoot.entries()]
    .map(([rootId, replies]) => ({
      replies: replies.sort(
        (left, right) => left.created_at - right.created_at,
      ),
      root: messagesById.get(rootId) ?? null,
      rootId,
    }))
    .sort((left, right) => {
      const leftTime =
        left.root?.created_at ?? left.replies[0]?.created_at ?? 0;
      const rightTime =
        right.root?.created_at ?? right.replies[0]?.created_at ?? 0;
      return rightTime - leftTime;
    });
}

export function HiveHeaderCollaboration({
  onThreads,
  participants,
  threadCount,
  threadsOpen,
}: {
  onThreads: () => void;
  participants: HiveParticipant[];
  threadCount: number;
  threadsOpen: boolean;
}) {
  const visible = participants.slice(0, 4);
  return (
    <div className="flex items-center gap-2">
      <div className="hidden -space-x-2 xl:flex" title="Conversation members">
        {visible.map((participant) =>
          participant.isAgent ? (
            <span
              key={participant.pubkey}
              className="grid size-8 place-items-center rounded-full border-2 border-white bg-[#FFF1EB]"
              title={`${participant.displayName} · ${participant.identityHint}`}
            >
              <BrickOPet mode="still" size="sm" />
            </span>
          ) : (
            <span
              key={participant.pubkey}
              className="grid size-8 place-items-center rounded-full border-2 border-white bg-[#10213F] text-[9px] font-extrabold text-white"
              title={`${participant.displayName} · ${participant.identityHint}`}
            >
              {participantInitials(participant.displayName)}
            </span>
          ),
        )}
      </div>
      <button
        type="button"
        onClick={onThreads}
        className="flex h-9 min-w-9 items-center justify-center gap-2 rounded-md border border-[#D8DEE8] px-2 text-xs font-bold text-[#42526B] transition hover:border-[#BFD4FF] hover:bg-[#EEF5FF] hover:text-[#1F55C5] lg:px-3"
        aria-expanded={threadsOpen}
        aria-controls="hive-thread-panel"
        aria-label={threadsOpen ? "Hide threads" : "Open threads"}
      >
        <MessageSquareText size={15} />
        <span className="hidden lg:inline">Threads</span>
        {threadCount > 0 && (
          <span className="rounded-full bg-[#EEF5FF] px-1.5 py-0.5 text-[10px] text-[#1F55C5]">
            {threadCount}
          </span>
        )}
      </button>
    </div>
  );
}

function Author({
  agentPubkey,
  identityPubkey,
  message,
  profiles,
}: {
  agentPubkey: string | null;
  identityPubkey: string;
  message: NostrEvent;
  profiles: Record<string, ParticipantProfile>;
}) {
  const { authorLabel, fromBrickO } = participantPresentation(
    message.pubkey,
    identityPubkey,
    agentPubkey,
    profiles,
  );
  return (
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
  const threads = groupConversationThreads(messages);
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null);
  const selectedThread =
    threads.find((thread) => thread.rootId === selectedRootId) ?? null;
  const contentForDisplay = (message: NostrEvent) =>
    normalizePubkey(message.pubkey) === normalizePubkey(agentPubkey ?? "")
      ? normalizeMessageContent(message.content)
      : message.content;
  useEffect(() => {
    if (selectedRootId && !selectedThread) setSelectedRootId(null);
  }, [selectedRootId, selectedThread]);
  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-20 bg-[#10213F]/20 backdrop-blur-[1px] 2xl:hidden"
        onClick={onClose}
        aria-label="Dismiss threads"
      />
      <aside
        id="hive-thread-panel"
        aria-label="Conversation threads"
        className="fixed inset-y-0 right-0 z-30 flex w-full shrink-0 flex-col border-l border-[#D8DEE8] bg-white shadow-[-16px_0_40px_rgba(16,35,63,0.16)] sm:w-[min(24rem,calc(100vw-1rem))] 2xl:static 2xl:w-80 2xl:shadow-none"
      >
        <div className="flex min-h-14 items-center justify-between gap-2 border-b border-[#D8DEE8] px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            {selectedThread && (
              <button
                type="button"
                onClick={() => setSelectedRootId(null)}
                className="grid size-9 shrink-0 place-items-center rounded-md text-[#526178] hover:bg-[#F1F5FA]"
                aria-label="Back to thread list"
              >
                <ArrowLeft size={16} />
              </button>
            )}
            <div className="min-w-0">
              <h2 className="truncate text-sm font-bold text-[#10233F]">
                {selectedThread ? "Thread" : "Threads"}
              </h2>
              <p className="truncate text-[10px] text-[#607086]">
                {selectedThread
                  ? `${selectedThread.replies.length} ${selectedThread.replies.length === 1 ? "reply" : "replies"}`
                  : `${threads.length} ${threads.length === 1 ? "thread" : "threads"} in this conversation`}
              </p>
            </div>
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
          {selectedThread ? (
            <div className="space-y-4">
              {[selectedThread.root, ...selectedThread.replies]
                .filter((message): message is NostrEvent => Boolean(message))
                .map((message, index) => (
                  <article
                    key={message.id}
                    className={
                      index === 0
                        ? "rounded-xl border border-[#C7D2E3] bg-[#F7FAFC] p-3"
                        : "border-b border-[#E2E8F0] px-1 pb-4 last:border-0"
                    }
                  >
                    <Author
                      agentPubkey={agentPubkey}
                      identityPubkey={identityPubkey}
                      message={message}
                      profiles={profiles}
                    />
                    <div className="prose prose-sm ml-9 mt-1 max-w-none break-words text-xs leading-5 text-[#42526B] prose-p:my-1 prose-pre:bg-[#10213F] prose-pre:text-white">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {contentForDisplay(message)}
                      </ReactMarkdown>
                    </div>
                  </article>
                ))}
              {(selectedThread.root ?? selectedThread.replies[0]) && (
                <button
                  type="button"
                  onClick={() =>
                    onReply(selectedThread.root ?? selectedThread.replies[0])
                  }
                  className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[#2F6FED] text-xs font-bold text-white hover:bg-[#244FB3]"
                >
                  <Reply size={14} /> Reply in this thread
                </button>
              )}
            </div>
          ) : threads.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[#C7D2E3] bg-[#F9FBFD] px-4 py-8 text-center">
              <MessageSquareText className="mx-auto text-[#8491A4]" size={22} />
              <p className="mt-2 text-xs font-bold text-[#42526B]">
                No threads yet
              </p>
              <p className="mt-1 text-[11px] leading-5 text-[#607086]">
                Reply below a message to keep detailed work focused.
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {threads.map((thread) => {
                const rootLabel = thread.root
                  ? messageContentPreview(
                      thread.root.content,
                      normalizePubkey(thread.root.pubkey) ===
                        normalizePubkey(agentPubkey ?? ""),
                    )
                  : "Original message";
                const latest =
                  thread.replies[thread.replies.length - 1] ?? thread.root;
                const latestAuthor = latest
                  ? participantPresentation(
                      latest.pubkey,
                      identityPubkey,
                      agentPubkey,
                      profiles,
                    ).authorLabel
                  : "Unknown";
                return (
                  <button
                    type="button"
                    key={thread.rootId}
                    onClick={() => setSelectedRootId(thread.rootId)}
                    className="w-full rounded-lg border border-transparent px-3 py-3 text-left transition hover:border-[#D8DEE8] hover:bg-[#F7FAFC] focus-visible:border-[#2F6FED] focus-visible:outline-none"
                    aria-label={`Open thread: ${rootLabel}`}
                  >
                    <p className="line-clamp-2 text-xs font-bold leading-5 text-[#24324A]">
                      {rootLabel}
                    </p>
                    <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-[#607086]">
                      <span>
                        {thread.replies.length}{" "}
                        {thread.replies.length === 1 ? "reply" : "replies"}
                      </span>
                      <span className="truncate">Latest · {latestAuthor}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
