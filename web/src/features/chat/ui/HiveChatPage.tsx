import {
  CircleAlert,
  GitBranch,
  Hash,
  LogOut,
  Menu,
  MessageCircle,
  RefreshCw,
  ShieldCheck,
  Wifi,
  WifiOff,
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
  queryEventsHttp,
  subscribeEvents,
  type NostrEvent,
} from "@/shared/lib/nostr-client";
import {
  clearMantapBrowserIdentity,
  hasMantapBrowserIdentity,
  signNostrEvent,
} from "@/shared/lib/nostr-signer";
import { relayWsUrl } from "@/shared/lib/relay-url";
import type { BrickOCelebration } from "./BrickOPet";
import { deriveBrickOStatus } from "./brickOStatus";
import type { HiveConversation } from "./discussionMessages";
import { isAgentFailureMessage } from "./agentFailure";
import { HiveComposer } from "./HiveComposer";
import { HiveChatEmptyState } from "./HiveChatEmptyState";
import { HiveBrickOStatusBanner } from "./HiveBrickOStatusBanner";
import {
  HiveNewConversationDialog,
  HiveNewDiscussionDialog,
} from "./HiveCreateDialogs";
import { HiveNavigation } from "./HiveNavigation";
import { HiveResizableNavigation } from "./HiveResizableNavigation";
import { HiveHistoryPagination } from "./HiveHistoryPagination";
import { HiveMessage } from "./HiveMessage";
import { HiveSimpleIde } from "./HiveSimpleIde";
import { HiveUnavailableConversation } from "./HiveUnavailableConversation";
import { HiveWorkspaceSummary } from "./HiveWorkspaceSummary";
import {
  createPrivateChat,
  loadPrivateChats,
  togglePrivateChatParticipant,
} from "./hivePrivateChats";
import { hiveUserFacingError } from "./hiveErrors";
import {
  groupConversationThreads,
  HiveHeaderCollaboration,
  HiveThreadPanel,
} from "./HiveThreadPanel";
import {
  normalizePubkey,
  messageAuthorLabel,
  participantPresentation,
  participantsInPrivateChat,
  privateChatIncludes,
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
import { useHiveChatHistory } from "./useHiveChatHistory";
import { useCloseOnEscape } from "./useCloseOnEscape";
import { useHiveVisibleMessages } from "./useHiveVisibleMessages";

const TYPING_VISIBLE_MS = 7_000;
const PET_CELEBRATION_MS = 2_400;
const OneBrickRepositoryCatalog = lazy(() =>
  import("@/features/repos/ui/OneBrickRepositoryCatalog").then((module) => ({
    default: module.OneBrickRepositoryCatalog,
  })),
);

export function HiveChatPage() {
  const identity = useMemo(loadHiveIdentity, []);
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
  const [newConversationParticipants, setNewConversationParticipants] =
    useState<Set<string>>(() => new Set());
  const [conversationList, setConversationList] = useState<HiveConversation[]>(
    [],
  );
  const [conversationsLoading, setConversationsLoading] = useState(true);
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const discussionList = discussions.data ?? [];
  const activeDiscussion =
    discussionList.find((item) => item.id === activeDiscussionId) ?? null;
  const activeConversation =
    conversationList.find((item) => item.id === activeConversationId) ?? null;
  const discussionRouteUnresolved = Boolean(
    activeDiscussionId && !activeDiscussion,
  );
  const conversationRouteUnresolved = Boolean(
    activeConversationId && !activeConversation,
  );
  const activeChannelId = activeConversationId
    ? (activeConversation?.id ?? null)
    : (identity?.channelId ?? null);
  const {
    hasOlder: historyHasOlder,
    lastLiveEvent,
    loadOlder: loadOlderMessages,
    loading: historyLoading,
    loadingOlder: historyLoadingOlder,
    mergeMessage,
    messages,
    refresh,
  } = useHiveChatHistory({
    activeChannelId,
    messagesEndRef,
    setConnection,
    setError,
  });
  const { agentPubkey, participants, profiles } = useHiveParticipantDirectory(
    identity,
    messages,
  );
  const selectSurface = useCallback((next: "chat" | "repositories") => {
    setSurface(next);
    if (next === "repositories") {
      setSimpleIdeOpen(false);
      setThreadPanelOpen(false);
    }
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
      setTypingAt(0);
      setThreadPanelOpen(false);
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
    setTypingAt(0);
    setThreadPanelOpen(false);
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
      setTypingAt(0);
      setThreadPanelOpen(false);
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
  const openNewConversationDialog = useCallback(() => {
    setNewConversationTitle("");
    setNewConversationParticipants(new Set());
    setNewConversationOpen(true);
  }, []);
  const refreshConversations = useCallback(async () => {
    if (!identity) return;
    setConversationsLoading(true);
    try {
      setConversationList(await loadPrivateChats(identity.pubkey));
    } catch (cause) {
      setError(hiveUserFacingError(cause, "load"));
    } finally {
      setConversationsLoading(false);
    }
  }, [identity]);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  useEffect(() => {
    if (
      !lastLiveEvent ||
      !agentPubkey ||
      normalizePubkey(lastLiveEvent.pubkey) !== normalizePubkey(agentPubkey)
    ) {
      return;
    }
    setPetCelebration({
      eventId: lastLiveEvent.id,
      variant: celebrationForEvent(lastLiveEvent.id),
    });
    setPendingSince((startedAt) =>
      startedAt && lastLiveEvent.created_at * 1000 >= startedAt - 2_000
        ? null
        : startedAt,
    );
    setTypingAt(0);
  }, [agentPubkey, lastLiveEvent]);

  useEffect(() => {
    if (!activeChannelId) return;
    return subscribeEvents(
      relayWsUrl(),
      { kinds: [20002], "#h": [activeChannelId] },
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
  }, [activeChannelId, agentPubkey]);

  useEffect(() => {
    if (!agentPubkey) return;
    let active = true;

    void queryEventsHttp([
      {
        kinds: [40902],
        authors: [agentPubkey],
      },
    ])
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
  useCloseOnEscape(mobileNavigationOpen, setMobileNavigationOpen);
  useCloseOnEscape(threadPanelOpen, setThreadPanelOpen);
  const { activeRoot, visibleMessages } = useHiveVisibleMessages({
    activeConversation,
    activeConversationId,
    activeDiscussion,
    activeDiscussionId,
    messages,
  });
  const replyAuthor = messageAuthorLabel(
    replyTo,
    identity?.pubkey ?? "",
    agentPubkey,
    profiles,
  );
  const visibleParticipants = participantsInPrivateChat(
    participants,
    activeConversation?.participantPubkeys,
  );
  const conversationHasAgent = privateChatIncludes(
    activeConversation?.participantPubkeys,
    agentPubkey,
  );
  if (!identity || !hasMantapBrowserIdentity()) return null;

  const connected = connection === "connected";
  const waiting = pendingSince !== null;
  const { agentState, petMode, petStatus, toneClasses } = deriveBrickOStatus({
    celebration: petCelebration?.variant ?? null,
    connected,
    connection,
    presence,
    typing: typingVisible,
    waiting,
  });

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const content = text.trim();
    if (!content || busy) return;
    if (activeDiscussionId && !activeDiscussion) {
      setError(
        "This repository discussion is not available. Return to bricko-lab or refresh the discussion before sending.",
      );
      return;
    }
    if (activeConversationId && !activeConversation) {
      setError(
        "This private chat is not available. Return to bricko-lab or refresh your chats before sending.",
      );
      return;
    }
    if (!activeChannelId) return;
    setBusy(true);
    setError("");
    try {
      const tags: string[][] = [["h", activeChannelId]];
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
      if (!activeConversation || conversationHasAgent) {
        setPendingSince(Date.now());
      }
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
    const participantPubkeys = [...newConversationParticipants];
    if (
      !title ||
      participantPubkeys.length === 0 ||
      participantPubkeys.length > 8 ||
      creatingConversation ||
      !identity
    ) {
      return;
    }
    setCreatingConversation(true);
    setError("");
    try {
      const conversation = await createPrivateChat({
        currentPubkey: identity.pubkey,
        participantPubkeys,
        title,
      });
      setConversationList((current) => [
        conversation,
        ...current.filter((item) => item.id !== conversation.id),
      ]);
      setNewConversationOpen(false);
      setNewConversationTitle("");
      setNewConversationParticipants(new Set());
      openConversation(conversation);
      setText(
        agentPubkey &&
          participantPubkeys.some(
            (pubkey) =>
              normalizePubkey(pubkey) === normalizePubkey(agentPubkey),
          )
          ? "@BrickO "
          : "",
      );
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
      <HiveResizableNavigation
        activeConversationId={activeConversationId}
        activeDiscussionId={activeDiscussionId}
        agentState={agentState}
        connected={connected}
        conversations={conversationList}
        discussions={discussionList}
        identityEmail={identity.email}
        onConversation={openConversation}
        onDiscussion={openDiscussion}
        onGeneral={openGeneralConversation}
        onNewConversation={openNewConversationDialog}
        onRepositories={() => selectSurface("repositories")}
        surface={surface}
        toneClasses={toneClasses}
      />

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
                openNewConversationDialog();
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

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-white">
        <header className="z-10 flex h-14 shrink-0 items-center justify-between gap-2 overflow-hidden border-b border-[#D8DEE8] bg-white px-3 sm:px-5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
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
            <div className="hidden min-w-0 flex-1 overflow-hidden sm:block">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="min-w-0 truncate text-[15px] font-bold text-[#10233F]">
                  {surface === "repositories"
                    ? "Repositories"
                    : discussionRouteUnresolved || conversationRouteUnresolved
                      ? discussions.isLoading || conversationsLoading
                        ? "Loading conversation…"
                        : "Conversation unavailable"
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
              <p className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[10px] text-[#607086]">
                {surface === "repositories" ? (
                  <>
                    <GitBranch size={10} /> BrickO-Brick
                  </>
                ) : discussionRouteUnresolved ? (
                  <>
                    <CircleAlert size={10} /> Repository discussion
                  </>
                ) : conversationRouteUnresolved ? (
                  <>
                    <CircleAlert size={10} /> Private chat
                  </>
                ) : activeDiscussion ? (
                  <>
                    <GitBranch size={10} /> {activeDiscussion.owner}/
                    {activeDiscussion.repository}
                    <span className="text-[#B6C0CE]">•</span>
                    <span className="truncate">
                      {activeDiscussion.branchRef.replace("refs/heads/", "")}
                    </span>
                  </>
                ) : activeConversation ? (
                  <>
                    <MessageCircle size={10} /> Private chat
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
          <div className="flex shrink-0 items-center gap-2 lg:gap-3">
            <div
              className="hidden items-center gap-1.5 text-xs font-semibold text-[#42526B] sm:flex"
              aria-live="polite"
              data-testid="header-connection-status"
            >
              {connected ? (
                <Wifi size={14} className="text-[#1FA971]" />
              ) : (
                <WifiOff size={14} className="text-[#D9861C]" />
              )}
              <span>{connected ? "Chat connected" : "Chat reconnecting"}</span>
            </div>
            {surface === "chat" && (
              <HiveHeaderCollaboration
                onThreads={() => setThreadPanelOpen((current) => !current)}
                participants={visibleParticipants}
                threadCount={groupConversationThreads(visibleMessages).length}
                threadsOpen={threadPanelOpen}
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
            <HiveBrickOStatusBanner
              agentState={agentState}
              celebration={petCelebration?.variant ?? null}
              connected={connected}
              petMode={petMode}
              petStatus={petStatus}
              toneClasses={toneClasses}
              typing={typingVisible}
              waiting={waiting}
            />

            {discussions.isError && !activeDiscussionId && (
              <div
                className="mx-3 mt-2 flex items-center justify-between gap-3 rounded-lg border border-[#F3C7C9] bg-[#FFF3F4] px-3 py-2 text-xs text-[#8F2F3A] sm:mx-5"
                role="alert"
              >
                <span>
                  Repository discussions could not be loaded. Chats remain
                  available, but repository workspaces may be missing from the
                  navigation.
                </span>
                <button
                  type="button"
                  className="shrink-0 rounded border border-[#E6AEB3] bg-white px-2.5 py-1.5 font-bold hover:bg-[#FFF8F8]"
                  onClick={() => void discussions.refetch()}
                >
                  Retry
                </button>
              </div>
            )}

            <section className="min-h-0 flex-1 overflow-y-auto bg-[#F7FAFC] px-3 pb-6 pt-4 sm:px-5">
              <div className="mx-auto max-w-4xl">
                {discussionRouteUnresolved && (
                  <HiveUnavailableConversation
                    kind="repository-discussion"
                    loading={discussions.isLoading}
                    loadFailed={discussions.isError}
                    onRetry={() => void discussions.refetch()}
                    onReturn={openGeneralConversation}
                    onBrowseRepositories={() => {
                      openGeneralConversation();
                      selectSurface("repositories");
                    }}
                  />
                )}
                {conversationRouteUnresolved && (
                  <HiveUnavailableConversation
                    kind="private-chat"
                    loading={conversationsLoading}
                    onRetry={() => void refreshConversations()}
                    onReturn={openGeneralConversation}
                  />
                )}
                {!discussionRouteUnresolved &&
                  !conversationRouteUnresolved &&
                  (historyHasOlder || historyLoadingOlder) && (
                    <HiveHistoryPagination
                      loading={historyLoadingOlder}
                      onLoadOlder={() => void loadOlderMessages()}
                    />
                  )}
                {activeDiscussion && (
                  <HiveWorkspaceSummary
                    discussion={activeDiscussion}
                    hasRoot={Boolean(activeRoot)}
                    onOpenEditor={() => {
                      setThreadPanelOpen(false);
                      setSimpleIdeOpen(true);
                    }}
                  />
                )}
                {visibleMessages.length === 0 &&
                  !error &&
                  !historyLoading &&
                  !activeDiscussionId &&
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

            {discussionRouteUnresolved || conversationRouteUnresolved ? (
              <div className="shrink-0 border-t border-[#D8DEE8] bg-[#F7FAFC] px-4 py-4 text-center text-xs font-semibold text-[#607086]">
                Sending is disabled until this conversation is restored.
              </div>
            ) : (
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
                participants={visibleParticipants}
                replyAuthor={replyAuthor}
                replyTo={replyTo}
                text={text}
              />
            )}
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
          onClose={() => {
            setNewConversationOpen(false);
            setNewConversationParticipants(new Set());
          }}
          onToggleParticipant={(pubkey) => {
            setNewConversationParticipants((current) =>
              togglePrivateChatParticipant(current, pubkey),
            );
          }}
          onSubmit={submitNewConversation}
          participants={participants}
          selectedPubkeys={newConversationParticipants}
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
