import {
  CheckCircle2,
  Clock3,
  GitBranch,
  Hash,
  LogOut,
  Menu,
  PanelLeftClose,
  RefreshCw,
  Send,
  ShieldCheck,
  Wifi,
  WifiOff,
  X,
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
import hiveLogoUrl from "@/assets/hive-logo.svg";
import brickoOperationsUrl from "@/assets/bricko-operations.jpg";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  clearHiveIdentity,
  loadHiveIdentity,
} from "@/features/mantap-sso/mantap-sso-api";
import type { OneBrickGitHubRepository } from "@/features/repos/onebrick-github-api";
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

type Presence = "online" | "away" | "offline" | "unknown";

const TYPING_VISIBLE_MS = 7_000;
const PET_CELEBRATION_MS = 2_400;
const SIDEBAR_STATE_STORAGE_KEY = "hive.navigation.collapsed.v1";

const OneBrickRepositoryCatalog = lazy(() =>
  import("@/features/repos/ui/OneBrickRepositoryCatalog").then((module) => ({
    default: module.OneBrickRepositoryCatalog,
  })),
);

function celebrationForEvent(eventId: string): BrickOCelebration {
  const variants: BrickOCelebration[] = ["sparkle", "check", "code"];
  const fingerprint = [...eventId].reduce(
    (sum, character) => sum + character.charCodeAt(0),
    0,
  );
  return variants[fingerprint % variants.length] ?? "sparkle";
}

function eventTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

function normalizePresence(value: string): Presence {
  if (value === "online" || value === "away" || value === "offline") {
    return value;
  }
  return "unknown";
}

function formatMessageTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
}

function formatMessageDay(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(timestamp * 1000));
}

