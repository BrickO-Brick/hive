import { Hash, Search, X } from "lucide-react";
import * as React from "react";

import { buildChannelLink } from "@/features/messages/lib/channelLink";
import type { Channel } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { ACTION_TRAY_SURFACE_CLASS } from "@/shared/ui/actionTray";
import { Button } from "@/shared/ui/button";
import { POPOVER_CUSTOM_ENTER_MOTION_CLASS } from "@/shared/ui/popoverSurface";

type WelcomeChannelChipPickerProps = {
  channels: Channel[];
  insert: { id: string; url: string };
  onClose: () => void;
  onRemove: () => void;
  onSelect: (channel: Channel) => void;
  position: { left: number; top: number };
};

export function WelcomeChannelChipPicker({
  channels,
  insert,
  onClose,
  onRemove,
  onSelect,
  position,
}: WelcomeChannelChipPickerProps) {
  const [query, setQuery] = React.useState("");
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  const matchingChannels = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return channels
      .filter(
        (channel) =>
          channel.channelType !== "dm" && channel.archivedAt === null,
      )
      .filter(
        (channel) =>
          !normalizedQuery ||
          channel.name.toLowerCase().includes(normalizedQuery) ||
          channel.id.toLowerCase().includes(normalizedQuery),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [channels, query]);
  const highlightedChannel = matchingChannels[highlightedIndex];

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (matchingChannels.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((index) =>
        Math.min(index + 1, matchingChannels.length - 1),
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && highlightedChannel) {
      event.preventDefault();
      onSelect(highlightedChannel);
    }
  }

  return (
    <div
      aria-label="Edit channel"
      className={cn(
        "absolute z-30 w-80 space-y-3 rounded-xl p-4",
        ACTION_TRAY_SURFACE_CLASS,
        POPOVER_CUSTOM_ENTER_MOTION_CLASS,
      )}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      role="dialog"
      style={position}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold leading-none">Channel</p>
        <Button
          aria-label="Close chip editor"
          className="h-8 w-8"
          onClick={onClose}
          size="icon"
          type="button"
          variant="ghost"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/50">
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            aria-controls={`welcome-channel-results-${insert.id}`}
            aria-activedescendant={
              highlightedChannel
                ? `welcome-channel-result-${highlightedChannel.id}`
                : undefined
            }
            aria-expanded="true"
            aria-label="Search channels"
            aria-autocomplete="list"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlightedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search channels…"
            role="combobox"
            spellCheck={false}
            value={query}
          />
        </div>
        <div
          aria-label="Channel results"
          className="max-h-52 overflow-y-auto p-1"
          id={`welcome-channel-results-${insert.id}`}
          role="listbox"
        >
          {matchingChannels.length > 0 ? (
            matchingChannels.map((channel, index) => (
              <button
                aria-selected={insert.url === buildChannelLink(channel.id)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none",
                  index === highlightedIndex &&
                    "bg-accent text-accent-foreground",
                )}
                data-testid={`welcome-channel-result-${channel.id}`}
                id={`welcome-channel-result-${channel.id}`}
                key={channel.id}
                onClick={() => onSelect(channel)}
                onMouseMove={() => setHighlightedIndex(index)}
                role="option"
                type="button"
              >
                <Hash className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{channel.name}</span>
              </button>
            ))
          ) : (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              No channels found.
            </p>
          )}
        </div>
      </div>
      <Button
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={onRemove}
        size="sm"
        type="button"
        variant="ghost"
      >
        Remove chip
      </Button>
    </div>
  );
}
