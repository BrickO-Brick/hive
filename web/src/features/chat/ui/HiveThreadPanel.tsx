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
    <div className="hidden items-center gap-2 md:flex">
      <div className="hidden -space-x-2 lg:flex" title="Conversation members">
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
        className="flex h-9 items-center gap-2 rounded-md border border-[#D8DEE8] px-2 text-xs font-bold text-[#42526B] transition hover:border-[#BFD4FF] hover:bg-[#EEF5FF] hover:text-[#1F55C5] lg:px-3"
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
  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-20 hidden bg-[#10213F]/20 backdrop-blur-[1px] md:block xl:hidden"
        onClick={onClose}
        aria-label="Dismiss threads"
      />
      <aside
        id="hive-thread-panel"
        aria-label="Conversation threads"
        className="fixed inset-y-0 right-0 z-30 hidden w-[min(24rem,calc(100vw-1rem))] shrink-0 flex-col border-l border-[#D8DEE8] bg-white shadow-[-16px_0_40px_rgba(16,35,63,0.16)] md:flex xl:static xl:w-80 xl:shadow-none"
      >
        <div className="flex h-14 items-center justify-between border-b border-[#D8DEE8] px-4">
          <div>
            <h2 className="text-sm font-bold text-[#10233F]">Threads</h2>
            <p className="text-[10px] text-[#607086]">
              {threads.length} {threads.length === 1 ? "thread" : "threads"} in
              this conversation
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
          {threads.length === 0 ? (
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
            <div className="space-y-3">
              {threads.map((thread) => {
                const replyTarget = thread.root ?? thread.replies[0];
                const rootLabel =
                  thread.root?.content.trim() || "Original message";
                return (
                  <section
                    key={thread.rootId}
                    className="overflow-hidden rounded-xl border border-[#D8DEE8] bg-white"
                    aria-label={`Thread: ${rootLabel}`}
                  >
                    <div className="border-b border-[#E2E8F0] bg-[#F7FAFC] p-3">
                      {thread.root && (
                        <Author
                          agentPubkey={agentPubkey}
                          identityPubkey={identityPubkey}
                          message={thread.root}
                          profiles={profiles}
                        />
                      )}
                      <p className="mt-2 line-clamp-3 text-xs font-semibold leading-5 text-[#24324A]">
                        {rootLabel}
                      </p>
                      <p className="mt-1 text-[10px] font-bold text-[#607086]">
                        {thread.replies.length}{" "}
                        {thread.replies.length === 1 ? "reply" : "replies"}
                      </p>
                    </div>
                    <div className="space-y-3 p-3">
                      {thread.replies.map((reply) => (
                        <article key={reply.id}>
                          <Author
                            agentPubkey={agentPubkey}
                            identityPubkey={identityPubkey}
                            message={reply}
                            profiles={profiles}
                          />
                          <p className="ml-9 mt-1 line-clamp-4 text-xs leading-5 text-[#42526B]">
                            {reply.content}
                          </p>
                        </article>
                      ))}
                      {replyTarget && (
                        <button
                          type="button"
                          onClick={() => onReply(replyTarget)}
                          className="text-[11px] font-bold text-[#1F55C5] hover:underline"
                          aria-label={`Reply to thread: ${rootLabel}`}
                        >
                          Reply to thread
                        </button>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
