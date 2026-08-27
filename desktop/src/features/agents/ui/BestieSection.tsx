import { Bot, MessageCircle, Settings2, Sparkles } from "lucide-react";

import {
  BESTIE_CAPABILITIES,
  type BestieCapabilityState,
} from "@/features/agents/lib/bestieCapabilities";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import type { ManagedAgent } from "@/shared/api/types";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { SectionHeader } from "@/shared/ui/PageHeader";

type BestieSectionProps = {
  agent: ManagedAgent | null;
  capabilities: BestieCapabilityState | null;
  isMessagePending: boolean;
  onManage: () => void;
  onMessage: () => void;
  onSetUp: () => void;
};

export function BestieSection({
  agent,
  capabilities,
  isMessagePending,
  onManage,
  onMessage,
  onSetUp,
}: BestieSectionProps) {
  const enabledCapabilities = capabilities
    ? BESTIE_CAPABILITIES.filter((capability) => capabilities[capability.id])
    : [];

  return (
    <section className="relative space-y-4" data-testid="agents-bestie-section">
      <SectionHeader
        description="One agent that keeps up with work connected to you and helps you decide where your attention matters."
        title="Your bestie"
      />

      {agent && capabilities ? (
        <div className="rounded-2xl border border-border/70 p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <ProfileAvatar
                avatarUrl={agent.avatarUrl}
                className="size-12"
                label={agent.name}
              />
              <div className="min-w-0">
                <p className="truncate font-semibold">{agent.name}</p>
                <p className="text-sm text-muted-foreground">Your bestie</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                disabled={isMessagePending}
                onClick={onMessage}
                size="sm"
                variant="outline"
              >
                <MessageCircle />
                {isMessagePending ? "Opening…" : `Message ${agent.name}`}
              </Button>
              <Button onClick={onManage} size="sm" variant="outline">
                <Settings2 />
                Manage
              </Button>
            </div>
          </div>

          <div className="mt-5 border-t border-border/60 pt-4">
            <p className="text-sm font-medium">What it can do right now</p>
            {enabledCapabilities.length > 0 ? (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {enabledCapabilities.map((capability) => (
                  <Badge key={capability.id} variant="secondary">
                    {capability.label}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                It can keep up with your work and answer you, but it won’t act
                for you or speak anywhere else yet.
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-border/70 p-6">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary/12 text-primary">
            <Sparkles />
          </span>
          <h3 className="mt-4 text-base font-semibold tracking-tight">
            Set up your bestie
          </h3>
          <p className="mt-1.5 max-w-xl text-sm leading-6 text-muted-foreground">
            Your bestie keeps up with conversations connected to you, catches
            you up on what changed, and tells you when joining could make a
            difference. Create a new agent or give the role to one you already
            use.
          </p>
          <Button className="mt-5" onClick={onSetUp} size="sm">
            <Bot />
            Set up your bestie
          </Button>
        </div>
      )}
    </section>
  );
}
