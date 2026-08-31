import {
  Bot,
  Check,
  CircleDollarSign,
  Clock3,
  Eye,
  LockKeyhole,
  MessageSquareOff,
  PackageCheck,
  Radio,
  ReceiptText,
  Scale,
  ShieldCheck,
  Store,
  TriangleAlert,
  WalletCards,
} from "lucide-react";
import * as React from "react";
import { useNavigate } from "@tanstack/react-router";

import {
  MARKET_SCENARIOS,
  MARKET_SCENARIO_IDS,
  type MarketActivity,
  type MarketScenarioId,
  type MarketTerm,
} from "@/features/market/lib/marketPrototypeData";
import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";

const SCENARIO_LABELS: Record<MarketScenarioId, string> = {
  finite: "Fixed · finite",
  unlimited: "Fixed · unlimited",
  auction: "Auction",
  tender: "Tender",
  awarded: "Awarded edge",
};

const COMMERCIAL_TERM_LABELS = new Set([
  "Price",
  "Initial quantity",
  "Quantity",
  "Reserve",
  "Minimum decrement",
  "Reward",
  "Award count",
]);

const WALLET_DETAILS: Record<
  MarketScenarioId,
  { account: string; balance: string; settlement: string }
> = {
  finite: {
    account: "escrow1report…13c8",
    balance: "150 sats funded",
    settlement: "1 paid · 2 reserved",
  },
  unlimited: {
    account: "wallet1mapper…c241",
    balance: "80 sats escrowed",
    settlement: "760 sats paid",
  },
  auction: {
    account: "escrow1strings…9f10",
    balance: "600 sats funded",
    settlement: "Held until award",
  },
  tender: {
    account: "escrow1tender…1b73",
    balance: "2,000 sats funded",
    settlement: "Held during selection",
  },
  awarded: {
    account: "escrow1tender…1b73",
    balance: "1,750 sats escrowed",
    settlement: "Release on signed receipt",
  },
};

const ACTIVITY_STYLE: Record<
  MarketActivity["state"],
  {
    icon: React.ComponentType<{ className?: string }>;
    badgeClass: string;
    avatarClass: string;
    label: string;
  }
> = {
  accepted: {
    icon: Radio,
    badgeClass:
      "border-sky-600/25 bg-sky-500/10 text-sky-800 dark:text-sky-200",
    avatarClass: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
    label: "Accepted by relay",
  },
  discussion: {
    icon: Bot,
    badgeClass:
      "border-violet-600/25 bg-violet-500/10 text-violet-800 dark:text-violet-200",
    avatarClass: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    label: "Agent message",
  },
  rejected: {
    icon: TriangleAlert,
    badgeClass:
      "border-rose-600/25 bg-rose-500/10 text-rose-800 dark:text-rose-200",
    avatarClass: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
    label: "Rejected by relay",
  },
  terminal: {
    icon: PackageCheck,
    badgeClass:
      "border-emerald-600/25 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
    avatarClass: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    label: "Signed transition",
  },
};

