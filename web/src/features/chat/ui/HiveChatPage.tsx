import {
  GitBranch,
  Hash,
  LogOut,
  Menu,
  MessageCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  clearHiveIdentity,
  loadHiveIdentity,
  mantapLoginUrl,
} from "@/features/mantap-sso/mantap-sso-api";
import type { OneBrickGitHubRepository } from "@/features/repos/onebrick-github-api";
import {
  createRepositoryDiscussion,
  type RepositoryDiscussion,
  useRepositoryDiscussions,
} from "@/features/repos/repository-discussions-api";
import {
  type NostrSubscriptionState,
  publishEvent,
  queryEvents,
  subscribeEvents,
  type NostrEvent,
} from "@/shared/lib/nostr-client";
import {
  clearMantapBrowserIdentity,
  hasMantapBrowserIdentity,
  signNostrEvent,
} from "@/shared/lib/nostr-signer";
import { relayWsUrl } from "@/shared/lib/relay-url";
import {
  BrickOPet,
  type BrickOCelebration,
  type BrickOPetMode,
} from "./BrickOPet";
import {
  conversationsFromMessages,
  type HiveConversation,
  selectDiscussionMessages,
} from "./discussionMessages";
import { isAgentFailureMessage } from "./agentFailure";
import { HiveComposer } from "./HiveComposer";
import { HiveChatEmptyState } from "./HiveChatEmptyState";
import {
  HiveNewConversationDialog,
  HiveNewDiscussionDialog,
} from "./HiveCreateDialogs";
import { HiveNavigation } from "./HiveNavigation";
import { HiveMessage } from "./HiveMessage";
import { HiveSimpleIde } from "./HiveSimpleIde";
import { HiveWorkspaceSummary } from "./HiveWorkspaceSummary";
import { hiveUserFacingError } from "./hiveErrors";
import { HiveHeaderCollaboration, HiveThreadPanel } from "./HiveThreadPanel";
import {
  normalizePubkey,
  participantPresentation,
  useHiveParticipantDirectory,
} from "./useHiveParticipantDirectory";
import {
  celebrationForEvent,
  eventTag,
  formatMessageDay,
  type HivePresence,
  normalizePresence,
  threadRootId,
} from "./hiveMessageUtils";

const TYPING_VISIBLE_MS = 7_000;
const PET_CELEBRATION_MS = 2_400;
const SIDEBAR_STATE_STORAGE_KEY = "hive.navigation.collapsed.v1";
const OneBrickRepositoryCatalog = lazy(() =>
  import("@/features/repos/ui/OneBrickRepositoryCatalog").then((module) => ({
    default: module.OneBrickRepositoryCatalog,
  })),
);

