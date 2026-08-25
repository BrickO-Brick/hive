import {
  Inbox,
  RefreshCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";

import type { BestieFeedFilter } from "@/features/bestie/lib/bestieFeed";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

const FILTER_LABELS: Record<BestieFeedFilter, string> = {
  all: "Bestie",
  messages: "Messages",
  tasks: "Tasks",
};

function greetingForHour(hour: number) {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function BestieFeedHeader({
  filter,
  isLoading,
  onFilterChange,
  onOpenInbox,
  onRefresh,
  onSearchChange,
  query,
}: {
  filter: BestieFeedFilter;
  isLoading: boolean;
  onFilterChange: (filter: BestieFeedFilter) => void;
  onOpenInbox: () => void;
  onRefresh: () => void;
  onSearchChange: (query: string) => void;
  query: string;
}) {
  return (
    <>
      <div className="mx-auto max-w-3xl">
        <div aria-hidden="true" className="text-4xl">
          🐝
        </div>
        <h1 className="mt-5 max-w-xl text-balance text-3xl font-medium leading-tight tracking-tight text-muted-foreground sm:text-4xl">
          {greetingForHour(new Date().getHours())}. Here’s what’s happening in
          your Buzz.
        </h1>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Badge className="normal-case tracking-normal" variant="secondary">
            Live from your Home feed
          </Badge>
          <Badge className="normal-case tracking-normal" variant="outline">
            Prototype ranking · no generated summaries
          </Badge>
        </div>
      </div>

      <div className="sticky top-3 z-30 mx-auto mt-10 flex max-w-3xl flex-col gap-3 rounded-[1.4rem] border border-border/60 bg-background/90 p-2 shadow-sm backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
        <div
          aria-label="Bestie Feed sections"
          className="flex min-w-0 items-center gap-1 overflow-x-auto"
          role="tablist"
        >
          {(Object.keys(FILTER_LABELS) as BestieFeedFilter[]).map(
            (nextFilter) => (
              <Button
                aria-selected={filter === nextFilter}
                className="rounded-full"
                data-testid={`bestie-filter-${nextFilter}`}
                key={nextFilter}
                onClick={() => onFilterChange(nextFilter)}
                role="tab"
                size="sm"
                type="button"
                variant={filter === nextFilter ? "secondary" : "ghost"}
              >
                {nextFilter === "all" ? <Sparkles /> : null}
                {FILTER_LABELS[nextFilter]}
              </Button>
            ),
          )}
          <Button
            className="rounded-full text-muted-foreground"
            data-testid="bestie-open-inbox"
            onClick={onOpenInbox}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Inbox />
            Inbox
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1 sm:w-52 sm:flex-none">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search Bestie Feed"
              className="h-8 rounded-full border-0 bg-muted/60 pl-8 shadow-none"
              data-testid="bestie-search"
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search live feed"
              value={query}
            />
          </div>
          <Button
            aria-label="Refresh live Bestie Feed"
            className="rounded-full text-muted-foreground"
            onClick={onRefresh}
            size="icon"
            title="Refresh live feed"
            type="button"
            variant="ghost"
          >
            <RefreshCcw className={isLoading ? "animate-spin" : ""} />
          </Button>
          <Button
            aria-label="Bestie Feed preferences"
            className="rounded-full text-muted-foreground"
            disabled
            size="icon"
            title="Feed preferences are coming next"
            type="button"
            variant="ghost"
          >
            <SlidersHorizontal />
          </Button>
        </div>
      </div>
    </>
  );
}
