import { useEffect } from "react";
import { ensureMantapBrowserIdentity } from "@/shared/lib/nostr-signer";
import { exchangeMantapTicket } from "../mantap-sso-api";

export function MantapSsoPage() {
  useEffect(() => {
    const ticket = new URLSearchParams(window.location.hash.slice(1)).get(
      "ticket",
    );
    window.history.replaceState(null, "", window.location.pathname);
    if (!ticket) {
      window.location.replace("https://mantap.onebrick.io");
      return;
    }
    ensureMantapBrowserIdentity();
    exchangeMantapTicket(ticket)
      .then(() => window.location.replace("/app"))
      .catch(() => window.location.replace("https://mantap.onebrick.io"));
  }, []);

  return (
    <div className="grid min-h-dvh place-items-center bg-slate-950 p-6 text-slate-100">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/5 p-8 shadow-2xl">
        <div className="mb-5 inline-flex rounded-2xl bg-violet-500/15 px-3 py-1 text-sm font-semibold text-violet-300">
          Hive × Mantap
        </div>
        <h1 className="text-2xl font-semibold">Masuk ke Hive</h1>
        <p className="mt-3 text-sm leading-6 text-slate-400" aria-live="polite">
          Memvalidasi sesi Mantap Anda…
        </p>
      </div>
    </div>
  );
}
