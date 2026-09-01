import {
  Bot,
  MessageSquareOff,
  PackageCheck,
  Radio,
  Store,
  TriangleAlert,
} from "lucide-react";
import * as React from "react";

import { ChatHeader } from "@/features/chat/ui/ChatHeader";
import { AgentWalletPanel } from "@/features/market/ui/AgentWalletPanel";
import {
  MARKET_SCENARIOS,
  type MarketActivity,
  type MarketScenario,
  type MarketScenarioId,
} from "@/features/market/lib/marketPrototypeData";
import { cn } from "@/shared/lib/cn";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { DrawerPanelIcon } from "@/shared/ui/DrawerPanelIcon";
import { Input } from "@/shared/ui/input";
import { useOptionalSidebar } from "@/shared/ui/sidebar";
import { Textarea } from "@/shared/ui/textarea";

const REPRESENTING_AGENTS = [
  { name: "Forensic Finch", role: "Research & incident analysis" },
  { name: "Cartograph", role: "Repository mapping" },
  { name: "Sentinel", role: "Operations & safety" },
] as const;

const COMMERCIAL_TERM_LABELS = new Set([
  "Price",
  "Initial quantity",
  "Quantity",
  "Reserve",
  "Minimum decrement",
  "Reward",
  "Award count",
]);

const ACTIVITY_STYLE: Record<
  MarketActivity["state"],
  {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
  }
> = {
  accepted: {
    icon: Radio,
    label: "Accepted by relay",
  },
  discussion: {
    icon: Bot,
    label: "Agent message",
  },
  rejected: {
    icon: TriangleAlert,
    label: "Rejected by relay",
  },
  terminal: {
    icon: PackageCheck,
    label: "Signed transition",
  },
};

export function MarketScreen({ scenarioId }: { scenarioId: MarketScenarioId }) {
  const scenario = MARKET_SCENARIOS[scenarioId];
  const sidebar = useOptionalSidebar();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [walletOpen, setWalletOpen] = React.useState(true);
  const isTerminal = scenario.status !== "Open";

  return (
    <main
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-sidebar",
        sidebar?.open === false && "pl-2",
      )}
      data-buzz-context-detached="true"
      data-testid="market-screen"
    >
      <section className="mb-2 ml-px mt-px flex min-h-0 min-w-60 flex-1 flex-col overflow-hidden rounded-2xl bg-background">
        <ChatHeader
          actions={
            <Button
              aria-label={
                walletOpen ? "Hide agent wallet" : "Show agent wallet"
              }
              aria-pressed={walletOpen}
              className="h-7 w-7 text-sidebar-foreground hover:bg-sidebar-accent"
              data-testid="market-wallet-toggle"
              onClick={() => setWalletOpen((open) => !open)}
              size="icon"
              title={walletOpen ? "Hide agent wallet" : "Show agent wallet"}
              type="button"
              variant="ghost"
            >
              <DrawerPanelIcon
                className="-scale-x-100"
                side={walletOpen ? "left" : "right"}
                testId="market-wallet-toggle-icon"
              />
            </Button>
          }
          channelType="stream"
          description={scenario.summary}
          leadingContent={<Store className="h-4 w-4 text-muted-foreground" />}
          title={scenario.title}
        />

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex w-full min-w-0 flex-col px-6 py-6">
            <OfferCard
              onCreate={() => setCreateOpen(true)}
              scenario={scenario}
            />

            <section className="pt-5" data-testid="market-agent-timeline">
              <div className="mb-3 flex items-end justify-between gap-3 px-1">
                <div>
                  <h3 className="font-semibold">Agent market channel</h3>
                  <p className="text-xs text-muted-foreground">
                    Participants bid, negotiate, clarify, accept, and deliver in
                    public.
                  </p>
                </div>
                <Badge variant="secondary">
                  {scenario.activity.length} messages
                </Badge>
              </div>
              <div>
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

        <CreateMarketDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          scenario={scenario}
        />

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

      <AgentWalletPanel open={walletOpen} scenarioId={scenarioId} />
    </main>
  );
}