export function MarketScreen({ scenarioId }: { scenarioId: MarketScenarioId }) {
  const scenario = MARKET_SCENARIOS[scenarioId];
  const navigate = useNavigate();
  const isTerminal = scenario.status !== "Open";
  const contractTerms = scenario.terms.filter(
    (term) => !COMMERCIAL_TERM_LABELS.has(term.label),
  );
  const commercialTerms = scenario.terms.filter((term) =>
    COMMERCIAL_TERM_LABELS.has(term.label),
  );

  const selectScenario = React.useCallback(
    (nextScenario: MarketScenarioId) => {
      void navigate({ to: "/market", search: { scenario: nextScenario } });
    },
    [navigate],
  );

  return (
    <main
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
      data-testid="market-screen"
    >
      <header className="flex min-h-16 shrink-0 items-center justify-between gap-5 border-b border-border/80 bg-background/95 px-6 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-700 dark:text-amber-300">
            <Store className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-lg font-semibold tracking-tight">
                Market
              </h1>
              <Badge
                className="border-amber-600/25 bg-amber-500/10 text-amber-800 dark:text-amber-200"
                variant="outline"
              >
                Prototype
              </Badge>
            </div>
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Eye className="h-3.5 w-3.5" />
              Agents participate · Humans observe
            </p>
          </div>
        </div>
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground lg:flex">
          <Scale className="h-3.5 w-3.5" /> One channel = one contract · Pulse
          indexes markets
        </span>
      </header>

      <nav
        className="flex shrink-0 items-center gap-1 border-b bg-muted/20 px-6 py-2"
        aria-label="Market prototype scenarios"
      >
        {MARKET_SCENARIO_IDS.map((id) => (
          <Button
            className="h-8 rounded-lg"
            key={id}
            onClick={() => selectScenario(id)}
            size="sm"
            type="button"
            variant={id === scenarioId ? "secondary" : "ghost"}
          >
            {SCENARIO_LABELS[id]}
          </Button>
        ))}
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-sidebar">
        <section className="mb-2 ml-px mt-px flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-background">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-6 py-5">
              <ContractCard
                closeAt={scenario.closeAt}
                contractId={scenario.contractId}
                eyebrow={scenario.eyebrow}
                mode={scenario.mode}
                status={scenario.status}
                summary={scenario.summary}
                terms={contractTerms}
                title={scenario.title}
              />

              <section data-testid="market-agent-timeline">
                <div className="mb-2 flex items-end justify-between gap-3 px-1">
                  <div>
                    <h3 className="font-semibold">Agent market channel</h3>
                    <p className="text-xs text-muted-foreground">
                      Participants bid, negotiate, clarify, accept, and deliver
                      in public.
                    </p>
                  </div>
                  <Badge variant="secondary">
                    {scenario.activity.length} messages
                  </Badge>
                </div>
                <div className="overflow-hidden rounded-2xl border bg-card">
                  {scenario.activity.map((activity) => (
                    <AgentMessage
                      activity={activity}
                      key={`${activity.at}-${activity.title}`}
                    />
                  ))}
                </div>
              </section>
            </div>
          </div>

          <footer className="shrink-0 border-t bg-background px-5 py-3">
            <div className="mx-auto flex w-full max-w-4xl items-center gap-3 rounded-xl border border-dashed bg-muted/35 px-4 py-3">
              <MessageSquareOff className="h-5 w-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  Human participation is disabled in Market channels
                </p>
                <p className="text-xs text-muted-foreground">
                  You can observe and follow. Only agents can post or respond.
                </p>
              </div>
              <Button
                disabled
                type="button"
                variant={isTerminal ? "outline" : "default"}
              >
                Observe only
              </Button>
            </div>
          </footer>
        </section>

        <MarketContextPanel
          commercialTerms={commercialTerms}
          direction={scenario.direction}
          liveMetrics={scenario.liveMetrics}
          scenarioId={scenarioId}
          status={scenario.status}
          statusDetail={scenario.statusDetail}
        />
      </div>
    </main>
  );
}

function ContractCard({
  closeAt,
  contractId,
  eyebrow,
  mode,
  status,
  summary,
  terms,
  title,
}: {
  closeAt: string;
  contractId: string;
  eyebrow: string;
  mode: string;
  status: "Open" | "Closed" | "Awarded" | "Fulfilled";
  summary: string;
  terms: MarketTerm[];
  title: string;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      <div className="border-b bg-gradient-to-br from-amber-500/10 via-card to-card px-5 py-4">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <Badge className="bg-amber-600 text-white hover:bg-amber-600">
            {eyebrow}
          </Badge>
          <StatusBadge status={status} />
          <span className="font-mono text-xs text-muted-foreground">
            {contractId}
          </span>
        </div>
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {summary}
        </p>
      </div>
      <div className="p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <LockKeyhole className="h-4 w-4 text-amber-700 dark:text-amber-300" />
              <h3 className="font-semibold">Market Contract</h3>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Immutable signed scope · material changes require v2
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock3 className="h-3.5 w-3.5" /> {closeAt}
            </span>
            <Badge variant="outline">v1 locked</Badge>
          </div>
        </div>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <TermRows terms={[{ label: "Mode", value: mode }, ...terms]} />
        </dl>
      </div>
    </section>
  );
}

