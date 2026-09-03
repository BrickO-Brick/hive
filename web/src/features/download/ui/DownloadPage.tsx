import {
  BUZZ_RELEASES_URL,
  type HiveDesktopRelease,
  fetchLatestHiveDesktopRelease,
} from "@/shared/lib/buzz-download";
import {
  Apple,
  ArrowDownToLine,
  CheckCircle2,
  MonitorDown,
} from "lucide-react";
import * as React from "react";

type DownloadCardProps = {
  description: string;
  href?: string;
  icon: React.ReactNode;
  title: string;
};

function DownloadCard({ description, href, icon, title }: DownloadCardProps) {
  const available = Boolean(href);
  return (
    <a
      aria-disabled={!available}
      className="group flex min-h-40 flex-col justify-between rounded-3xl border border-black/10 bg-white p-6 text-left text-black shadow-[0_18px_50px_rgba(76,31,20,0.08)] transition hover:-translate-y-1 hover:border-black/30 hover:shadow-[0_22px_60px_rgba(76,31,20,0.14)] aria-disabled:pointer-events-none aria-disabled:opacity-45 motion-reduce:transform-none motion-reduce:transition-none"
      href={href ?? BUZZ_RELEASES_URL}
      rel="noreferrer"
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#fff0eb] text-[#d9472b]">
        {icon}
      </span>
      <span>
        <strong className="flex items-center gap-2 text-lg font-semibold">
          {title}
          {available ? (
            <ArrowDownToLine
              aria-hidden
              className="h-4 w-4 transition-transform group-hover:translate-y-0.5 motion-reduce:transform-none"
            />
          ) : null}
        </strong>
        <span className="mt-1 block text-sm leading-5 text-black/60">
          {available ? description : "Coming with the next Hive release."}
        </span>
      </span>
    </a>
  );
}

function formatPublishedAt(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
  }).format(new Date(value));
}

export function DownloadPage() {
  const [release, setRelease] = React.useState<
    HiveDesktopRelease | null | undefined
  >(undefined);

  React.useEffect(() => {
    let active = true;
    void fetchLatestHiveDesktopRelease()
      .then((latest) => {
        if (active) setRelease(latest);
      })
      .catch(() => {
        if (active) setRelease(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const publishedAt = release ? formatPublishedAt(release.publishedAt) : null;

  return (
    <div className="min-h-dvh bg-[linear-gradient(160deg,#ff765d_0%,#ffb7a7_38%,#fff4ef_75%,#fff_100%)] px-4 py-8 text-black sm:px-8 sm:py-12">
      <main className="mx-auto max-w-5xl">
        <header className="flex items-center justify-between">
          <a className="flex items-center gap-3 font-semibold" href="/app">
            <img
              alt="Hive"
              className="h-11 w-11 rounded-[22%]"
              src="/hive-icon.png"
            />
            <span className="text-xl">Hive</span>
          </a>
          <a
            className="rounded-full border border-black/15 bg-white/70 px-4 py-2 text-sm font-medium backdrop-blur transition hover:bg-white"
            href="/app"
          >
            Open Hive Web
          </a>
        </header>

        <section className="pb-12 pt-20 text-center sm:pb-16 sm:pt-28">
          <div className="mx-auto h-20 w-20 drop-shadow-[0_18px_30px_rgba(102,33,20,0.16)]">
            <img alt="" className="h-full w-full" src="/hive-icon.png" />
          </div>
          <p className="mt-7 font-mono text-sm font-semibold uppercase tracking-[0.22em] text-[#8d2b1d]">
            Build together. Ship with impact.
          </p>
          <h1 className="mx-auto mt-4 max-w-3xl text-4xl font-semibold tracking-tight sm:text-6xl">
            Bring the whole Hive to your desktop.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-black/65 sm:text-lg">
            Code with your team, collaborate with BrickO, and keep every project
            moving in one lively workspace.
          </p>
          <div className="mt-6 flex min-h-7 items-center justify-center gap-2 text-sm font-medium text-black/65">
            {release ? (
              <>
                <CheckCircle2
                  aria-hidden
                  className="h-4 w-4 text-emerald-700"
                />
                <span>
                  Latest: Hive {release.version}
                  {publishedAt ? ` · ${publishedAt}` : ""}
                </span>
              </>
            ) : release === undefined ? (
              <span>Checking the latest release…</span>
            ) : (
              <span>
                The first public Hive desktop release is being prepared.
              </span>
            )}
          </div>
        </section>

        <section aria-labelledby="downloads-heading">
          <h2 className="sr-only" id="downloads-heading">
            Download Hive
          </h2>
          <div className="grid gap-4 md:grid-cols-3">
            <DownloadCard
              description="For Apple Silicon Macs (M1 or newer)."
              href={release?.downloads.macArm64}
              icon={<Apple aria-hidden className="h-6 w-6" />}
              title="Mac · Apple Silicon"
            />
            <DownloadCard
              description="For Intel-based Macs."
              href={release?.downloads.macX64}
              icon={<Apple aria-hidden className="h-6 w-6" />}
              title="Mac · Intel"
            />
            <DownloadCard
              description="For 64-bit Windows 10 and Windows 11."
              href={release?.downloads.windowsX64}
              icon={<MonitorDown aria-hidden className="h-6 w-6" />}
              title="Windows · x64"
            />
          </div>
        </section>

        <section className="mx-auto mt-10 grid max-w-4xl gap-4 rounded-3xl border border-black/10 bg-white/75 p-6 backdrop-blur sm:grid-cols-3 sm:p-8">
          <div>
            <strong className="text-sm">Automatic checks</strong>
            <p className="mt-1 text-sm leading-5 text-black/60">
              Hive checks at startup and every six hours.
            </p>
          </div>
          <div>
            <strong className="text-sm">Visible update badge</strong>
            <p className="mt-1 text-sm leading-5 text-black/60">
              You will know when a newer version is ready.
            </p>
          </div>
          <div>
            <strong className="text-sm">Update and relaunch</strong>
            <p className="mt-1 text-sm leading-5 text-black/60">
              Install inside Hive without hunting for another file.
            </p>
          </div>
        </section>

        <footer className="py-10 text-center text-sm text-black/55">
          {release ? (
            <a
              className="underline underline-offset-4"
              href={release.releaseUrl}
            >
              Release notes and previous versions
            </a>
          ) : (
            <a
              className="underline underline-offset-4"
              href={BUZZ_RELEASES_URL}
            >
              View Hive releases on GitHub
            </a>
          )}
        </footer>
      </main>
    </div>
  );
}
