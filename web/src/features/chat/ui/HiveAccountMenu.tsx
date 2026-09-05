import { LogOut, MoreHorizontal, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useCloseOnEscape } from "./useCloseOnEscape";

export function HiveAccountMenu({
  email,
  onLogout,
  onRefresh,
}: {
  email: string;
  onLogout: () => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  useCloseOnEscape(open, setOpen);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="grid size-9 place-items-center rounded-md border border-[#D8DEE8] text-[#526178] transition hover:bg-[#F7FAFC] hover:text-[#1F55C5]"
        aria-label={open ? "Close account menu" : "Open account menu"}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <MoreHorizontal size={17} />
      </button>
      {open && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
            aria-label="Close account menu"
          />
          <div
            className="absolute right-0 top-11 z-40 w-64 overflow-hidden rounded-xl border border-[#D8DEE8] bg-white p-2 shadow-[0_18px_50px_rgba(16,35,63,0.18)]"
            role="menu"
          >
            <div className="border-b border-[#E2E8F0] px-2.5 py-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-[#8491A4]">
                Signed in
              </p>
              <p className="mt-0.5 truncate text-xs font-semibold text-[#42526B]">
                {email}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onRefresh();
              }}
              className="mt-1 flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs font-bold text-[#526178] hover:bg-[#F7FAFC] hover:text-[#FF6F52]"
              role="menuitem"
            >
              <RefreshCw size={14} /> Refresh conversation
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs font-bold text-[#526178] hover:bg-[#FFF3F4] hover:text-[#C93F4A]"
              role="menuitem"
            >
              <LogOut size={14} /> Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}
