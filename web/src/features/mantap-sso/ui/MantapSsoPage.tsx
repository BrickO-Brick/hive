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
      return "Your Mantap session has expired. Open Hive from Mantap again to create a new session.";
    }
    if (error.code === "mantap_sso_unavailable") {
      return "Hive cannot validate Mantap right now. Please try again shortly.";
    }
  }
  return "We could not connect your Mantap account to Hive. Reopen Hive from Mantap to try again.";
}

export function MantapSsoPage() {
  const [state, setState] = useState<SsoState>("validating");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const desktopCallback = search.get("desktop_callback");
    const ticket = new URLSearchParams(window.location.hash.slice(1)).get(
      "ticket",
    );
    const validDesktopCallback = (() => {
      if (!desktopCallback) return null;
      try {
        const url = new URL(desktopCallback);
        return url.protocol === "http:" && url.hostname === "127.0.0.1"
          ? url
          : null;
      } catch {
        return null;
      }
    })();
    if (!ticket) {
      if (!validDesktopCallback) {
        window.location.replace("https://mantap.onebrick.io");
        return;
      }
      const loginUrl = new URL("https://mantap.onebrick.io");
      loginUrl.searchParams.set("returnTo", window.location.href);
      window.location.replace(loginUrl);
      return;
    }
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    if (validDesktopCallback) {
      validDesktopCallback.searchParams.set("ticket", ticket);
      window.location.replace(validDesktopCallback);
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
      ? "Syncing your Mantap account with your Hive identity…"
      : state === "failed"
        ? errorMessage
        : "Validating your Mantap session…";

  return (
    <div
      className="grid min-h-dvh place-items-center bg-[#171412] p-6 text-[#fff1ec]"
      data-onebrick-sso-handoff="onebrick-sso-handoff-v1"
    >
      <div className="grid w-full max-w-3xl overflow-hidden rounded-3xl border border-white/10 bg-white/5 shadow-2xl md:grid-cols-2">
        <img
          alt="BrickO pair-programming with the team"
          className="h-full min-h-64 w-full object-cover"
          src={brickoOperationsUrl}
        />
        <div className="p-8">
          <div className="mb-5 inline-flex rounded-2xl bg-[#ff6f52]/15 px-3 py-1 text-sm font-semibold text-[#ffb5a4]">
            Hive × Mantap
          </div>
          <h1 className="text-2xl font-semibold">Sign in to Hive</h1>
          <p className="mt-3 text-sm leading-6 text-[#fff1ec]/80">
            Welcome, Bricksters! Big ideas, stubborn bugs, and virtual snacks
            are ready—it&apos;s time to build something great with BrickO.
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
              Return to Mantap
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
