import { LogOut, RefreshCw, Send } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  clearHiveIdentity,
  loadHiveIdentity,
} from "@/features/mantap-sso/mantap-sso-api";
import {
  publishEvent,
  queryEvents,
  type NostrEvent,
} from "@/shared/lib/nostr-client";
import {
  clearMantapBrowserIdentity,
  hasMantapBrowserIdentity,
  signNostrEvent,
} from "@/shared/lib/nostr-signer";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { truncatePubkey } from "@/shared/lib/pubkey";

export function HiveChatPage() {
  const identity = useMemo(loadHiveIdentity, []);
  const [messages, setMessages] = useState<NostrEvent[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!identity || !hasMantapBrowserIdentity()) {
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-950 p-6 text-slate-100">
        <div className="max-w-md rounded-3xl border border-white/10 bg-white/5 p-8">
          <h1 className="text-2xl font-semibold">Hive</h1>
          <p className="mt-3 text-slate-400">
            Buka Hive dari menu Mantap untuk masuk dengan akun OneBrick Anda.
          </p>
          <a
            className="mt-6 inline-flex rounded-xl bg-violet-500 px-4 py-2 font-medium"
            href="https://mantap.onebrick.io"
          >
            Buka Mantap
          </a>
        </div>
      </div>
    );
  }

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
      setText("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pesan gagal dikirim.");
    } finally {
      setBusy(false);
    }
  };

  const logout = () => {
    clearHiveIdentity();
    clearMantapBrowserIdentity();
    window.location.replace("/app");
  };

  return (
    <div className="flex min-h-dvh bg-slate-950 text-slate-100">
      <aside className="hidden w-72 border-r border-white/10 bg-slate-900/60 p-6 md:block">
        <div className="text-xl font-bold tracking-tight">Hive</div>
        <div className="mt-8 rounded-2xl bg-violet-500/10 p-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-violet-300">
            Channel
          </div>
          <div className="mt-2 font-medium"># bricko-lab</div>
        </div>
        <div className="mt-auto pt-8 text-sm text-slate-400">
          {identity.email}
        </div>
      </aside>
      <main className="flex min-h-dvh flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <h1 className="font-semibold"># bricko-lab</h1>
            <p className="text-xs text-slate-500">Private OneBrick workspace</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-xl p-2 text-slate-400 hover:bg-white/10"
              aria-label="Muat ulang"
            >
              <RefreshCw size={18} />
            </button>
            <button
              type="button"
              onClick={logout}
              className="rounded-xl p-2 text-slate-400 hover:bg-white/10"
              aria-label="Keluar"
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>
        <section className="flex-1 space-y-4 overflow-y-auto p-5">
          {messages.length === 0 && !error && (
            <p className="text-center text-sm text-slate-500">
              Belum ada pesan.
            </p>
          )}
          {messages.map((message) => {
            const mine = message.pubkey === identity.pubkey;
            return (
              <article
                key={message.id}
                className={`max-w-2xl rounded-2xl p-4 ${mine ? "ml-auto bg-violet-500/20" : "bg-white/5"}`}
              >
                <div className="mb-2 flex gap-3 text-xs text-slate-500">
                  <span>
                    {mine ? identity.email : truncatePubkey(message.pubkey)}
                  </span>
                  <time>
                    {new Date(message.created_at * 1000).toLocaleString(
                      "id-ID",
                    )}
                  </time>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-6">
                  {message.content}
                </p>
              </article>
            );
          })}
        </section>
        <form onSubmit={send} className="border-t border-white/10 p-4">
          {error && (
            <p className="mb-2 text-sm text-rose-400" role="alert">
              {error}
            </p>
          )}
          <div className="mx-auto flex max-w-4xl gap-3 rounded-2xl border border-white/10 bg-white/5 p-2">
            <input
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={65536}
              placeholder="Tulis pesan…"
              className="min-w-0 flex-1 bg-transparent px-3 py-2 outline-none"
            />
            <button
              type="submit"
              disabled={busy || !text.trim()}
              className="rounded-xl bg-violet-500 px-4 disabled:opacity-40"
              aria-label="Kirim"
            >
              <Send size={18} />
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
