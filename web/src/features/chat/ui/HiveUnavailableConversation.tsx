import { CircleAlert } from "lucide-react";

export function HiveUnavailableConversation({
  kind,
  loading,
  loadFailed = false,
  onBrowseRepositories,
  onRetry,
  onReturn,
}: {
  kind: "private-chat" | "repository-discussion";
  loading: boolean;
  loadFailed?: boolean;
  onBrowseRepositories?: () => void;
  onRetry: () => void;
  onReturn: () => void;
}) {
  const repository = kind === "repository-discussion";
  const title = loading
    ? repository
      ? "Restoring repository discussion…"
      : "Restoring private chat…"
    : loadFailed && repository
      ? "Hive could not load repository discussions"
      : repository
        ? "This repository discussion is unavailable"
        : "This private chat is unavailable";
  const detail = loading
    ? repository
      ? "Hive is resolving its repository workspace before messages or edits are enabled."
      : "Hive is verifying your membership before messages are loaded."
    : loadFailed && repository
      ? "Nothing was changed. Retry the catalog request or return to a safe conversation."
      : repository
        ? "It may have been archived, moved, or created before workspace migration. Hive has disabled sending so the message cannot land in the wrong chat."
        : "The chat may have been hidden or your membership may have changed. Sending remains disabled so no message can land in another channel.";

  return (
    <div
      className="mb-4 rounded-xl border border-[#F3C7C9] bg-white p-5 shadow-sm"
      role={loading ? "status" : "alert"}
      data-testid={
        repository ? "discussion-unavailable" : "conversation-unavailable"
      }
    >
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-[#FFF3F4] text-[#B93845]">
          <CircleAlert size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-[#10233F]">{title}</h2>
          <p className="mt-1 text-xs leading-5 text-[#607086]">{detail}</p>
          {!loading && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-md bg-[#2F6FED] px-3 py-2 text-xs font-bold text-white hover:bg-[#244FB6]"
                onClick={onRetry}
              >
                Retry
              </button>
              <button
                type="button"
                className="rounded-md border border-[#D8DEE8] bg-white px-3 py-2 text-xs font-bold text-[#42526B] hover:border-[#BFD4FF]"
                onClick={onReturn}
              >
                Return to bricko-lab
              </button>
              {repository && onBrowseRepositories && (
                <button
                  type="button"
                  className="rounded-md border border-[#D8DEE8] bg-white px-3 py-2 text-xs font-bold text-[#42526B] hover:border-[#BFD4FF]"
                  onClick={onBrowseRepositories}
                >
                  Browse repositories
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
