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
        description="This is your primary agent in Buzz. It follows the work you’re a part of, takes action where you want it to, and helps you decide where your attention matters."
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
            <p className="text-sm font-medium">What it can do</p>
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
                {agent.name} follows your work and answers you. It can’t act for
                you or post anywhere else.
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border/60 px-6 py-12 text-center">
          <Sparkles className="size-9 text-muted-foreground/40" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              Set up your bestie
            </p>
            <p className="text-sm text-muted-foreground">
              Configure your bestie’s persona and permissions.
            </p>
          </div>
          <Button className="mt-2" onClick={onSetUp} size="sm">
            <Bot />
            Set up your bestie
          </Button>
          <p className="mt-5 max-w-md border-t border-border/50 pt-5 text-sm italic leading-6 text-muted-foreground/70">
            A thread you were mentioned in turns into a decision while you’re
            heads down. Your bestie notices, sends you a message, and catches
            you up. You decide what to do about it.
          </p>
        </div>
      )}
    </section>
  );
}
