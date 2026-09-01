import {
  Activity,
  Bot,
  CheckCircle2,
  Clock3,
  Hash,
  LogOut,
  MessageCircleMore,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  clearHiveIdentity,
  loadHiveIdentity,
} from "@/features/mantap-sso/mantap-sso-api";
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

type Presence = "online" | "away" | "offline" | "unknown";

const TYPING_VISIBLE_MS = 7_000;

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
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
}

function formatMessageDay(timestamp: number): string {
  return new Intl.DateTimeFormat("id-ID", {
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const mergeMessage = useCallback(
    (event: NostrEvent) => {
      setMessages((current) => {
        const byId = new Map(current.map((message) => [message.id, message]));
        byId.set(event.id, event);
        return [...byId.values()].sort((a, b) => a.created_at - b.created_at);
      });
      if (identity && event.pubkey !== identity.pubkey) {
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
      setError(cause instanceof Error ? cause.message : "Gagal memuat pesan.");
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
    if (!identity || !hasMantapBrowserIdentity()) {
      window.location.replace("https://mantap.onebrick.io");
    }
  }, [identity]);

  if (!identity || !hasMantapBrowserIdentity()) return null;

  const connected = connection === "connected";
  const waiting = pendingSince !== null;
  const agentState = (() => {
    if (!connected) {
      return {
        label:
          connection === "connecting" ? "Menghubungkan…" : "Menyambung ulang…",
        detail: "Menunggu koneksi aman ke Hive",
        tone: "amber" as const,
      };
    }
    if (typingVisible) {
      return {
        label: "Sedang menjawab…",
        detail: "BrickO sedang menulis balasan untuk Anda",
        tone: "violet" as const,
      };
    }
    if (waiting) {
      return {
        label: "Sedang menyiapkan jawaban…",
        detail: "Pesan sudah diterima dan sedang diproses",
        tone: "violet" as const,
      };
    }
    if (presence === "online") {
      return {
        label: "Online dan siap",
        detail: "BrickO siap menerima instruksi berikutnya",
        tone: "emerald" as const,
      };
    }
    if (presence === "away") {
      return {
        label: "Sedang idle",
        detail: "BrickO tetap terhubung ke workspace",
        tone: "amber" as const,
      };
    }
    if (presence === "offline") {
      return {
        label: "Sedang offline",
        detail: "Pesan tetap tersimpan aman di channel",
        tone: "slate" as const,
      };
    }
    return {
      label: "Memeriksa status…",
      detail: "Koneksi Hive aktif",
      tone: "slate" as const,
    };
  })();

  const toneClasses = {
    emerald: "bg-[#1FA971] shadow-[#1FA971]/30",
    violet: "animate-pulse bg-[#2F6FED] shadow-[#2F6FED]/30",
    amber: "bg-[#D9861C] shadow-[#D9861C]/30",
    slate: "bg-[#8491A4] shadow-[#8491A4]/30",
  }[agentState.tone];

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
      setError(cause instanceof Error ? cause.message : "Pesan gagal dikirim.");
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

  return (
    <div className="flex h-dvh overflow-hidden bg-white text-[#172033] selection:bg-[#FF6F52]/20">
      <aside className="hidden w-[260px] shrink-0 flex-col border-r border-[#D8DEE8] bg-white md:flex">
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-[#D8DEE8] px-5">
          <div className="grid size-8 place-items-center rounded bg-[#FF6F52] text-white">
            <Sparkles size={16} strokeWidth={2.4} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-extrabold tracking-[0.22em] text-[#10233F]">
                BRICK
              </span>
              <span className="rounded border border-[#FFD3C9] bg-[#FFF3EF] px-1.5 py-0.5 text-[9px] font-extrabold tracking-[0.12em] text-[#E35E43]">
                HIVE
              </span>
            </div>
            <p className="mt-0.5 text-[10px] font-medium text-[#607086]">
              AI operations workspace
            </p>
          </div>
        </div>

        <div className="px-4 pt-5 text-[10px] font-extrabold uppercase tracking-[0.12em] text-[#607086]">
          Workspace
        </div>
        <div className="mx-3 mt-2 flex items-center gap-3 rounded border border-[#FFD3C9] bg-[#FFF7F4] p-3 shadow-[inset_3px_0_0_#FF6F52]">
          <div className="grid size-8 place-items-center rounded border border-[#FFD3C9] bg-white text-[#FF6F52]">
            <Hash size={15} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-bold text-[#10233F]">
              bricko-lab
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[#607086]">
              <ShieldCheck size={11} /> Private channel
            </div>
          </div>
        </div>

        <div className="px-4 pt-6 text-[10px] font-extrabold uppercase tracking-[0.12em] text-[#607086]">
          Agent activity
        </div>
        <section
          className="mx-3 mt-2 rounded border border-[#D8DEE8] bg-[#F7FAFC] p-3.5"
          aria-label="Status BrickO"
        >
          <div className="flex items-start gap-3">
            <div className="relative grid size-9 shrink-0 place-items-center rounded bg-[#10213F] text-white">
              <Bot size={18} />
              <span
                className={`absolute -bottom-1 -right-1 size-3 rounded-full border-2 border-white shadow-sm ${toneClasses}`}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-bold text-[#10233F]">
                  BrickO
                </span>
                <span className="rounded-full border border-[#D8DEE8] bg-white px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-[0.08em] text-[#526178]">
                  Agent
                </span>
              </div>
              <div className="mt-1 text-xs font-semibold text-[#344054]">
                {agentState.label}
              </div>
            </div>
          </div>
          <div className="mt-3 border-t border-[#D8DEE8] pt-3 text-[11px] leading-[1.5] text-[#607086]">
            {agentState.detail}
          </div>
        </section>

        <div className="mt-auto border-t border-[#D8DEE8] bg-[#F7FAFC] p-3">
          <div className="rounded border border-[#D8DEE8] bg-white p-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#42526B]">
              {connected ? (
                <Wifi size={13} className="text-[#1FA971]" />
              ) : (
                <WifiOff size={13} className="text-[#D9861C]" />
              )}
              {connected ? "Realtime tersambung" : "Sedang menyambung"}
            </div>
            <div className="mt-2 truncate border-t border-[#E2E8F0] pt-2 text-[11px] text-[#607086]">
              {identity.email}
            </div>
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-white">
        <header className="z-10 flex h-14 shrink-0 items-center justify-between border-b border-[#D8DEE8] bg-white px-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-8 shrink-0 place-items-center rounded bg-[#FF6F52] text-white md:hidden">
              <Sparkles size={15} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-[15px] font-bold text-[#10233F]">
                  BrickO
                </h1>
                <span
                  className={`size-2 rounded-full shadow-sm ${toneClasses}`}
                />
                <span className="hidden truncate text-xs font-medium text-[#526178] sm:inline">
                  {agentState.label}
                </span>
              </div>
              <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[#607086]">
                <Hash size={10} /> bricko-lab
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
              aria-label="Muat ulang"
            >
              <RefreshCw size={15} />
            </button>
            <button
              type="button"
              onClick={logout}
              className="grid size-9 place-items-center border-l border-[#D8DEE8] text-[#526178] transition hover:bg-[#F7FAFC] hover:text-[#C93F4A]"
              aria-label="Keluar"
            >
              <LogOut size={15} />
            </button>
          </div>
        </header>

        {(waiting || typingVisible || !connected) && (
          <div
            className="mx-3 mt-3 flex shrink-0 items-center gap-3 rounded border border-[#D8DEE8] bg-[#F7FAFC] px-3.5 py-2.5 sm:mx-5"
            aria-live="polite"
          >
            <div className="relative grid size-8 place-items-center rounded bg-[#EAF1F8] text-[#2F6FED]">
              {connected ? <Activity size={16} /> : <WifiOff size={15} />}
              {connected && (
                <span className="absolute inset-0 animate-ping rounded border border-[#2F6FED]/25" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-bold text-[#10233F]">
                {agentState.label}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-[#607086]">
                {agentState.detail}
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
        )}

        <section className="min-h-0 flex-1 overflow-y-auto bg-[#F7FAFC] px-3 pb-6 pt-4 sm:px-5">
          <div className="mx-auto max-w-3xl">
            {messages.length === 0 && !error && (
              <div className="grid min-h-[45vh] place-items-center text-center">
                <div>
                  <div className="mx-auto grid size-14 place-items-center rounded border border-[#FFD3C9] bg-[#FFF3EF] text-[#FF6F52]">
                    <MessageCircleMore size={27} />
                  </div>
                  <h2 className="mt-4 text-base font-bold text-[#10233F]">
                    Mulai percakapan dengan BrickO
                  </h2>
                  <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-[#607086]">
                    Tanyakan pekerjaan, status sistem, atau minta bantuan pada
                    workspace OneBrick ini.
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
                    {!mine && (
                      <div className="grid size-8 shrink-0 place-items-center rounded bg-[#10213F] text-white">
                        <Bot size={15} />
                      </div>
                    )}
                    <div
                      className={`max-w-[86%] sm:max-w-[78%] ${mine ? "items-end" : "items-start"}`}
                    >
                      <div
                        className={`mb-1.5 flex items-center gap-2 px-1 ${mine ? "justify-end" : "justify-start"}`}
                      >
                        <span className="text-[11px] font-bold text-[#42526B]">
                          {mine ? "Anda" : "BrickO"}
                        </span>
                        <time className="text-[10px] text-[#607086]">
                          {formatMessageTime(message.created_at)}
                        </time>
                      </div>
                      <div
                        className={`rounded px-4 py-3 text-sm leading-6 shadow-sm ${
                          mine
                            ? "bg-[#FF6F52] text-white shadow-[#FF6F52]/10"
                            : "border border-[#D8DEE8] bg-white text-[#172033]"
                        }`}
                      >
                        <div
                          className={`prose prose-sm max-w-none break-words prose-p:my-0 prose-p:leading-6 prose-pre:bg-[#10213F] prose-pre:text-white ${mine ? "prose-invert prose-a:text-white" : "prose-a:text-[#E35E43]"}`}
                        >
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {message.content}
                          </ReactMarkdown>
                        </div>
                      </div>
                      {mine && (
                        <div className="mt-1 flex items-center justify-end gap-1 px-1 text-[10px] text-[#607086]">
                          <CheckCircle2 size={10} /> Terkirim
                        </div>
                      )}
                    </div>
                  </article>
                </div>
              );
            })}

            {typingVisible && (
              <div className="mb-5 flex items-end gap-2.5" aria-live="polite">
                <div className="grid size-8 shrink-0 place-items-center rounded bg-[#10213F] text-white">
                  <Bot size={15} />
                </div>
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
                placeholder="Ketik pesan untuk BrickO…"
                className="max-h-36 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-3 py-2.5 text-sm leading-6 text-[#172033] outline-none placeholder:text-[#8491A4]"
              />
              <button
                type="submit"
                disabled={busy || !text.trim() || !connected}
                className="grid size-11 shrink-0 place-items-center rounded bg-[#FF6F52] text-white transition hover:bg-[#E35E43] disabled:cursor-not-allowed disabled:bg-[#E2E8F0] disabled:text-[#8491A4]"
                aria-label="Kirim"
              >
                {busy ? (
                  <RefreshCw size={17} className="animate-spin" />
                ) : (
                  <Send size={17} />
                )}
              </button>
            </div>
            <div className="mt-2 flex items-center justify-between px-1 text-[10px] text-[#607086]">
              <span className="flex items-center gap-1.5">
                <Clock3 size={10} /> Enter untuk kirim · Shift+Enter untuk baris
                baru
              </span>
              <span>{text.length.toLocaleString("id-ID")}/65.536</span>
            </div>
          </div>
        </form>
      </main>
    </div>
  );
}
