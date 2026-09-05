import { RefreshCw } from "lucide-react";

export function HiveHistoryPagination({
  loading,
  onLoadOlder,
}: {
  loading: boolean;
  onLoadOlder: () => void;
}) {
  return (
    <div className="mb-4 flex justify-center">
      <button
        type="button"
        data-testid="load-older-messages"
        disabled={loading}
        onClick={onLoadOlder}
        className="flex items-center gap-2 rounded-full border border-[#D8DEE8] bg-white px-4 py-2 text-xs font-bold text-[#42526B] shadow-sm transition hover:border-[#BFD4FF] hover:text-[#1F55C5] disabled:cursor-wait disabled:text-[#8491A4]"
      >
        <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        {loading ? "Loading older messages…" : "Load older messages"}
      </button>
    </div>
  );
}
