import {
  GitBranch,
  Hash,
  Menu,
  MessageSquarePlus,
  PanelLeftClose,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import hiveLogoUrl from "@/assets/hive-logo.svg";
import type { RepositoryDiscussion } from "@/features/repos/repository-discussions-api";
import { BrickOPet } from "./BrickOPet";

export type HiveAgentState = {
  detail: string;
  label: string;
};

type Props = {
  activeDiscussionId: string | null;
  agentState: HiveAgentState;
  collapsed: boolean;
  connected: boolean;
  discussions: RepositoryDiscussion[];
  identityEmail: string;
  mobile?: boolean;
  onDiscussion: (discussion: RepositoryDiscussion) => void;
  onGeneral: () => void;
  onRepositories: () => void;
  onToggle: () => void;
  surface: "chat" | "repositories";
  toneClasses: string;
};

function collapsedLabel(value: string): string {
  return value.length > 8 ? `${value.slice(0, 7)}…` : value;
}

export function HiveNavigation({
  activeDiscussionId,
  agentState,
  collapsed,
  connected,
  discussions,
  identityEmail,
  mobile = false,
  onDiscussion,
  onGeneral,
  onRepositories,
  onToggle,
  surface,
  toneClasses,
}: Props) {
  return (
    <>
      <div
        className={`flex shrink-0 items-center border-b border-[#D8DEE8] ${
          collapsed ? "h-[60px] justify-center" : "h-[72px] px-4"
        }`}
      >
        {!collapsed && (
          <img
            src={hiveLogoUrl}
            alt="Hive"
            className="h-auto w-[104px] shrink-0"
          />
        )}
        <button
          type="button"
          data-testid={mobile ? "mobile-navigation-close" : "sidebar-toggle"}
          onClick={onToggle}
          className={`grid size-8 shrink-0 place-items-center rounded border border-[#D8DEE8] bg-white text-[#526178] transition hover:border-[#FF6F52]/50 hover:bg-[#F7FAFC] hover:text-[#FF6F52] ${
            collapsed ? "" : "ml-auto"
          }`}
          aria-label={
            mobile
              ? "Close navigation menu"
              : collapsed
                ? "Show navigation menu"
                : "Hide navigation menu"
          }
          title={mobile ? "Close menu" : collapsed ? "Show menu" : "Hide menu"}
        >
          {mobile ? (
            <X size={17} />
          ) : collapsed ? (
            <Menu size={17} />
          ) : (
            <PanelLeftClose size={17} />
          )}
        </button>
      </div>

      <nav
        className={`min-h-0 flex-1 overflow-y-auto overflow-x-hidden ${
          collapsed ? "px-2 py-3" : "px-3 py-4"
        }`}
        aria-label="Hive navigation"
      >
        {!collapsed && (
          <div className="mb-2 px-1 text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#607086]">
            Conversations
          </div>
        )}
        <button
          type="button"
          className={`flex w-full items-center rounded border ${
            surface === "chat" && activeDiscussionId === null
              ? "border-[#BFD4FF] bg-[#EEF5FF] text-[#1F55C5] shadow-[inset_3px_0_0_#2F6FED]"
              : "border-transparent text-[#526178] hover:bg-[#F7FAFC]"
          } ${collapsed ? "min-h-12 flex-col justify-center px-0" : "h-9 gap-2 px-2.5"}`}
          aria-current={
            surface === "chat" && activeDiscussionId === null
              ? "page"
              : undefined
          }
          aria-label="Open bricko-lab conversation"
          onClick={onGeneral}
          title="bricko-lab"
        >
          <Hash size={15} className="shrink-0" />
          <span
            className={`${collapsed ? "mt-1 text-[9px]" : "min-w-0 flex-1 truncate text-left text-[13px]"} font-bold`}
          >
            {collapsed ? "lab" : "bricko-lab"}
          </span>
        </button>

        {discussions.map((discussion) => (
          <button
            type="button"
            key={discussion.id}
            data-testid={`discussion-${discussion.id}`}
            className={`mt-1 flex w-full items-center rounded border ${
              surface === "chat" && activeDiscussionId === discussion.id
                ? "border-[#BFD4FF] bg-[#EEF5FF] text-[#1F55C5] shadow-[inset_3px_0_0_#2F6FED]"
                : "border-transparent text-[#526178] hover:bg-[#F7FAFC]"
            } ${collapsed ? "min-h-12 flex-col justify-center px-0 py-1" : "min-h-12 gap-2 px-2.5 py-1.5"}`}
            aria-current={
              surface === "chat" && activeDiscussionId === discussion.id
                ? "page"
                : undefined
            }
            aria-label={`${discussion.owner}/${discussion.repository}: ${discussion.title}`}
            onClick={() => onDiscussion(discussion)}
            title={`${discussion.owner}/${discussion.repository}: ${discussion.title}`}
          >
            <MessageSquarePlus size={15} className="shrink-0" />
            {collapsed ? (
              <span className="mt-1 max-w-full truncate px-1 text-[9px] font-bold">
                {collapsedLabel(discussion.repository)}
              </span>
            ) : (
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[10px] font-semibold uppercase tracking-wide text-[#607086]">
                  {discussion.owner}/{discussion.repository}
                </span>
                <span className="mt-0.5 line-clamp-2 block text-[13px] font-bold leading-4">
                  {discussion.title}
                </span>
              </span>
            )}
          </button>
        ))}

        {!collapsed && (
          <div className="mb-2 mt-5 px-1 text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#607086]">
            Workspace
          </div>
        )}
        <button
          type="button"
          className={`flex w-full items-center rounded border ${
            surface === "repositories"
              ? "border-[#FFD3C9] bg-[#FFF1EB] text-[#D95336] shadow-[inset_3px_0_0_#FF6F52]"
              : "border-transparent text-[#526178] hover:bg-[#F7FAFC]"
          } ${collapsed ? "min-h-12 flex-col justify-center px-0" : "h-9 gap-2 px-2.5"}`}
          aria-current={surface === "repositories" ? "page" : undefined}
          aria-label="Open repositories"
          data-testid="open-github-repositories"
          onClick={onRepositories}
          title="Repositories"
        >
          <GitBranch size={15} className="shrink-0" />
          <span
            className={`${collapsed ? "mt-1 text-[9px]" : "min-w-0 flex-1 truncate text-left text-[13px]"} font-bold`}
          >
            {collapsed ? "repos" : "Repositories"}
          </span>
        </button>

        {!collapsed && (
          <div className="mb-2 mt-5 px-1 text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#607086]">
            Agent activity
          </div>
        )}
        <section
          className={`mt-2 rounded border border-[#D8DEE8] bg-[#F7FAFC] ${
            collapsed ? "grid min-h-14 place-items-center p-1" : "p-3"
          }`}
          aria-label="BrickO status"
          title={
            collapsed ? `${agentState.label} — ${agentState.detail}` : undefined
          }
        >
          <div
            className={`flex items-start ${collapsed ? "flex-col items-center" : "gap-2.5"}`}
          >
            <div className="relative size-8 shrink-0">
              <BrickOPet
                mode={
                  connected && agentState.label !== "Offline"
                    ? "still"
                    : "offline"
                }
                size="sm"
              />
              <span
                className={`absolute -bottom-1 -right-1 size-3 rounded-full border-2 border-white shadow-sm ${toneClasses}`}
              />
            </div>
            {collapsed ? (
              <span className="mt-1 text-[9px] font-bold text-[#42526B]">
                BrickO
              </span>
            ) : (
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-bold text-[#10233F]">
                    BrickO
                  </span>
                  <span className="rounded-full border border-[#D8DEE8] bg-white px-1.5 py-0.5 text-[8px] font-extrabold uppercase tracking-[0.08em] text-[#526178]">
                    Agent
                  </span>
                </div>
                <div className="mt-1 truncate text-[11px] font-semibold text-[#344054]">
                  {agentState.label}
                </div>
              </div>
            )}
          </div>
          {!collapsed && (
            <div className="mt-2.5 border-t border-[#D8DEE8] pt-2.5 text-[10px] leading-[1.5] text-[#607086]">
              {agentState.detail}
            </div>
          )}
        </section>
      </nav>

      <div
        className={`shrink-0 border-t border-[#D8DEE8] bg-[#F7FAFC] ${
          collapsed ? "p-2" : "p-3"
        }`}
      >
        <div
          className={`rounded border border-[#D8DEE8] bg-white ${
            collapsed ? "grid min-h-11 place-items-center py-1" : "p-2.5"
          }`}
          title={connected ? "Chat connected" : "Chat reconnecting"}
        >
          <div
            className={`flex items-center text-[11px] font-semibold text-[#42526B] ${
              collapsed ? "flex-col justify-center" : "gap-2"
            }`}
          >
            {connected ? (
              <Wifi size={13} className="text-[#1FA971]" />
            ) : (
              <WifiOff size={13} className="text-[#D9861C]" />
            )}
            <span className={collapsed ? "mt-1 text-[9px]" : ""}>
              {collapsed
                ? "chat"
                : connected
                  ? "Chat connected"
                  : "Chat reconnecting"}
            </span>
          </div>
          {!collapsed && (
            <div className="mt-2 truncate border-t border-[#E2E8F0] pt-2 text-[10px] text-[#607086]">
              {identityEmail}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