export function HiveChatPage() {
  const identity = useMemo(loadHiveIdentity, []);
  const [messages, setMessages] = useState<NostrEvent[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connection, setConnection] =
    useState<NostrSubscriptionState>("connecting");
  const [presence, setPresence] = useState<Presence>("unknown");
  const [typingAt, setTypingAt] = useState(0);
  const [typingVisible, setTypingVisible] = useState(false);
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [petCelebration, setPetCelebration] = useState<{
    eventId: string;
    variant: BrickOCelebration;
  } | null>(null);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
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
      selectSurface("chat");
      setText(
        `@BrickO let's start a new discussion about ${repository.owner}/${repository.name}. Focus this topic on: `,
      );
      requestAnimationFrame(() => composerRef.current?.focus());
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
      if (identity && event.pubkey !== identity.pubkey) {
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
    [identity],
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
      setError(
        cause instanceof Error ? cause.message : "Unable to load messages.",
      );
    }
  }, [identity]);

  const agentPubkey = useMemo(() => {
    if (!identity) return null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.pubkey !== identity.pubkey) {
        return messages[index]?.pubkey ?? null;
      }
    }
    return null;
  }, [identity, messages]);

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
      (cause) => setError(cause.message),
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
        if (event.pubkey !== identity.pubkey) setTypingAt(Date.now());
      },
      () => {
        // Chat subscription owns the visible connection error state.
      },
    );
  }, [identity]);

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
      window.location.replace("https://mantap.onebrick.io");
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
        : connected
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
            : connected
              ? "BrickO is ready to be your coding partner."
              : "BrickO is waiting for the connection to return.";

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const content = text.trim();
    if (!content || busy) return;
    setBusy(true);
    setError("");
    try {
      const signed = await signNostrEvent({
        kind: 9,
        tags: [["h", identity.channelId]],
        content,
      });
      await publishEvent(relayWsUrl(), signed);
      mergeMessage(signed);
      setPendingSince(Date.now());
      setText("");
      composerRef.current?.focus();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to send message.",
      );
    } finally {
      setBusy(false);
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

  const navigationPanel = (collapsed: boolean, mobile = false) => (
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
          onClick={() =>
            mobile
              ? setMobileNavigationOpen(false)
              : setSidebarCollapsed((current) => !current)
          }
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
          className={`flex h-9 w-full items-center rounded border ${
            surface === "chat"
              ? "border-[#BFD4FF] bg-[#EEF5FF] text-[#1F55C5] shadow-[inset_3px_0_0_#2F6FED]"
              : "border-transparent text-[#526178] hover:bg-[#F7FAFC]"
          } ${collapsed ? "justify-center px-0" : "gap-2 px-2.5"}`}
          aria-current={surface === "chat" ? "page" : undefined}
          onClick={() => selectSurface("chat")}
          title="bricko-lab"
        >
          <Hash size={15} className="shrink-0" />
          {!collapsed && (
            <span className="min-w-0 flex-1 truncate text-left text-[13px] font-bold">
              bricko-lab
            </span>
          )}
        </button>

        {!collapsed && (
          <div className="mb-2 mt-5 px-1 text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#607086]">
            Workspace
          </div>
        )}
        <button
          type="button"
          className={`flex h-9 w-full items-center rounded border ${
            surface === "repositories"
              ? "border-[#FFD3C9] bg-[#FFF1EB] text-[#D95336] shadow-[inset_3px_0_0_#FF6F52]"
              : "border-transparent text-[#526178] hover:bg-[#F7FAFC]"
          } ${collapsed ? "justify-center px-0" : "gap-2 px-2.5"}`}
          aria-current={surface === "repositories" ? "page" : undefined}
          data-testid="open-github-repositories"
          onClick={() => selectSurface("repositories")}
          title="Repositories"
        >
          <GitBranch size={15} className="shrink-0" />
          {!collapsed && (
            <span className="min-w-0 flex-1 truncate text-left text-[13px] font-bold">
              Repositories
            </span>
          )}
        </button>

        {!collapsed && (
          <div className="mb-2 mt-5 px-1 text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#607086]">
            Agent activity
          </div>
        )}
        <section
          className={`mt-2 rounded border border-[#D8DEE8] bg-[#F7FAFC] ${
            collapsed ? "grid h-10 place-items-center p-0" : "p-3"
          }`}
          aria-label="BrickO status"
          title={
            collapsed ? `${agentState.label} — ${agentState.detail}` : undefined
          }
        >
          <div className={`flex items-start ${collapsed ? "" : "gap-2.5"}`}>
            <div className="relative size-8 shrink-0">
              <BrickOPet mode="still" size="sm" />
              <span
                className={`absolute -bottom-1 -right-1 size-3 rounded-full border-2 border-white shadow-sm ${toneClasses}`}
              />
            </div>
            {!collapsed && (
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
            collapsed ? "grid h-9 place-items-center" : "p-2.5"
          }`}
          title={connected ? "Realtime connected" : "Connecting"}
        >
          <div
            className={`flex items-center text-[11px] font-semibold text-[#42526B] ${
              collapsed ? "justify-center" : "gap-2"
            }`}
          >
            {connected ? (
              <Wifi size={13} className="text-[#1FA971]" />
            ) : (
              <WifiOff size={13} className="text-[#D9861C]" />
            )}
            {!collapsed && (connected ? "Realtime connected" : "Connecting")}
          </div>
          {!collapsed && (
            <div className="mt-2 truncate border-t border-[#E2E8F0] pt-2 text-[10px] text-[#607086]">
              {identity.email}
            </div>
          )}
        </div>
      </div>
    </>
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-white text-[#172033] selection:bg-[#FF6F52]/20">
      <aside
        data-testid="desktop-navigation"
        className={`hidden shrink-0 flex-col border-r border-[#D8DEE8] bg-white transition-[width] duration-150 md:flex ${
          sidebarCollapsed ? "w-[52px]" : "w-[200px]"
        }`}
      >
        {navigationPanel(sidebarCollapsed)}
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
            className="relative flex h-full w-[min(280px,86vw)] flex-col border-r border-[#D8DEE8] bg-white shadow-[16px_0_40px_rgba(16,35,63,0.18)]"
          >
            {navigationPanel(false, true)}
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
            <img
              src={hiveLogoUrl}
              alt="Hive"
              className="h-auto w-[104px] shrink-0 md:hidden"
            />
            {sidebarCollapsed && (
              <img
                src={hiveLogoUrl}
                alt="Hive"
                className="hidden h-auto w-[104px] shrink-0 md:block"
              />
            )}
            <div className="hidden min-w-0 sm:block">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-[15px] font-bold text-[#10233F]">
                  {surface === "repositories" ? "Repositories" : "Hive"}
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
          <div className="flex items-center overflow-hidden rounded border border-[#D8DEE8] bg-white">
            <div className="hidden min-h-9 items-center gap-2 border-r border-[#D8DEE8] px-3 sm:flex">
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
        ) : (
          <>
            <div
              className="mx-3 mt-3 flex min-h-16 shrink-0 items-center gap-3 rounded-xl border border-[#FFD3C9] bg-gradient-to-r from-[#FFF8F5] via-white to-[#FFF1EB] px-3.5 py-2 shadow-[0_8px_24px_rgba(244,124,82,0.1)] sm:mx-5"
              aria-live="polite"
              data-testid="bricko-status-banner"
            >
              <div className="relative grid size-12 shrink-0 place-items-center">
                <BrickOPet
                  celebration={petCelebration?.variant ?? "sparkle"}
                  key={petCelebration?.eventId ?? petMode}
                  label={petStatus}
                  mode={petMode}
                  size="md"
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
              <div className="mx-auto max-w-3xl">
                {messages.length === 0 && !error && (
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
                        Bring bold ideas, stubborn bugs, and seemingly
                        impossible projects. BrickO brought virtual
                        snacks—let&apos;s turn “maybe” into “shipped” together.
                      </p>
                      <p className="mx-auto mt-3 max-w-sm rounded-lg border border-[#FFD3C9] bg-[#FFF8F5] px-3 py-2 text-xs font-semibold text-[#573129]">
                        Interface language: English. Chat in any language.
                      </p>
                    </div>
                  </div>
                )}

                {messages.map((message) => {
                  const mine = message.pubkey === identity.pubkey;
                  const day = formatMessageDay(message.created_at);
                  const showDay = day !== previousDay;
                  previousDay = day;
                  return (
                    <div key={message.id}>
                      {showDay && (
                        <div className="my-6 flex items-center gap-3">
                          <div className="h-px flex-1 bg-[#D8DEE8]" />
                          <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#607086]">
                            {day}
                          </span>
                          <div className="h-px flex-1 bg-[#D8DEE8]" />
                        </div>
                      )}
                      <article
                        className={`mb-5 flex items-end gap-2.5 ${mine ? "justify-end" : "justify-start"}`}
                      >
                        {!mine && <BrickOPet mode="still" size="sm" />}
                        <div
                          className={`max-w-[86%] sm:max-w-[78%] ${mine ? "items-end" : "items-start"}`}
                        >
                          <div
                            className={`mb-1.5 flex items-center gap-2 px-1 ${mine ? "justify-end" : "justify-start"}`}
                          >
                            <span className="text-[11px] font-bold text-[#42526B]">
                              {mine ? "You" : "BrickO"}
                            </span>
                            <time className="text-[10px] text-[#607086]">
                              {formatMessageTime(message.created_at)}
                            </time>
                          </div>
                          <div
                            className={`rounded px-4 py-3 text-sm leading-6 shadow-sm ${
                              mine
                                ? "border border-[#F2B09F] bg-[#FFF0EB] text-[#44201A] shadow-[#FF6F52]/10"
                                : "border border-[#D8DEE8] bg-white text-[#172033]"
                            }`}
                          >
                            <div
                              className={`prose prose-sm max-w-none break-words prose-p:my-0 prose-p:leading-6 prose-pre:bg-[#10213F] prose-pre:text-white ${mine ? "prose-a:text-[#9D321F]" : "prose-a:text-[#E35E43]"}`}
                            >
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {message.content}
                              </ReactMarkdown>
                            </div>
                          </div>
                          {mine && (
                            <div className="mt-1 flex items-center justify-end gap-1 px-1 text-[10px] text-[#607086]">
                              <CheckCircle2 size={10} /> Sent
                            </div>
                          )}
                        </div>
                      </article>
                    </div>
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

            <form
              onSubmit={send}
              className="shrink-0 border-t border-[#D8DEE8] bg-white px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-5"
            >
              <div className="mx-auto max-w-3xl">
                {error && (
                  <div
                    className="mb-3 flex items-center gap-2 rounded border border-[#F4BDC2] bg-[#FFF3F4] px-3 py-2 text-xs text-[#C93F4A]"
                    role="alert"
                  >
                    <WifiOff size={13} className="shrink-0" />
                    <span className="truncate">{error}</span>
                  </div>
                )}
                <div className="flex items-end gap-2 rounded border border-[#D8DEE8] bg-white p-2 shadow-[0_8px_24px_rgba(16,35,63,0.08)] transition focus-within:border-[#FF6F52]/60 focus-within:ring-4 focus-within:ring-[#FF6F52]/10">
                  <textarea
                    ref={composerRef}
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    maxLength={65_536}
                    rows={1}
                    placeholder="Message BrickO…"
                    className="max-h-36 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-3 py-2.5 text-sm leading-6 text-[#172033] outline-none placeholder:text-[#8491A4]"
                  />
                  <button
                    type="submit"
                    disabled={busy || !text.trim() || !connected}
                    className="grid size-11 shrink-0 place-items-center rounded bg-[#FF6F52] text-white transition hover:bg-[#E35E43] disabled:cursor-not-allowed disabled:bg-[#E2E8F0] disabled:text-[#8491A4]"
                    aria-label="Send"
                  >
                    {busy ? (
                      <RefreshCw size={17} className="animate-spin" />
                    ) : (
                      <Send size={17} />
                    )}
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-xs text-[#526178]">
                  <span className="flex items-center gap-1.5">
                    <Clock3 size={11} /> Enter to send · Shift+Enter for a new
                    line
                  </span>
                  <span className="font-semibold text-[#573129]">
                    Interface: English · Chat: any language
                  </span>
                  <span>{text.length.toLocaleString("en-US")}/65,536</span>
                </div>
              </div>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
