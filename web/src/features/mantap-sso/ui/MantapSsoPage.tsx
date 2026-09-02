import { useEffect, useState } from "react";
import {
  exchangeMantapTicketWithRecovery,
  MantapSsoExchangeError,
} from "../mantap-sso-api";

type SsoState = "validating" | "recovering" | "failed";

function failureMessage(error: unknown): string {
  if (error instanceof MantapSsoExchangeError) {
    if (error.code === "invalid_sso_ticket") {
      return "Your Mantap session has expired. Open Hive from Mantap to start a new session.";
    }
    if (error.code === "mantap_sso_unavailable") {
      return "Hive cannot verify Mantap right now. Please try again shortly.";
    }
  }
  return "Hive could not connect your Mantap account. Open Hive from Mantap to try again.";
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
      ? "Synchronizing your Mantap account with your Hive identity…"
      : state === "failed"
        ? errorMessage
        : "Validating your Mantap session…";

  return (
    <div
      className="grid min-h-dvh place-items-center bg-slate-950 p-6 text-slate-100"
      data-onebrick-sso-handoff="onebrick-sso-handoff-v1"
    >
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/5 p-8 shadow-2xl">
        <div className="mb-5 inline-flex rounded-2xl bg-violet-500/15 px-3 py-1 text-sm font-semibold text-violet-300">
          Hive × Mantap
        </div>
        <h1 className="text-2xl font-semibold">Connecting to Hive</h1>
        <p className="mt-2 text-sm text-slate-300">
          Secure sign-in in progress
        </p>
        <p
          className={`mt-3 text-sm leading-6 ${state === "failed" ? "text-red-300" : "text-slate-400"}`}
          aria-live="polite"
        >
          {status}
        </p>
        {state === "failed" ? (
          <button
            className="mt-5 rounded-xl bg-violet-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-300"
            onClick={() => window.location.assign("https://mantap.onebrick.io")}
            type="button"
          >
            Back to Mantap
          </button>
        ) : null}
      </div>
    </div>
  );
}
