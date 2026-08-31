import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import {
  isMarketScenarioId,
  type MarketScenarioId,
} from "@/features/market/lib/marketPrototypeData";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

type MarketRouteSearch = {
  scenario?: MarketScenarioId;
};

export const Route = createFileRoute("/market")({
  validateSearch: (search: Record<string, unknown>): MarketRouteSearch => ({
    scenario: isMarketScenarioId(search.scenario) ? search.scenario : undefined,
  }),
  component: MarketRouteComponent,
});

const MarketScreen = React.lazy(async () => {
  const module = await import("@/features/market/ui/MarketScreen");
  return { default: module.MarketScreen };
});

function MarketRouteComponent() {
  const search = Route.useSearch();
  return (
    <React.Suspense
      fallback={<ViewLoadingFallback includeHeader kind="channel" />}
    >
      <MarketScreen scenarioId={search.scenario ?? "finite"} />
    </React.Suspense>
  );
}
