import { WalletCards } from "lucide-react";

import type { MarketScenarioId } from "@/features/market/lib/marketPrototypeData";
import { ProjectContextRail } from "@/features/projects/ui/ProjectContextRail";
import { ProjectHomeColumn } from "@/features/projects/ui/ProjectHomeColumn";
import { useThreadPanelWidth } from "@/shared/hooks/useThreadPanelWidth";
import { SIDEBAR_WIDTH_MIN } from "@/shared/layout/sidebarLayout";

const MARKET_WALLET_WIDTH_KEY = "buzz.desktop.market-wallet-width";

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

export function AgentWalletPanel({
  open,
  scenarioId,
}: {
  open: boolean;
  scenarioId: MarketScenarioId;
}) {
  const width = useThreadPanelWidth(undefined, {
    minWidthPx: SIDEBAR_WIDTH_MIN,
    sessionKey: MARKET_WALLET_WIDTH_KEY,
  });
  const wallet = WALLET_DETAILS[scenarioId];

  return (
    <ProjectContextRail
      open={open}
      panelWidthPx={width.widthPx}
      resizing={width.isResizing}
      rounded={false}
      testId="market-wallet-rail"
    >
      <ProjectHomeColumn
        bodyClassName="overflow-hidden"
        canResetWidth={width.canReset}
        onResetWidth={width.onResetWidth}
        onResizeStart={width.onResizeStart}
        testId="market-agent-wallet"
        widthPx={width.widthPx}
      >
        <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
          <header className="flex h-14 shrink-0 items-center gap-2 px-5">
            <WalletCards className="h-4 w-4 text-sidebar-foreground/65" />
            <h2 className="text-sm font-semibold">Agent wallet</h2>
          </header>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-6">
            <p className="text-xs text-sidebar-foreground/60">
              Settlement for this listing
            </p>
            <dl className="mt-6 space-y-5">
              <WalletValue label="Balance" value={wallet.balance} />
              <WalletValue label="Settlement" value={wallet.settlement} />
              <WalletValue label="Network" value="Sandbox Lightning" />
            </dl>
            <p className="mt-auto pt-6 font-mono text-xs text-sidebar-foreground/60">
              {wallet.account}
            </p>
          </div>
        </div>
      </ProjectHomeColumn>
    </ProjectContextRail>
  );
}

function WalletValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-sidebar-foreground/60">{label}</dt>
      <dd className="mt-1 text-sm font-medium">{value}</dd>
    </div>
  );
}
