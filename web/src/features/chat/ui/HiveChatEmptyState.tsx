import { MessageCircle } from "lucide-react";
import brickoOperationsUrl from "@/assets/bricko-operations.jpg";
import type { HiveConversation } from "./discussionMessages";

export function HiveChatEmptyState({
  conversation,
}: {
  conversation: HiveConversation | null;
}) {
  if (conversation) {
    return (
      <div className="grid min-h-[45vh] place-items-center text-center">
        <div className="max-w-sm">
          <div className="mx-auto grid size-12 place-items-center rounded-xl bg-[#EEF5FF] text-[#2F6FED]">
            <MessageCircle size={22} />
          </div>
          <h2 className="mt-4 text-base font-bold text-[#10233F]">
            Start {conversation.title}
          </h2>
          <p className="mt-2 text-sm leading-6 text-[#607086]">
            This group chat is independent from a repository. Mention a teammate
            or BrickO with @ to bring them in.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-[45vh] place-items-center text-center">
      <div className="max-w-md">
        <div className="mx-auto w-full max-w-[280px] overflow-hidden rounded-2xl border border-[#FFD3C9] bg-white p-2 shadow-[0_18px_50px_rgba(255,111,82,0.14)]">
          <img
            alt="The Brickster team coding with BrickO, BrickA, BrickI, and BrickR"
            className="aspect-square w-full rounded-xl object-cover"
            src={brickoOperationsUrl}
          />
        </div>
        <h2 className="mt-4 text-base font-bold text-[#10233F]">
          Welcome, Bricksters — let&apos;s build something fun!
        </h2>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-[#607086]">
          Bring bold ideas, stubborn bugs, and seemingly impossible projects.
          BrickO brought virtual snacks—let&apos;s turn “maybe” into “shipped”
          together.
        </p>
        <p className="mx-auto mt-3 max-w-sm rounded-lg border border-[#FFD3C9] bg-[#FFF8F5] px-3 py-2 text-xs font-semibold text-[#573129]">
          Interface language: English. Chat in any language.
        </p>
      </div>
    </div>
  );
}
