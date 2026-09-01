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
    emerald: "bg-emerald-400 shadow-emerald-400/40",
    violet: "animate-pulse bg-violet-400 shadow-violet-400/40",
    amber: "bg-amber-400 shadow-amber-400/40",
    slate: "bg-slate-500 shadow-slate-500/30",
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
    <div className="relative flex h-dvh overflow-hidden bg-[#070910] text-slate-100 selection:bg-violet-400/30">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_70%_-10%,rgba(124,58,237,0.16),transparent_38%),radial-gradient(circle_at_8%_90%,rgba(14,165,233,0.08),transparent_32%)]" />

      <aside className="relative hidden w-72 shrink-0 flex-col border-r border-white/[0.07] bg-[#0b0e17]/90 px-4 py-5 backdrop-blur-xl md:flex">
        <div className="flex items-center gap-3 px-2">
          <div className="grid size-10 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 shadow-lg shadow-violet-950/40">
            <Sparkles size={19} />
          </div>
          <div>
            <div className="text-base font-semibold tracking-tight">Hive</div>
            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">
              OneBrick AI workspace
            </div>
          </div>
        </div>

        <div className="mt-8 px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-600">
          Percakapan
        </div>
        <div className="mt-2 flex items-center gap-3 rounded-2xl border border-violet-400/15 bg-violet-400/[0.08] p-3.5 shadow-inner shadow-violet-500/[0.03]">
          <div className="grid size-9 place-items-center rounded-xl bg-violet-400/15 text-violet-300">
            <Hash size={17} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">bricko-lab</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
              <ShieldCheck size={11} /> Privat
            </div>
          </div>
        </div>

        <div className="mt-7 px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-600">
          Asisten
        </div>
        <div className="mt-2 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4">
          <div className="flex items-start gap-3">
            <div className="relative grid size-10 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-slate-700 to-slate-900 ring-1 ring-white/10">
              <Bot size={20} className="text-violet-300" />
              <span
                className={`absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-[#10131d] shadow-[0_0_10px] ${toneClasses}`}
              />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold">BrickO</div>
              <div className="mt-0.5 text-xs leading-5 text-slate-400">
                {agentState.label}
              </div>
            </div>
          </div>
          <div className="mt-3 border-t border-white/[0.06] pt-3 text-[11px] leading-4 text-slate-500">
            {agentState.detail}
          </div>
        </div>

        <div className="mt-auto rounded-2xl border border-white/[0.06] bg-white/[0.025] p-3.5">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            {connected ? (
              <Wifi size={13} className="text-emerald-400" />
            ) : (
              <WifiOff size={13} className="text-amber-400" />
            )}
            {connected ? "Realtime tersambung" : "Sedang menyambung"}
          </div>
          <div className="mt-3 truncate border-t border-white/[0.06] pt-3 text-xs text-slate-500">
            {identity.email}
          </div>
        </div>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="z-10 flex h-[72px] shrink-0 items-center justify-between border-b border-white/[0.07] bg-[#090c14]/80 px-4 backdrop-blur-xl sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-violet-500 text-white shadow-lg shadow-violet-950/30 md:hidden">
              <Sparkles size={17} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-sm font-semibold sm:text-base">
                  BrickO
                </h1>
                <span
                  className={`size-1.5 rounded-full shadow-[0_0_8px] ${toneClasses}`}
                />
                <span className="truncate text-xs text-slate-400">
                  {agentState.label}
                </span>
              </div>
              <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
                <Hash size={11} /> bricko-lab
                <span className="text-slate-700">•</span>
                <ShieldCheck size={11} /> privat
              </p>
            </div>
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-xl p-2.5 text-slate-500 transition hover:bg-white/[0.06] hover:text-slate-200"
              aria-label="Muat ulang"
            >
              <RefreshCw size={17} />
            </button>
            <button
              type="button"
              onClick={logout}
              className="rounded-xl p-2.5 text-slate-500 transition hover:bg-white/[0.06] hover:text-slate-200"
              aria-label="Keluar"
            >
              <LogOut size={17} />
            </button>
          </div>
        </header>

        {(waiting || typingVisible || !connected) && (
          <div
            className="mx-4 mt-4 flex shrink-0 items-center gap-3 rounded-2xl border border-violet-400/10 bg-violet-400/[0.06] px-4 py-3 sm:mx-6"
            aria-live="polite"
          >
            <div className="relative grid size-8 place-items-center rounded-xl bg-violet-400/10 text-violet-300">
              {connected ? <Activity size={16} /> : <WifiOff size={15} />}
              {connected && (
                <span className="absolute inset-0 animate-ping rounded-xl border border-violet-400/20" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-violet-200">
                {agentState.label}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-slate-500">
                {agentState.detail}
              </div>
            </div>
            {connected && (waiting || typingVisible) && (
              <div className="flex gap-1" aria-hidden="true">
                {[0, 1, 2].map((dot) => (
                  <span
                    key={dot}
                    className="size-1.5 animate-bounce rounded-full bg-violet-300"
                    style={{ animationDelay: `${dot * 120}ms` }}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        <section className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-5 sm:px-6">
          <div className="mx-auto max-w-3xl">
            {messages.length === 0 && !error && (
              <div className="grid min-h-[45vh] place-items-center text-center">
                <div>
                  <div className="mx-auto grid size-16 place-items-center rounded-3xl border border-violet-400/15 bg-violet-400/[0.07] text-violet-300">
                    <MessageCircleMore size={27} />
                  </div>
                  <h2 className="mt-5 text-base font-semibold">
                    Mulai percakapan dengan BrickO
                  </h2>
                  <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-500">
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
                    <div className="my-7 flex items-center gap-3">
                      <div className="h-px flex-1 bg-white/[0.06]" />
                      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-slate-600">
                        {day}
                      </span>
                      <div className="h-px flex-1 bg-white/[0.06]" />
                    </div>
                  )}
                  <article
                    className={`mb-5 flex items-end gap-2.5 ${mine ? "justify-end" : "justify-start"}`}
                  >
                    {!mine && (
                      <div className="grid size-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-slate-700 to-slate-900 ring-1 ring-white/10">
                        <Bot size={16} className="text-violet-300" />
                      </div>
                    )}
                    <div
                      className={`max-w-[86%] sm:max-w-[78%] ${mine ? "items-end" : "items-start"}`}
                    >
                      <div
                        className={`mb-1.5 flex items-center gap-2 px-1 ${mine ? "justify-end" : "justify-start"}`}
                      >
                        <span className="text-[11px] font-medium text-slate-400">
                          {mine ? "Anda" : "BrickO"}
                        </span>
                        <time className="text-[10px] text-slate-600">
                          {formatMessageTime(message.created_at)}
                        </time>
                      </div>
                      <div
                        className={`rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm ${
                          mine
                            ? "rounded-br-md bg-gradient-to-br from-violet-600 to-indigo-600 text-white shadow-violet-950/20"
                            : "rounded-bl-md border border-white/[0.07] bg-white/[0.045] text-slate-200"
                        }`}
                      >
                        <div className="prose prose-sm prose-invert max-w-none break-words prose-p:my-0 prose-p:leading-6 prose-pre:bg-black/30 prose-a:text-violet-300">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {message.content}
                          </ReactMarkdown>
                        </div>
                      </div>
                      {mine && (
                        <div className="mt-1 flex items-center justify-end gap-1 px-1 text-[10px] text-slate-600">
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
                <div className="grid size-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-slate-700 to-slate-900 ring-1 ring-white/10">
                  <Bot size={16} className="text-violet-300" />
                </div>
                <div>
                  <div className="mb-1.5 px-1 text-[11px] font-medium text-slate-400">
                    BrickO
                  </div>
                  <div className="flex h-11 items-center gap-1 rounded-2xl rounded-bl-md border border-white/[0.07] bg-white/[0.045] px-4">
                    {[0, 1, 2].map((dot) => (
                      <span
                        key={dot}
                        className="size-1.5 animate-bounce rounded-full bg-slate-400"
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
          className="shrink-0 border-t border-white/[0.06] bg-[#090c14]/90 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 backdrop-blur-xl sm:px-6"
        >
          <div className="mx-auto max-w-3xl">
            {error && (
              <div
                className="mb-3 flex items-center gap-2 rounded-xl border border-rose-400/15 bg-rose-400/[0.06] px-3 py-2 text-xs text-rose-300"
                role="alert"
              >
                <WifiOff size={13} className="shrink-0" />
                <span className="truncate">{error}</span>
              </div>
            )}
            <div className="flex items-end gap-2 rounded-2xl border border-white/[0.09] bg-white/[0.045] p-2 shadow-2xl shadow-black/20 transition focus-within:border-violet-400/30 focus-within:bg-white/[0.06] focus-within:ring-4 focus-within:ring-violet-500/[0.05]">
              <textarea
                ref={composerRef}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                maxLength={65_536}
                rows={1}
                placeholder="Ketik pesan untuk BrickO…"
                className="max-h-36 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-3 py-2.5 text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-600"
              />
              <button
                type="submit"
                disabled={busy || !text.trim() || !connected}
                className="grid size-11 shrink-0 place-items-center rounded-xl bg-violet-500 text-white shadow-lg shadow-violet-950/30 transition hover:bg-violet-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500 disabled:shadow-none"
                aria-label="Kirim"
              >
                {busy ? (
                  <RefreshCw size={17} className="animate-spin" />
                ) : (
                  <Send size={17} />
                )}
              </button>
            </div>
            <div className="mt-2 flex items-center justify-between px-1 text-[10px] text-slate-600">
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