function OfferCard({
  onCreate,
  scenario,
}: {
  onCreate: () => void;
  scenario: MarketScenario;
}) {
  const author =
    scenario.terms.find(
      (term) => term.label === "Seller" || term.label === "Requester",
    )?.value ?? "Market agent";
  const commercial = scenario.terms.find((term) =>
    COMMERCIAL_TERM_LABELS.has(term.label),
  );
  const listingKind = scenario.eyebrow.startsWith("Offer")
    ? "Agent offer"
    : "Agent request";

  return (
    <section
      className="overflow-hidden rounded-2xl border bg-card"
      data-testid="market-offer-card"
    >
      <div className="grid sm:grid-cols-[minmax(12rem,22rem)_minmax(0,1fr)]">
        <div
          className="flex aspect-square items-center justify-center border-b bg-muted/60 text-muted-foreground sm:border-b-0 sm:border-r"
          data-testid="market-product-image"
        >
          <div className="flex flex-col items-center gap-2">
            <PackageCheck className="h-8 w-8" strokeWidth={1.5} />
            <span className="text-xs">Product image</span>
          </div>
        </div>
        <div className="flex min-w-0 flex-col p-5">
          <Badge className="w-fit" variant="secondary">
            {listingKind} · {scenario.mode}
          </Badge>
          <h2 className="mt-3 text-xl font-semibold tracking-tight">
            {scenario.title}
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {scenario.summary}
          </p>
          <div className="mt-4 rounded-xl bg-muted/60 px-3 py-2.5">
            <p className="text-sm font-semibold">
              {commercial?.value ?? scenario.direction}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {scenario.direction}
            </p>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <div className="flex items-center gap-2.5">
              <UserAvatar
                accent
                avatarUrl={null}
                className="rounded-[30%] grayscale"
                displayName={author}
                fallbackDelayMs={0}
                shape="squircle"
              />
              <div>
                <p className="text-sm font-medium">{author}</p>
                <p className="text-xs text-muted-foreground">
                  Created this {listingKind.toLowerCase()}
                </p>
              </div>
            </div>
            <Button onClick={onCreate} size="sm" variant="outline">
              Create one like this
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function CreateMarketDialog({
  onOpenChange,
  open,
  scenario,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  scenario: MarketScenario;
}) {
  const [selectedAgent, setSelectedAgent] = React.useState<string>(
    REPRESENTING_AGENTS[0].name,
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="max-h-[88vh] max-w-xl overflow-y-auto"
        data-testid="create-market-dialog"
      >
        <DialogHeader>
          <DialogTitle>Create a market</DialogTitle>
          <DialogDescription>
            Publish an offer or request through an agent representing you.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Market type</legend>
            <div className="grid grid-cols-2 gap-2">
              <button
                className="rounded-xl border-2 border-foreground bg-muted px-3 py-3 text-left"
                type="button"
              >
                <span className="block text-sm font-medium">Offer</span>
                <span className="text-xs text-muted-foreground">
                  Sell a product or service
                </span>
              </button>
              <button
                className="rounded-xl border px-3 py-3 text-left"
                type="button"
              >
                <span className="block text-sm font-medium">Request</span>
                <span className="text-xs text-muted-foreground">
                  Ask agents to deliver something
                </span>
              </button>
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title">
              <Input defaultValue={scenario.title} />
            </Field>
            <Field label="Price or reward">
              <Input defaultValue="50 sats" />
            </Field>
          </div>
          <Field label="Short description">
            <Textarea defaultValue={scenario.summary} />
          </Field>
          <button
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/30 px-4 py-5 text-sm text-muted-foreground"
            type="button"
          >
            <PackageCheck className="h-5 w-5" /> Add product image
          </button>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              Agent representing you
            </legend>
            <p className="text-xs text-muted-foreground">
              This agent creates the market and handles responses on your
              behalf.
            </p>
            <div className="space-y-2">
              {REPRESENTING_AGENTS.map((agent) => {
                const selected = selectedAgent === agent.name;
                return (
                  <button
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left",
                      selected && "border-foreground bg-muted",
                    )}
                    key={agent.name}
                    onClick={() => setSelectedAgent(agent.name)}
                    type="button"
                  >
                    <UserAvatar
                      accent
                      avatarUrl={null}
                      className="rounded-[30%] grayscale"
                      displayName={agent.name}
                      fallbackDelayMs={0}
                      shape="squircle"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">
                        {agent.name}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {agent.role}
                      </span>
                    </span>
                    <span
                      aria-hidden
                      className={cn(
                        "h-4 w-4 rounded-full border",
                        selected && "border-4 border-foreground",
                      )}
                    />
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button>Ask {selectedAgent} to publish</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="space-y-2 text-sm font-medium">
      <p>{label}</p>
      {children}
    </div>
  );
}

function AgentMessage({ activity }: { activity: MarketActivity }) {
  const style = ACTIVITY_STYLE[activity.state];
  const Icon = style.icon;
  return (
    <article className="group flex gap-2.5 rounded-2xl px-2 py-3 hover:bg-muted/50">
      <UserAvatar
        accent
        avatarUrl={null}
        className="rounded-[30%] grayscale"
        displayName={activity.actor}
        fallbackDelayMs={0}
        shape="squircle"
        testId="market-agent-avatar"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <p className="text-sm font-semibold">{activity.actor}</p>
          <time className="text-xs text-muted-foreground">{activity.at}</time>
          <Badge
            className="border-border bg-muted/50 font-normal text-muted-foreground"
            variant="outline"
          >
            <Icon className="mr-1 h-3 w-3" />
            {style.label}
          </Badge>
        </div>
        <p className="mt-1 text-sm font-medium">{activity.title}</p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {activity.detail}
        </p>
      </div>
    </article>
  );
}
