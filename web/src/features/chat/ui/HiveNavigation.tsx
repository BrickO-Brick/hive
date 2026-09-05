import {
  Bell,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  GitBranch,
  Hash,
  Menu,
  MessageCircle,
  MessageSquareText,
  PanelLeftClose,
  Plus,
  Search,
  Users,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import hiveIconUrl from "@/assets/hive-icon.png";
import type { RepositoryDiscussion } from "@/features/repos/repository-discussions-api";
import { BrickOPet } from "./BrickOPet";
import type { HiveConversation } from "./discussionMessages";

export type HiveAgentState = { detail: string; label: string };

export type HiveNavigationProps = {
  activeConversationId: string | null;
  activeDiscussionId: string | null;
  agentState: HiveAgentState;
  collapsed: boolean;
  connected: boolean;
  conversations: HiveConversation[];
  discussions: RepositoryDiscussion[];
  identityEmail: string;
  mobile?: boolean;
  onConversation: (conversation: HiveConversation) => void;
  onDiscussion: (discussion: RepositoryDiscussion) => void;
  onGeneral: () => void;
  onNewConversation: () => void;
  onRepositories: () => void;
  onToggle: () => void;
  surface: "chat" | "repositories";
  toneClasses: string;
};

type RepositoryGroup = {
  discussions: RepositoryDiscussion[];
  key: string;
  label: string;
  name: string;
};

function groupDiscussions(discussions: RepositoryDiscussion[]) {
  const groups = new Map<string, RepositoryGroup>();
  for (const discussion of discussions) {
    const key = `${discussion.owner}/${discussion.repository}`;
    const group = groups.get(key) ?? {
      discussions: [],
      key,
      label: key,
      name: discussion.repository,
    };
    group.discussions.push(discussion);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      discussions: group.discussions.sort((left, right) =>
        left.title.localeCompare(right.title),
      ),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function RailButton({
  active = false,
  children,
  label,
  onClick,
}: {
  active?: boolean;
  children: ReactNode;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative grid size-10 place-items-center rounded-lg transition ${
        active
          ? "bg-[#EEF5FF] text-[#1F55C5]"
          : "text-[#607086] hover:bg-[#F1F5FA] hover:text-[#10233F]"
      }`}
      aria-label={label}
      title={label}
    >
      {active && (
        <span className="absolute -left-3 h-7 w-0.5 rounded-r bg-[#2F6FED]" />
      )}
      {children}
    </button>
  );
}

export function HiveNavigation({
  activeConversationId,
  activeDiscussionId,
  agentState,
  collapsed,
  connected,
  conversations,
  discussions,
  identityEmail,
  mobile = false,
  onConversation,
  onDiscussion,
  onGeneral,
  onNewConversation,
  onRepositories,
  onToggle,
  surface,
  toneClasses,
}: HiveNavigationProps) {
  const groups = useMemo(() => groupDiscussions(discussions), [discussions]);
  const [query, setQuery] = useState("");
  const activeRepository = discussions.find(
    (discussion) => discussion.id === activeDiscussionId,
  );
  const [expanded, setExpanded] = useState<Set<string>>(
    () =>
      new Set(
        activeRepository
          ? [`${activeRepository.owner}/${activeRepository.repository}`]
          : groups.slice(0, 2).map((group) => group.key),
      ),
  );
  useEffect(() => {
    if (!activeRepository) return;
    const key = `${activeRepository.owner}/${activeRepository.repository}`;
    setExpanded((current) =>
      current.has(key) ? current : new Set([...current, key]),
    );
  }, [activeRepository]);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredConversations = conversations.filter((conversation) =>
    conversation.title.toLowerCase().includes(normalizedQuery),
  );
  const filteredGroups = groups
    .map((group) => ({
      ...group,
      discussions: group.discussions.filter(
        (discussion) =>
          !normalizedQuery ||
          group.label.toLowerCase().includes(normalizedQuery) ||
          discussion.title.toLowerCase().includes(normalizedQuery),
      ),
    }))
    .filter(
      (group) =>
        !normalizedQuery ||
        group.label.toLowerCase().includes(normalizedQuery) ||
        group.discussions.length > 0,
    );

  const toggleRepository = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="flex min-h-0 flex-1">
      {!mobile && (
        <div className="flex w-[68px] shrink-0 flex-col items-center border-r border-[#E2E8F0] bg-[#FBFCFE] py-3">
          <img
            alt="Hive"
            className="mb-5 size-10 rounded-xl object-contain"
            src={hiveIconUrl}
          />
          <div className="flex flex-1 flex-col items-center gap-2">
            <RailButton
              active={surface === "chat"}
              label="Chats"
              onClick={onGeneral}
            >
              <MessageCircle size={20} />
            </RailButton>
            <RailButton
              active={surface === "repositories"}
              label="Repositories"
              onClick={onRepositories}
            >
              <GitBranch size={19} />
            </RailButton>
            <RailButton label="People">
              <Users size={19} />
            </RailButton>
            <RailButton label="Notifications">
              <Bell size={19} />
            </RailButton>
          </div>
          <RailButton label="Help">
            <CircleHelp size={19} />
          </RailButton>
          <div className="relative mt-3 grid size-9 place-items-center rounded-full bg-[#10213F] text-[10px] font-extrabold text-white">
            {identityEmail.slice(0, 2).toUpperCase()}
            <span className="absolute bottom-0 right-0 size-2.5 rounded-full border-2 border-white bg-[#1FA971]" />
          </div>
        </div>
      )}

      {(!collapsed || mobile) && (
        <div className="flex min-w-0 flex-1 flex-col bg-white">
          <div className="flex h-[72px] shrink-0 items-center gap-3 border-b border-[#E2E8F0] px-4">
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              {mobile && (
                <img
                  alt="Hive"
                  className="size-9 rounded-lg object-contain"
                  src={hiveIconUrl}
                />
              )}
              <span className="truncate text-lg font-extrabold tracking-[-0.03em] text-[#10233F]">
                Hive
              </span>
            </div>
            <button
              type="button"
              data-testid={
                mobile ? "mobile-navigation-close" : "sidebar-toggle"
              }
              onClick={onToggle}
              className="grid size-8 shrink-0 place-items-center rounded-md border border-[#D8DEE8] text-[#526178] transition hover:bg-[#F7FAFC] hover:text-[#1F55C5]"
              aria-label={
                mobile ? "Close navigation menu" : "Hide navigation menu"
              }
              title={mobile ? "Close menu" : "Hide menu"}
            >
              {mobile ? <X size={17} /> : <PanelLeftClose size={17} />}
            </button>
          </div>

          <div className="border-b border-[#E2E8F0] p-3">
            <label className="relative block">
              <span className="sr-only">
                Search conversations and repositories
              </span>
              <Search
                aria-hidden="true"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8491A4]"
                size={15}
              />
              <input
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search or jump to"
                className="h-10 w-full rounded-lg border border-[#D8DEE8] bg-[#F9FBFD] pl-9 pr-3 text-sm text-[#172033] outline-none transition placeholder:text-[#8491A4] focus:border-[#2F6FED]/60 focus:bg-white focus:ring-4 focus:ring-[#2F6FED]/10"
              />
            </label>
          </div>

          <nav
            className="min-h-0 flex-1 overflow-y-auto px-3 py-4"
            aria-label="Hive navigation"
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-xs font-extrabold text-[#10233F]">
                Chats
              </span>
              <button
                type="button"
                onClick={onNewConversation}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-bold text-[#E35E43] transition hover:bg-[#FFF1EB]"
                aria-label="New chat"
              >
                <Plus size={14} /> New chat
              </button>
            </div>
            <button
              type="button"
              className={`flex h-10 w-full items-center gap-2 rounded-lg px-2.5 text-sm font-semibold transition ${
                surface === "chat" &&
                activeDiscussionId === null &&
                activeConversationId === null
                  ? "bg-[#EEF5FF] text-[#1F55C5] shadow-[inset_3px_0_0_#2F6FED]"
                  : "text-[#526178] hover:bg-[#F7FAFC]"
              }`}
              aria-current={
                surface === "chat" &&
                activeDiscussionId === null &&
                activeConversationId === null
                  ? "page"
                  : undefined
              }
              onClick={onGeneral}
            >
              <Hash size={15} /> <span className="truncate">bricko-lab</span>
            </button>
            {filteredConversations.map((conversation) => (
              <button
                type="button"
                key={conversation.id}
                data-testid={`conversation-${conversation.id}`}
                onClick={() => onConversation(conversation)}
                className={`mt-1 flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm font-semibold transition ${
                  surface === "chat" && activeConversationId === conversation.id
                    ? "bg-[#EEF5FF] text-[#1F55C5] shadow-[inset_3px_0_0_#2F6FED]"
                    : "text-[#526178] hover:bg-[#F7FAFC]"
                }`}
              >
                <MessageCircle size={15} className="shrink-0" />
                <span className="truncate">{conversation.title}</span>
              </button>
            ))}

            <div className="mx-1 my-4 border-t border-[#E2E8F0]" />
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-xs font-extrabold text-[#10233F]">
                Repositories
              </span>
              <button
                type="button"
                onClick={onRepositories}
                className="grid size-7 place-items-center rounded-md text-[#607086] transition hover:bg-[#F1F5FA] hover:text-[#1F55C5]"
                aria-label="Browse repositories"
                data-testid="open-github-repositories"
              >
                <Plus size={15} />
              </button>
            </div>
            <div className="space-y-1">
              {filteredGroups.map((group) => {
                const isExpanded =
                  Boolean(normalizedQuery) || expanded.has(group.key);
                return (
                  <div key={group.key}>
                    <button
                      type="button"
                      onClick={() => toggleRepository(group.key)}
                      className="flex h-9 w-full items-center gap-1.5 rounded-lg px-2 text-left text-sm font-bold text-[#24324A] transition hover:bg-[#F7FAFC]"
                      aria-expanded={isExpanded}
                    >
                      {isExpanded ? (
                        <ChevronDown size={14} className="shrink-0" />
                      ) : (
                        <ChevronRight size={14} className="shrink-0" />
                      )}
                      <GitBranch
                        size={14}
                        className="shrink-0 text-[#607086]"
                      />
                      <span className="truncate">{group.name}</span>
                      <span className="ml-auto rounded-full bg-[#F1F5FA] px-1.5 py-0.5 text-[10px] font-bold text-[#607086]">
                        {group.discussions.length}
                      </span>
                    </button>
                    {isExpanded && (
                      <div className="ml-4 border-l border-[#D8DEE8] pl-2">
                        {group.discussions.map((discussion) => (
                          <button
                            type="button"
                            key={discussion.id}
                            data-testid={`discussion-${discussion.id}`}
                            className={`mt-0.5 flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-semibold leading-4 transition ${
                              surface === "chat" &&
                              activeDiscussionId === discussion.id
                                ? "bg-[#EEF5FF] text-[#1F55C5] shadow-[inset_3px_0_0_#2F6FED]"
                                : "text-[#526178] hover:bg-[#F7FAFC]"
                            }`}
                            aria-current={
                              surface === "chat" &&
                              activeDiscussionId === discussion.id
                                ? "page"
                                : undefined
                            }
                            onClick={() => onDiscussion(discussion)}
                            title={`${group.label}: ${discussion.title}`}
                          >
                            <MessageSquareText size={14} className="shrink-0" />
                            <span className="line-clamp-2">
                              {discussion.title}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {normalizedQuery &&
              filteredConversations.length === 0 &&
              filteredGroups.length === 0 && (
                <p className="px-2 py-6 text-center text-xs text-[#607086]">
                  No chats or repositories match “{query}”.
                </p>
              )}

            <div className="mx-1 my-4 border-t border-[#E2E8F0]" />
            <section
              className="rounded-lg border border-[#D8DEE8] bg-[#F7FAFC] p-3"
              aria-label="BrickO status"
            >
              <div className="flex items-center gap-2.5">
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
                    className={`absolute -bottom-1 -right-1 size-3 rounded-full border-2 border-white ${toneClasses}`}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-[#10233F]">
                      BrickO
                    </span>
                    <span className="rounded-full border border-[#D8DEE8] bg-white px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-[#526178]">
                      Agent
                    </span>
                  </div>
                  <p className="truncate text-[11px] font-semibold text-[#607086]">
                    {agentState.label}
                  </p>
                </div>
              </div>
            </section>
          </nav>

          <div className="shrink-0 border-t border-[#E2E8F0] bg-[#FBFCFE] p-3">
            <div className="flex items-center gap-2 text-[11px] font-semibold text-[#42526B]">
              {connected ? (
                <Wifi size={13} className="text-[#1FA971]" />
              ) : (
                <WifiOff size={13} className="text-[#D9861C]" />
              )}
              <span>{connected ? "Chat connected" : "Chat reconnecting"}</span>
              <span className="ml-auto max-w-28 truncate text-[10px] font-normal text-[#607086]">
                {identityEmail}
              </span>
            </div>
          </div>
        </div>
      )}

      {collapsed && !mobile && (
        <button
          type="button"
          data-testid="sidebar-toggle"
          onClick={onToggle}
          className="absolute left-[18px] top-[64px] z-10 grid size-8 place-items-center rounded-md border border-[#D8DEE8] bg-white text-[#526178] shadow-sm transition hover:text-[#1F55C5]"
          aria-label="Show navigation menu"
          title="Show menu"
        >
          <Menu size={17} />
        </button>
      )}
    </div>
  );
}