export function HiveChatPage() {
  const identity = useMemo(loadHiveIdentity, []);
  const [messages, setMessages] = useState<NostrEvent[]>([]);
  const { agentPubkey, participants, profiles } = useHiveParticipantDirectory(
    identity,
    messages,
  );
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connection, setConnection] =
    useState<NostrSubscriptionState>("connecting");
  const [presence, setPresence] = useState<HivePresence>("unknown");
  const [typingAt, setTypingAt] = useState(0);
  const [typingVisible, setTypingVisible] = useState(false);
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [petCelebration, setPetCelebration] = useState<{
    eventId: string;
    variant: BrickOCelebration;
  } | null>(null);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [threadPanelOpen, setThreadPanelOpen] = useState(false);
  const [simpleIdeOpen, setSimpleIdeOpen] = useState(false);
  const discussions = useRepositoryDiscussions(Boolean(identity));
  const [activeDiscussionId, setActiveDiscussionId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("discussion"),
  );
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(() => new URLSearchParams(window.location.search).get("conversation"));
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [newConversationTitle, setNewConversationTitle] = useState("");
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [newDiscussionRepository, setNewDiscussionRepository] =
    useState<OneBrickGitHubRepository | null>(null);
  const [newDiscussionTitle, setNewDiscussionTitle] = useState("");
  const [creatingDiscussion, setCreatingDiscussion] = useState(false);
  const [replyTo, setReplyTo] = useState<NostrEvent | null>(null);
  const [surface, setSurface] = useState<"chat" | "repositories">(() =>
    new URLSearchParams(window.location.search).get("view") === "repositories"
      ? "repositories"
      : "chat",
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    const stored = window.localStorage.getItem(SIDEBAR_STATE_STORAGE_KEY);
    if (stored !== null) return stored === "true";
    return window.innerWidth >= 768 && window.innerWidth < 1024;
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const selectSurface = useCallback((next: "chat" | "repositories") => {
    setSurface(next);
    if (next === "repositories") setSimpleIdeOpen(false);
    setMobileNavigationOpen(false);
    const url = new URL(window.location.href);
    if (next === "repositories") url.searchParams.set("view", "repositories");
    else url.searchParams.delete("view");
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, []);
  const discussRepository = useCallback(
    (repository: OneBrickGitHubRepository) => {
      setNewDiscussionRepository(repository);
      setNewDiscussionTitle("");
    },
    [],
  );
  const openDiscussion = useCallback(
    (discussion: RepositoryDiscussion) => {
      setSimpleIdeOpen(false);
      setActiveDiscussionId(discussion.id);
      setActiveConversationId(null);
      setReplyTo(null);
      selectSurface("chat");
      const url = new URL(window.location.href);
      url.searchParams.set("discussion", discussion.id);
      url.searchParams.delete("conversation");
      window.history.replaceState(
        null,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    },
    [selectSurface],
  );
  const openGeneralConversation = useCallback(() => {
    setSimpleIdeOpen(false);
    setActiveDiscussionId(null);
    setActiveConversationId(null);
    setReplyTo(null);
    selectSurface("chat");
    const url = new URL(window.location.href);
    url.searchParams.delete("discussion");
    url.searchParams.delete("conversation");
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [selectSurface]);
  const openConversation = useCallback(
    (conversation: HiveConversation) => {
      setSimpleIdeOpen(false);
      setActiveDiscussionId(null);
      setActiveConversationId(conversation.id);
      setReplyTo(null);
      selectSurface("chat");
      const url = new URL(window.location.href);
      url.searchParams.delete("discussion");
      url.searchParams.set("conversation", conversation.id);
      window.history.replaceState(
        null,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    },
    [selectSurface],
  );
  const mergeMessage = useCallback(
    (event: NostrEvent) => {
      setMessages((current) => {
        const byId = new Map(current.map((message) => [message.id, message]));
        byId.set(event.id, event);
        return [...byId.values()].sort((a, b) => a.created_at - b.created_at);
      });
      if (
        agentPubkey &&
        normalizePubkey(event.pubkey) === normalizePubkey(agentPubkey)
      ) {
        setPetCelebration({
          eventId: event.id,
          variant: celebrationForEvent(event.id),
        });
        setPendingSince((startedAt) => {
          if (startedAt && event.created_at * 1000 >= startedAt - 2_000) {
            return null;
          }
          return startedAt;
        });
        setTypingAt(0);
      }
    },
    [agentPubkey],
  );
  const refresh = useCallback(async () => {
    if (!identity) return;
    setError("");
    try {
      const events = await queryEvents(relayWsUrl(), {
        kinds: [9],
        "#h": [identity.channelId],
        limit: 200,
      });
      setMessages(events.sort((a, b) => a.created_at - b.created_at));
    } catch (cause) {
      setError(hiveUserFacingError(cause, "load"));
    }
  }, [identity]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!identity) return;
    return subscribeEvents(
      relayWsUrl(),
      { kinds: [9], "#h": [identity.channelId] },
      (event) => {
        setError("");
        mergeMessage(event);
      },
      (cause) => setError(hiveUserFacingError(cause, "connect")),
      (state) => {
        setConnection(state);
        if (state === "connected") setError("");
      },
    );
  }, [identity, mergeMessage]);

  useEffect(() => {
    if (!identity) return;
    return subscribeEvents(
      relayWsUrl(),
      { kinds: [20002], "#h": [identity.channelId] },
      (event) => {
        if (
          agentPubkey &&
          normalizePubkey(event.pubkey) === normalizePubkey(agentPubkey)
        ) {
          setTypingAt(Date.now());
        }
      },
      () => {
        // Chat subscription owns the visible connection error state.
      },
    );
  }, [agentPubkey, identity]);

  useEffect(() => {
    if (!agentPubkey) return;
    let active = true;

    void queryEvents(relayWsUrl(), {
      kinds: [40902],
      authors: [agentPubkey],
    })
      .then((events) => {
        if (!active) return;
        const snapshot = events.find(
          (event) => eventTag(event, "p") === agentPubkey,
        );
        setPresence(snapshot ? normalizePresence(snapshot.content) : "offline");
      })
      .catch(() => {
        if (active) setPresence("unknown");
      });

    const unsubscribe = subscribeEvents(
      relayWsUrl(),
      { kinds: [20001], authors: [agentPubkey] },
      (event) => setPresence(normalizePresence(event.content)),
      () => {
        // Presence is best effort; the main connection indicator remains exact.
      },
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }, [agentPubkey]);

  useEffect(() => {
    if (!typingAt) {
      setTypingVisible(false);
      return;
    }
    setTypingVisible(true);
    const remaining = Math.max(0, typingAt + TYPING_VISIBLE_MS - Date.now());
    const timeout = window.setTimeout(() => setTypingVisible(false), remaining);
    return () => window.clearTimeout(timeout);
  }, [typingAt]);

  useEffect(() => {
    if (messages.length === 0) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!typingVisible) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [typingVisible]);

  useEffect(() => {
    if (!petCelebration) return;
    const timeout = window.setTimeout(
      () => setPetCelebration(null),
      PET_CELEBRATION_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [petCelebration]);

  useEffect(() => {
    if (!identity || !hasMantapBrowserIdentity()) {
      window.location.replace(
        mantapLoginUrl(
          `${window.location.pathname}${window.location.search}${window.location.hash}`,
        ),
      );
    }
  }, [identity]);
  useEffect(() => {
    window.localStorage.setItem(
      SIDEBAR_STATE_STORAGE_KEY,
      String(sidebarCollapsed),
    );
  }, [sidebarCollapsed]);
  useEffect(() => {
    if (!mobileNavigationOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavigationOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileNavigationOpen]);
  const discussionList = discussions.data ?? [];
  const conversationList = useMemo(
    () => conversationsFromMessages(messages),
    [messages],
  );
  const activeDiscussion =
    discussionList.find((item) => item.id === activeDiscussionId) ?? null;
  const activeConversation =
    conversationList.find((item) => item.id === activeConversationId) ?? null;
  const { activeRoot, visibleMessages } = useMemo(
    () =>
      selectDiscussionMessages(
        messages,
        activeDiscussionId,
        activeConversationId,
      ),
    [activeConversationId, activeDiscussionId, messages],
  );
  const replyAuthor = replyTo
    ? participantPresentation(
        replyTo.pubkey,
        identity?.pubkey ?? "",
        agentPubkey,
        profiles,
      ).authorLabel
    : "";
  if (!identity || !hasMantapBrowserIdentity()) return null;

  const connected = connection === "connected";
  const waiting = pendingSince !== null;
  const agentState = (() => {
    if (!connected) {
      return {
        label: connection === "connecting" ? "Connecting…" : "Reconnecting…",
        detail: "Waiting for a secure connection to Hive",
        tone: "amber" as const,
      };
    }
    if (typingVisible) {
      return {
        label: "Writing a response…",
        detail: "BrickO is coding and composing a reply",
        tone: "violet" as const,
      };
    }
    if (waiting) {
      return {
        label: "Preparing a response…",
        detail: "Your message was received and is being processed",
        tone: "violet" as const,
      };
    }
    if (presence === "online") {
      return {
        label: "Online and ready",
        detail: "BrickO is ready for the next instruction",
        tone: "emerald" as const,
      };
    }
    if (presence === "away") {
      return {
        label: "Idle",
        detail: "BrickO is still connected to the workspace",
        tone: "amber" as const,
      };
    }
    if (presence === "offline") {
      return {
        label: "Offline",
        detail: "Messages remain safely stored in the channel",
        tone: "slate" as const,
      };
    }
    return {
      label: "Checking status…",
      detail: "Hive connection is active",
      tone: "slate" as const,
    };
  })();

  const toneClasses = {
    emerald: "bg-[#1FA971] shadow-[#1FA971]/30",
    violet: "animate-pulse bg-[#2F6FED] shadow-[#2F6FED]/30",
    amber: "bg-[#D9861C] shadow-[#D9861C]/30",
    slate: "bg-[#8491A4] shadow-[#8491A4]/30",
  }[agentState.tone];

  const petMode: BrickOPetMode =
    typingVisible || waiting
      ? "thinking"
      : petCelebration
        ? "celebrate"
        : connected && presence !== "offline"
          ? "idle"
          : "offline";
  const petStatus = typingVisible
    ? "BrickO is coding and composing a response…"
    : waiting
      ? "BrickO is thinking through the next step…"
      : petCelebration?.variant === "check"
        ? "Done — BrickO gives it the all-clear."
        : petCelebration?.variant === "code"
          ? "Done — BrickO wraps up the coding session."
          : petCelebration
            ? "Done — BrickO celebrates the result."
            : connected && presence === "online"
              ? "BrickO is ready to be your coding partner."
              : connected && presence === "away"
                ? "BrickO is connected but currently idle."
                : connected
                  ? "Chat is connected; waiting for BrickO to come online."
                  : "Chat is reconnecting. Your messages and draft remain safe.";

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const content = text.trim();
    if (!content || busy) return;
    setBusy(true);
    setError("");
    try {
      const tags: string[][] = [["h", identity.channelId]];
      if (activeDiscussion) {
        tags.push(
          ["discussion", activeDiscussion.id],
          ["repo", `${activeDiscussion.owner}/${activeDiscussion.repository}`],
          ["worktree", activeDiscussion.worktreeId],
          ["branch", activeDiscussion.branchRef],
          ["head", activeDiscussion.currentHeadSha],
        );
        const rootId = activeRoot?.id;
        if (rootId) {
          tags.push(["e", rootId, "", "root"]);
          tags.push(["e", replyTo?.id ?? rootId, "", "reply"]);
        }
      } else if (activeConversation) {
        tags.push(["conversation", activeConversation.id]);
        if (replyTo) {
          const replyRoot = threadRootId(replyTo);
          tags.push(["e", replyRoot, "", "root"]);
          tags.push(["e", replyTo.id, "", "reply"]);
        }
      }
      const signed = await signNostrEvent({
        kind: 9,
        tags,
        content,
      });
      await publishEvent(relayWsUrl(), signed);
      mergeMessage(signed);
      setPendingSince(Date.now());
      setText("");
      setReplyTo(null);
      composerRef.current?.focus();
    } catch (cause) {
      setError(hiveUserFacingError(cause, "send"));
    } finally {
      setBusy(false);
    }
  };

  const submitNewDiscussion = async (event: FormEvent) => {
    event.preventDefault();
    const repository = newDiscussionRepository;
    const title = newDiscussionTitle.trim();
    if (!repository || !title || creatingDiscussion) return;
    setCreatingDiscussion(true);
    setError("");
    try {
      const discussion = await createRepositoryDiscussion({
        owner: repository.owner,
        repository: repository.name,
        title,
        defaultBranch: repository.default_branch,
      });
      await discussions.refetch();
      setNewDiscussionRepository(null);
      openDiscussion(discussion);
      setText(
        `@BrickO ${title}\n\nRepository: ${repository.owner}/${repository.name}\nBase: ${discussion.baseRef} at ${discussion.baseSha.slice(0, 12)}`,
      );
      requestAnimationFrame(() => composerRef.current?.focus());
    } catch (cause) {
      setError(hiveUserFacingError(cause, "create"));
    } finally {
      setCreatingDiscussion(false);
    }
  };

  const submitNewConversation = async (event: FormEvent) => {
    event.preventDefault();
    const title = newConversationTitle.trim();
    if (!title || creatingConversation || !identity) return;
    setCreatingConversation(true);
    setError("");
    try {
      const conversation: HiveConversation = {
        createdAt: Math.floor(Date.now() / 1000),
        id: crypto.randomUUID(),
        title,
      };
      const signed = await signNostrEvent({
        kind: 9,
        tags: [
          ["h", identity.channelId],
          ["conversation", conversation.id],
          ["conversation-meta", "1"],
          ["title", conversation.title],
        ],
        content: "",
      });
      await publishEvent(relayWsUrl(), signed);
      mergeMessage(signed);
      setNewConversationOpen(false);
      setNewConversationTitle("");
      openConversation(conversation);
      setText("@BrickO ");
      requestAnimationFrame(() => composerRef.current?.focus());
    } catch (cause) {
      setError(hiveUserFacingError(cause, "create"));
    } finally {
      setCreatingConversation(false);
    }
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const logout = () => {
    clearHiveIdentity();
    clearMantapBrowserIdentity();
    window.location.replace("/app");
  };

  let previousDay = "";

  return (
    <div className="flex h-dvh overflow-hidden bg-white text-[#172033] selection:bg-[#FF6F52]/20">
      <aside
        data-testid="desktop-navigation"
        className={`relative hidden shrink-0 flex-col border-r border-[#D8DEE8] bg-white transition-[width] duration-150 md:flex ${
          sidebarCollapsed ? "w-[68px]" : "w-[352px]"
        }`}
      >
        <HiveNavigation
          activeConversationId={activeConversationId}
          activeDiscussionId={activeDiscussionId}
          agentState={agentState}
          collapsed={sidebarCollapsed}
          connected={connected}
          conversations={conversationList}
          discussions={discussionList}
          identityEmail={identity.email}
          onConversation={openConversation}
          onDiscussion={openDiscussion}
          onGeneral={openGeneralConversation}
          onNewConversation={() => {
            setNewConversationTitle("");
            setNewConversationOpen(true);
          }}
          onRepositories={() => selectSurface("repositories")}
          onToggle={() => setSidebarCollapsed((current) => !current)}
          surface={surface}
          toneClasses={toneClasses}
        />
      </aside>

      {mobileNavigationOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            data-testid="mobile-navigation-backdrop"
            className="absolute inset-0 bg-[#10213F]/35 backdrop-blur-[1px]"
            onClick={() => setMobileNavigationOpen(false)}
            aria-label="Close navigation menu"
          />
          <aside
            data-testid="mobile-navigation"
            className="relative flex h-full w-[min(320px,90vw)] flex-col border-r border-[#D8DEE8] bg-white shadow-[16px_0_40px_rgba(16,35,63,0.18)]"
          >
            <HiveNavigation
              activeConversationId={activeConversationId}
              activeDiscussionId={activeDiscussionId}
              agentState={agentState}
              collapsed={false}
              connected={connected}
              conversations={conversationList}
              discussions={discussionList}
              identityEmail={identity.email}
              mobile
              onConversation={openConversation}
              onDiscussion={openDiscussion}
              onGeneral={openGeneralConversation}
              onNewConversation={() => {
                setNewConversationTitle("");
                setNewConversationOpen(true);
                setMobileNavigationOpen(false);
              }}
              onRepositories={() => selectSurface("repositories")}
              onToggle={() => setMobileNavigationOpen(false)}
              surface={surface}
              toneClasses={toneClasses}
            />
          </aside>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col bg-white">
        <header className="z-10 flex h-14 shrink-0 items-center justify-between border-b border-[#D8DEE8] bg-white px-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              data-testid="mobile-navigation-open"
              onClick={() => setMobileNavigationOpen(true)}
              className="grid size-8 shrink-0 place-items-center rounded border border-[#FF6F52] bg-[#FF6F52] text-white shadow-[0_6px_14px_rgba(255,111,82,0.22)] transition hover:bg-[#E35E43] md:hidden"
              aria-label="Open navigation menu"
            >
              <Menu size={17} />
            </button>
            <span className="text-base font-extrabold tracking-[-0.03em] text-[#10233F] md:hidden">
              Hive
            </span>
            <div className="hidden min-w-0 sm:block">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-[15px] font-bold text-[#10233F]">
                  {surface === "repositories"
                    ? "Repositories"
                    : (activeDiscussion?.title ??
                      activeConversation?.title ??
                      "bricko-lab")}
                </h1>
                <span
                  className={`size-2 rounded-full shadow-sm ${toneClasses}`}
                />
                <span className="hidden truncate text-xs font-medium text-[#526178] sm:inline">
                  {agentState.label}
                </span>
              </div>
              <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[#607086]">
                {surface === "repositories" ? (
                  <>
                    <GitBranch size={10} /> BrickO-Brick
                  </>
                ) : activeDiscussion ? (
                  <>
                    <GitBranch size={10} /> {activeDiscussion.owner}/
                    {activeDiscussion.repository}
                    <span className="text-[#B6C0CE]">•</span>
                    <span>
                      {activeDiscussion.branchRef.replace("refs/heads/", "")}
                    </span>
                  </>
                ) : activeConversation ? (
                  <>
                    <MessageCircle size={10} /> Group chat
                  </>
                ) : (
                  <>
                    <Hash size={10} /> bricko-lab
                  </>
                )}
                <span className="text-[#B6C0CE]">•</span>
                <ShieldCheck size={10} /> private
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {surface === "chat" && (
              <HiveHeaderCollaboration
                onThreads={() => setThreadPanelOpen((current) => !current)}
                participants={participants}
                threadCount={
                  visibleMessages.filter((message) =>
                    message.tags.some(
                      (tag) =>
                        tag[0] === "e" &&
                        (tag[3] === "root" || tag[3] === "reply"),
                    ),
                  ).length
                }
              />
            )}
            <div className="flex items-center overflow-hidden rounded border border-[#D8DEE8] bg-white">
              <div className="hidden min-h-9 items-center gap-2 border-r border-[#D8DEE8] px-3 2xl:flex">
                <div className="grid size-6 place-items-center rounded-full bg-[#10213F] text-[9px] font-extrabold text-white">
                  {identity.email.slice(0, 2).toUpperCase()}
                </div>
                <span className="max-w-40 truncate text-[11px] font-semibold text-[#42526B]">
                  {identity.email}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void refresh()}
                className="grid size-9 place-items-center text-[#526178] transition hover:bg-[#F7FAFC] hover:text-[#FF6F52]"
                aria-label="Refresh"
              >
                <RefreshCw size={15} />
              </button>
              <button
                type="button"
                onClick={logout}
                className="grid size-9 place-items-center border-l border-[#D8DEE8] text-[#526178] transition hover:bg-[#F7FAFC] hover:text-[#C93F4A]"
                aria-label="Sign out"
              >
                <LogOut size={15} />
              </button>
            </div>
          </div>
        </header>

        {surface === "repositories" ? (
          <section className="min-h-0 flex-1 overflow-y-auto bg-[#F7FAFC]">
            <Suspense
              fallback={
                <div className="grid min-h-full place-items-center text-sm text-[#607086]">
                  Loading repository catalog…
                </div>
              }
            >
              <OneBrickRepositoryCatalog onDiscuss={discussRepository} />
            </Suspense>
          </section>
        ) : activeDiscussion && simpleIdeOpen ? (
          <HiveSimpleIde
            discussion={activeDiscussion}
            onClose={() => setSimpleIdeOpen(false)}
            onCommitted={() => void discussions.refetch()}
          />
        ) : (
          <>
            <div
              className="mx-3 mt-2 flex min-h-12 shrink-0 items-center gap-2.5 rounded-lg border border-[#FFD3C9] bg-[#FFF8F5] px-3 py-1.5 sm:mx-5"
              aria-live="polite"
              data-testid="bricko-status-banner"
            >
              <div className="relative grid size-9 shrink-0 place-items-center">
                <BrickOPet
                  celebration={petCelebration?.variant ?? "sparkle"}
                  key={petCelebration?.eventId ?? petMode}
                  label={petStatus}
                  mode={petMode}
                  size="sm"
                  testId="bricko-status-pet"
                />
                <span
                  className={`absolute bottom-0 right-0 size-3 rounded-full border-2 border-white shadow-sm ${toneClasses}`}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-bold text-[#10233F]">
                  {agentState.label}
                </div>
                <div className="mt-0.5 truncate text-xs text-[#526178]">
                  {petStatus}
                </div>
              </div>
              {connected && (waiting || typingVisible) && (
                <div className="flex gap-1" aria-hidden="true">
                  {[0, 1, 2].map((dot) => (
                    <span
                      key={dot}
                      className="size-1.5 animate-bounce rounded-full bg-[#FF6F52]"
                      style={{ animationDelay: `${dot * 120}ms` }}
                    />
                  ))}
                </div>
              )}
            </div>

            <section className="min-h-0 flex-1 overflow-y-auto bg-[#F7FAFC] px-3 pb-6 pt-4 sm:px-5">
              <div className="mx-auto max-w-4xl">
                {activeDiscussion && (
                  <HiveWorkspaceSummary
                    discussion={activeDiscussion}
                    hasRoot={Boolean(activeRoot)}
                    onOpenEditor={() => setSimpleIdeOpen(true)}
                  />
                )}
                {visibleMessages.length === 0 &&
                  !error &&
                  !activeDiscussion && (
                    <HiveChatEmptyState conversation={activeConversation} />
                  )}

                {visibleMessages.map((message, index) => {
                  const { authorLabel, fromBrickO, mine } =
                    participantPresentation(
                      message.pubkey,
                      identity.pubkey,
                      agentPubkey,
                      profiles,
                    );
                  const day = formatMessageDay(message.created_at);
                  const showDay = day !== previousDay;
                  const retryTarget =
                    fromBrickO && isAgentFailureMessage(message.content)
                      ? visibleMessages
                          .slice(0, index)
                          .reverse()
                          .find(
                            (candidate) =>
                              normalizePubkey(candidate.pubkey) ===
                              normalizePubkey(identity.pubkey),
                          )
                      : undefined;
                  previousDay = day;
                  return (
                    <HiveMessage
                      key={message.id}
                      authorLabel={authorLabel}
                      day={day}
                      fromBrickO={fromBrickO}
                      message={message}
                      mine={mine}
                      onReply={
                        activeDiscussion || activeConversation
                          ? () => {
                              setReplyTo(message);
                              requestAnimationFrame(() =>
                                composerRef.current?.focus(),
                              );
                            }
                          : undefined
                      }
                      onRestoreRequest={
                        retryTarget
                          ? () => {
                              setText(retryTarget.content);
                              setReplyTo(retryTarget);
                              requestAnimationFrame(() =>
                                composerRef.current?.focus(),
                              );
                            }
                          : undefined
                      }
                      showDay={showDay}
                    />
                  );
                })}

                {typingVisible && (
                  <div
                    className="mb-5 flex items-end gap-2.5"
                    aria-live="polite"
                  >
                    <div className="size-8 shrink-0" aria-hidden="true" />
                    <div>
                      <div className="mb-1.5 px-1 text-[11px] font-bold text-[#42526B]">
                        BrickO
                      </div>
                      <div className="flex h-11 items-center gap-1 rounded border border-[#D8DEE8] bg-white px-4">
                        {[0, 1, 2].map((dot) => (
                          <span
                            key={dot}
                            className="size-1.5 animate-bounce rounded-full bg-[#FF6F52]"
                            style={{ animationDelay: `${dot * 120}ms` }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </section>

            <HiveComposer
              activeDiscussion={activeDiscussion}
              busy={busy}
              composerRef={composerRef}
              connected={connected}
              error={error}
              onCancelReply={() => setReplyTo(null)}
              onChange={setText}
              onKeyDown={handleComposerKeyDown}
              onSubmit={send}
              participants={participants}
              replyAuthor={replyAuthor}
              replyTo={replyTo}
              text={text}
            />
          </>
        )}
      </main>
      {threadPanelOpen && surface === "chat" && (
        <HiveThreadPanel
          agentPubkey={agentPubkey}
          identityPubkey={identity.pubkey}
          messages={visibleMessages}
          onClose={() => setThreadPanelOpen(false)}
          onReply={(message) => {
            setReplyTo(message);
            requestAnimationFrame(() => composerRef.current?.focus());
          }}
          profiles={profiles}
        />
      )}
      {newConversationOpen && (
        <HiveNewConversationDialog
          busy={creatingConversation}
          error={error}
          onChange={setNewConversationTitle}
          onClose={() => setNewConversationOpen(false)}
          onSubmit={submitNewConversation}
          title={newConversationTitle}
        />
      )}
      {newDiscussionRepository && (
        <HiveNewDiscussionDialog
          busy={creatingDiscussion}
          error={error}
          onChange={setNewDiscussionTitle}
          onClose={() => setNewDiscussionRepository(null)}
          onSubmit={submitNewDiscussion}
          repository={newDiscussionRepository}
          title={newDiscussionTitle}
        />
      )}
    </div>
  );
}
