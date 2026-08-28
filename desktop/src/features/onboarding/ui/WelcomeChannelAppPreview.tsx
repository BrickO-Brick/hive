import {
  AtSign,
  Bot,
  ChevronLeft,
  ChevronRight,
  FolderKanban,
  Hash,
  Home,
  Lock,
  Mic,
  Paperclip,
  Plus,
  Search,
  Send,
  Smile,
  Sparkles,
} from "lucide-react";
import * as React from "react";

import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { ChannelIntroBlock } from "@/features/messages/ui/ChannelIntroBlock";
import { ComposerDockBackdrop } from "@/features/messages/ui/ComposerDockBackdrop";
import { Button } from "@/shared/ui/button";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";
import { cn } from "@/shared/lib/cn";

const CHANNEL_ROW_CLASS =
  "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors";
const WELCOME_TEAM = [
  { name: "Fizz", image: "/onboarding/starter-team/fizz.png" },
  { name: "Honey", image: "/onboarding/starter-team/honey.png" },
  { name: "Pollen", image: "/onboarding/starter-team/pollen.png" },
] as const;

export function WelcomeChannelAppPreview({
  avatarUrl,
  communityName,
  displayName,
}: {
  avatarUrl: string;
  communityName: string;
  displayName: string;
}) {
  const [draft, setDraft] = React.useState("");
  const [messages, setMessages] = React.useState<string[]>([]);
  const [channelName, setChannelName] = React.useState("Welcome");
  const [showRenamePrompt, setShowRenamePrompt] = React.useState(true);
  const [activePreviewAction, setActivePreviewAction] = React.useState<
    string | null
  >(null);
  const profileName = displayName.trim() || "Your profile";
  const submitDraft = (event: React.FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message) return;
    setMessages((current) => [...current, message]);
    setDraft("");
  };

  const intro = {
    actions: [
      {
        icon: <Hash aria-hidden className="h-4 w-4" />,
        label: "Browse channels",
        onClick: () => setActivePreviewAction("Browse channels"),
        testId: "welcome-intro-action-browse-channels",
      },
      {
        icon: <Plus aria-hidden className="h-4 w-4" />,
        label: "Create a channel",
        onClick: () => setActivePreviewAction("Create a channel"),
        testId: "welcome-intro-action-create-channel",
      },
      {
        icon: <Bot aria-hidden className="h-4 w-4" />,
        label: "Create an agent",
        onClick: () => setActivePreviewAction("Create an agent"),
        testId: "welcome-intro-action-create-agent",
      },
    ],
    channelKindLabel: "private welcome channel",
    channelName,
    description: null,
    icon: <Sparkles aria-hidden className="h-7 w-7" />,
  };

  return (
    <div
      className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground"
      data-testid="onboarding-preview-community-home"
    >
      <StartupWindowDragRegion />
      <div
        className="flex h-12 shrink-0 items-center border-b border-sidebar-border bg-sidebar pl-20 pr-4 text-sidebar-foreground"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-0.5">
          <Button
            aria-label="Go back"
            className="h-7 w-6 rounded text-sidebar-foreground/45"
            disabled
            size="icon"
            variant="ghost"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            aria-label="Go forward"
            className="h-7 w-6 rounded text-sidebar-foreground/45"
            disabled
            size="icon"
            variant="ghost"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <button
          className="mx-auto flex h-7 w-full max-w-[420px] items-center justify-center gap-2 rounded-md bg-sidebar-accent/65 px-3 text-xs text-sidebar-foreground/65"
          onClick={() => setActivePreviewAction("Search")}
          type="button"
        >
          <Search className="h-3.5 w-3.5" aria-hidden />
          Search {communityName}
        </button>
        <div className="w-[72px]" aria-hidden />
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[300px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-2 text-sidebar-foreground">
          <button
            className="flex h-10 items-center gap-2 rounded-lg px-2 text-left hover:bg-sidebar-accent"
            type="button"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-foreground text-xs font-semibold text-background">
              B
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">
              {communityName}
            </span>
          </button>

          <nav className="mt-2 space-y-0.5" aria-label="Workspace">
            <button
              className={cn(CHANNEL_ROW_CLASS, "hover:bg-sidebar-accent")}
              type="button"
            >
              <Home
                className="h-4 w-4 text-sidebar-foreground/65"
                aria-hidden
              />
              Home
            </button>
            <button
              className={cn(CHANNEL_ROW_CLASS, "hover:bg-sidebar-accent")}
              type="button"
            >
              <FolderKanban
                className="h-4 w-4 text-sidebar-foreground/65"
                aria-hidden
              />
              Projects
            </button>
            <button
              className={cn(CHANNEL_ROW_CLASS, "hover:bg-sidebar-accent")}
              type="button"
            >
              <Bot className="h-4 w-4 text-sidebar-foreground/65" aria-hidden />
              Agents
            </button>
          </nav>

          <div className="mt-5 flex items-center justify-between px-2 text-xs font-medium text-sidebar-foreground/55">
            <span>Channels</span>
            <Plus className="h-3.5 w-3.5" aria-hidden />
          </div>
          <div className="mt-1 space-y-0.5">
            <button
              className={cn(CHANNEL_ROW_CLASS, "hover:bg-sidebar-accent")}
              data-testid="channel-general"
              type="button"
            >
              <Hash
                className="h-4 w-4 text-sidebar-foreground/55"
                aria-hidden
              />
              general
            </button>
            <button
              className={cn(CHANNEL_ROW_CLASS, "hover:bg-sidebar-accent")}
              data-testid="channel-welcome-everyone"
              type="button"
            >
              <Hash
                className="h-4 w-4 text-sidebar-foreground/55"
                aria-hidden
              />
              welcome-everyone
            </button>
            <button
              className={cn(
                CHANNEL_ROW_CLASS,
                "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
              )}
              data-testid="channel-Welcome"
              type="button"
            >
              <Lock className="h-4 w-4" aria-hidden />
              {channelName}
            </button>
          </div>

          <div className="mt-auto flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-sidebar-accent">
            <ProfileAvatar
              avatarUrl={avatarUrl || null}
              className="h-8 w-8 rounded-lg text-xs"
              label={profileName}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{profileName}</p>
              <p className="truncate text-xs text-sidebar-foreground/55">
                Available
              </p>
            </div>
          </div>
        </aside>

        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
          <header className="relative z-20 flex h-14 shrink-0 items-center border-b border-border/55 bg-background/80 px-5 backdrop-blur-md">
            <Lock className="h-4 w-4 text-muted-foreground" aria-hidden />
            <h1
              className="ml-1 text-base font-semibold"
              data-testid="chat-title"
            >
              {channelName}
            </h1>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-56 pt-4">
            <div className="mx-auto w-full max-w-[920px]">
              <ChannelIntroBlock intro={intro} />

              <section
                className="mx-3 mt-7 max-w-[680px] border-t border-border/60 pt-6 text-left"
                data-testid="welcome-preview-community-message"
              >
                <p className="text-lg font-semibold">
                  Welcome to {communityName}
                </p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Everyone starts with a private channel to get settled. This
                  one is yours. Use it to try out features, draft messages, or
                  work privately with agents.
                </p>
              </section>

              {showRenamePrompt ? (
                <section
                  className="mx-3 mt-6 flex max-w-[680px] items-center gap-4 rounded-2xl border border-border/70 bg-background/70 px-5 py-4 text-left"
                  data-testid="welcome-preview-rename-prompt"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <Lock className="h-4 w-4" aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">
                      Make this space yours
                    </p>
                    <p className="mt-1 text-sm leading-5 text-muted-foreground">
                      This private channel is yours to keep. Rename it for how
                      you want to use it.
                    </p>
                  </div>
                  <Button
                    className="h-9 shrink-0 rounded-full px-5"
                    onClick={() => {
                      setChannelName(
                        profileName === "Your profile"
                          ? "My space"
                          : `${profileName}’s space`,
                      );
                      setShowRenamePrompt(false);
                      setActivePreviewAction("Channel details opened");
                    }}
                    type="button"
                    variant="outline"
                  >
                    Rename channel
                  </Button>
                </section>
              ) : null}

              <section
                className="mx-3 mt-6 max-w-[680px] overflow-hidden rounded-2xl border border-border/70 bg-muted/35 text-left"
                data-testid="welcome-preview-agent-activation"
              >
                <div className="flex items-center gap-4 p-5">
                  <div className="flex shrink-0 -space-x-3">
                    {WELCOME_TEAM.map((agent) => (
                      <img
                        alt={agent.name}
                        className="h-14 w-14 rounded-2xl border-2 border-background bg-background object-contain"
                        key={agent.name}
                        src={agent.image}
                      />
                    ))}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-base font-semibold">
                        Bring your starter team online
                      </p>
                      <span className="rounded-full bg-foreground/8 px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        Not connected
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm leading-5 text-muted-foreground">
                      Connect an AI provider to start Fizz, Honey, and Pollen.
                      They can help you learn Buzz and work through something
                      you’re building.
                    </p>
                  </div>
                </div>
                <div className="flex items-center justify-between border-t border-border/60 bg-background/45 px-5 py-3">
                  <p className="text-xs text-muted-foreground">
                    You can change providers or agents later.
                  </p>
                  <Button
                    className="h-9 rounded-full px-5"
                    onClick={() =>
                      setActivePreviewAction("Connect AI provider")
                    }
                    type="button"
                  >
                    Connect AI provider
                  </Button>
                </div>
              </section>

              {messages.map((message, index) => (
                <div
                  className="mt-5 flex items-start gap-3 px-3 text-left"
                  key={`${message}-${index.toString()}`}
                >
                  <ProfileAvatar
                    avatarUrl={avatarUrl || null}
                    className="h-9 w-9 rounded-lg text-xs"
                    label={profileName}
                  />
                  <div>
                    <p className="text-sm font-semibold">{profileName}</p>
                    <p className="mt-1 text-sm leading-5">{message}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 isolate before:absolute before:inset-x-0 before:bottom-0 before:-z-10 before:h-24 before:bg-gradient-to-b before:from-transparent before:to-background before:content-[''] after:absolute after:inset-x-0 after:bottom-0 after:-z-10 after:h-12 after:bg-background after:content-['']">
            <div className="composer-dock composer-overlay-corner-masks relative pointer-events-auto">
              <ComposerDockBackdrop gutterClassName="inset-x-5" />
              <form
                className="relative z-10 mx-5 rounded-2xl border border-border/50 bg-background/80 px-4 pb-2 pt-3 shadow-none backdrop-blur-md"
                data-testid="message-composer"
                onSubmit={submitDraft}
              >
                <textarea
                  aria-label={`Message ${channelName}`}
                  className="min-h-11 w-full resize-none bg-transparent text-sm leading-5 outline-none placeholder:text-muted-foreground/65"
                  data-testid="welcome-preview-composer-input"
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={`Message #${channelName}`}
                  rows={2}
                  value={draft}
                />
                <div className="flex items-center gap-1">
                  {[Paperclip, Smile, AtSign, Mic].map((Icon) => (
                    <Button
                      className="h-7 w-7 text-muted-foreground"
                      key={Icon.displayName ?? Icon.name}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <Icon className="h-4 w-4" aria-hidden />
                    </Button>
                  ))}
                  <Button
                    aria-label="Send message"
                    className="ml-auto h-7 w-7 rounded-lg"
                    disabled={!draft.trim()}
                    size="icon"
                    type="submit"
                  >
                    <Send className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              </form>
            </div>
          </div>

          {activePreviewAction ? (
            <div
              className="absolute right-5 top-16 z-50 rounded-lg border border-border bg-background px-3 py-2 text-xs shadow-lg"
              role="status"
            >
              {activePreviewAction}
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}