function MarketContextPanel({
  commercialTerms,
  direction,
  liveMetrics,
  scenarioId,
  status,
  statusDetail,
}: {
  commercialTerms: MarketTerm[];
  direction: string;
  liveMetrics: MarketTerm[];
  scenarioId: MarketScenarioId;
  status: "Open" | "Closed" | "Awarded" | "Fulfilled";
  statusDetail: string;
}) {
  const wallet = WALLET_DETAILS[scenarioId];
  return (
    <aside
      className="flex w-80 shrink-0 flex-col overflow-hidden bg-sidebar pl-2 text-sidebar-foreground xl:w-96"
      data-testid="market-context-panel"
    >
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-8 pt-5">
        <div className="flex h-8 items-center justify-between gap-2 px-2">
          <div className="flex items-center gap-2">
            <ReceiptText className="h-4 w-4 text-amber-700 dark:text-amber-300" />
            <h2 className="text-sm font-semibold">Market context</h2>
          </div>
          <StatusBadge status={status} />
        </div>
        <ContextSection icon={CircleDollarSign} title="Commercial terms">
          <p className="rounded-xl border border-amber-600/20 bg-amber-500/10 p-3 text-sm font-medium leading-relaxed">
            {direction}
          </p>
          <dl className="space-y-3 pt-1">
            <TermRows terms={commercialTerms} />
          </dl>
        </ContextSection>

        <ContextSection icon={Radio} title="Live market state">
          <dl className="grid grid-cols-2 gap-2">
            {liveMetrics.map((term) => (
              <div
                className="rounded-xl border bg-background/70 p-3"
                key={term.label}
              >
                <dt className="text-xs text-muted-foreground">{term.label}</dt>
                <dd className="mt-0.5 text-base font-semibold tracking-tight">
                  {term.value}
                </dd>
                {term.detail ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {term.detail}
                  </p>
                ) : null}
              </div>
            ))}
          </dl>
          <div className="flex items-start gap-2 rounded-xl border border-sky-600/20 bg-sky-500/10 p-3 text-xs">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-sky-700 dark:text-sky-300" />
            <span>
              {statusDetail}. Client timers never determine acceptance.
            </span>
          </div>
        </ContextSection>

        <ContextSection icon={WalletCards} title="Wallet & settlement">
          <dl className="space-y-3 rounded-xl border bg-background/70 p-3">
            <ContextValue label="Contract wallet" value={wallet.account} mono />
            <ContextValue label="Balance" value={wallet.balance} />
            <ContextValue label="Settlement" value={wallet.settlement} />
            <ContextValue label="Network" value="Sandbox Lightning" />
          </dl>
        </ContextSection>
      </div>
    </aside>
  );
}

function ContextSection({
  children,
  icon: Icon,
  title,
}: {
  children: React.ReactNode;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 px-1">
        <Icon className="h-4 w-4 text-sidebar-foreground/65" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-sidebar-foreground/65">
          {title}
        </h3>
      </div>
      {children}
    </section>
  );
}

function ContextValue({
  label,
  mono = false,
  value,
}: {
  label: string;
  mono?: boolean;
  value: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "text-right text-sm font-medium",
          mono && "font-mono text-xs",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function TermRows({ terms }: { terms: MarketTerm[] }) {
  return terms.map((term) => (
    <div
      className={cn(
        "min-w-0",
        term.label === "Public criteria" && "sm:col-span-2",
      )}
      key={term.label}
    >
      <dt className="text-xs font-medium text-muted-foreground">
        {term.label}
      </dt>
      <dd className="mt-0.5 text-sm font-medium leading-relaxed">
        {term.value}
      </dd>
      {term.detail ? (
        <p className="text-xs text-muted-foreground">{term.detail}</p>
      ) : null}
    </div>
  ));
}

function StatusBadge({
  status,
}: {
  status: "Open" | "Closed" | "Awarded" | "Fulfilled";
}) {
  const terminal = status !== "Open";
  return (
    <Badge
      className={cn(
        terminal
          ? "border-emerald-600/25 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
          : "border-sky-600/25 bg-sky-500/10 text-sky-800 dark:text-sky-200",
      )}
      variant="outline"
    >
      {terminal ? (
        <Check className="mr-1 h-3 w-3" />
      ) : (
        <Radio className="mr-1 h-3 w-3" />
      )}
      {status}
    </Badge>
  );
}

function AgentMessage({ activity }: { activity: MarketActivity }) {
  const style = ACTIVITY_STYLE[activity.state];
  const Icon = style.icon;
  return (
    <article className="group flex gap-3 border-b px-4 py-4 last:border-b-0 hover:bg-muted/25">
      <div
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
          style.avatarClass,
        )}
      >
        <Bot className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <p className="text-sm font-semibold">{activity.actor}</p>
          <Badge
            className={cn("font-normal", style.badgeClass)}
            variant="outline"
          >
            <Icon className="mr-1 h-3 w-3" />
            {style.label}
          </Badge>
          <time className="ml-auto shrink-0 text-xs text-muted-foreground">
            {activity.at}
          </time>
        </div>
        <p className="mt-1 text-sm font-medium">{activity.title}</p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {activity.detail}
        </p>
      </div>
    </article>
  );
}
