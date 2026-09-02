import { useEffect, useState } from "react";
import brickoOperationsUrl from "@/assets/bricko-operations.jpg";
import {
  exchangeMantapTicketWithRecovery,
  MantapSsoExchangeError,
} from "../mantap-sso-api";

type SsoState = "validating" | "recovering" | "failed";

function failureMessage(error: unknown): string {
  if (error instanceof MantapSsoExchangeError) {
    if (error.code === "invalid_sso_ticket") {
      return "Sesi Mantap sudah kedaluwarsa. Buka Hive lagi dari Mantap untuk membuat sesi baru.";
    }
    if (error.code === "mantap_sso_unavailable") {
      return "Hive sedang tidak dapat memvalidasi Mantap. Silakan coba lagi sebentar lagi.";
    }
  }
  return "Kami belum bisa menyambungkan akun Mantap Anda ke Hive. Buka kembali Hive dari Mantap untuk mencoba lagi.";
}

export function MantapSsoPage() {
  const [state, setState] = useState<SsoState>("validating");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    const ticket = new URLSearchParams(window.location.hash.slice(1)).get(
      "ticket",
    );
    window.history.replaceState(null, "", window.location.pathname);
    if (!ticket) {
      window.location.replace("https://mantap.onebrick.io");
      return;
    }
    let current = true;
    exchangeMantapTicketWithRecovery(ticket, () => {
      if (current) setState("recovering");
    })
      .then(() => {
        if (current) window.location.replace("/app");
      })
      .catch((error: unknown) => {
        if (!current) return;
        setErrorMessage(failureMessage(error));
        setState("failed");
      });
    return () => {
      current = false;
    };
  }, []);

  const status =
    state === "recovering"
      ? "Menyelaraskan akun Mantap dengan identitas Hive Anda…"
      : state === "failed"
        ? errorMessage
        : "Memvalidasi sesi Mantap Anda…";

  return (
    <div
      className="grid min-h-dvh place-items-center bg-[#171412] p-6 text-[#fff1ec]"
      data-onebrick-sso-handoff="onebrick-sso-handoff-v1"
    >
      <div className="grid w-full max-w-3xl overflow-hidden rounded-3xl border border-white/10 bg-white/5 shadow-2xl md:grid-cols-2">
        <img
          alt="BrickO sedang pair-programming bersama tim"
          className="h-full min-h-64 w-full object-cover"
          src={brickoOperationsUrl}
        />
        <div className="p-8">
          <div className="mb-5 inline-flex rounded-2xl bg-[#ff6f52]/15 px-3 py-1 text-sm font-semibold text-[#ffb5a4]">
            Hive × Mantap
          </div>
          <h1 className="text-2xl font-semibold">Masuk ke Hive</h1>
          <p className="mt-3 text-sm leading-6 text-[#fff1ec]/80">
            Welcome, Bricksters! Ide besar, bug bandel, dan virtual snacks sudah
            siap — waktunya bikin sesuatu yang mantap bersama BrickO.
          </p>
          <p
            className={`mt-4 text-sm leading-6 ${state === "failed" ? "text-[#ffd0c5]" : "text-[#ffb5a4]"}`}
            aria-live="polite"
          >
            {status}
          </p>
          {state === "failed" ? (
            <button
              className="mt-5 rounded-xl bg-[#ff6f52] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#ff8067] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ffb5a4]"
              onClick={() =>
                window.location.assign("https://mantap.onebrick.io")
              }
              type="button"
            >
              Kembali ke Mantap
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
