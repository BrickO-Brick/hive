import {
  ArrowUp,
  AtSign,
  Bot,
  ChevronLeft,
  ChevronRight,
  FolderKanban,
  Hash,
  Headphones,
  Home,
  Lock,
  MoreVertical,
  Paperclip,
  Plus,
  Search,
  Smile,
  TerminalSquare,
  Users,
} from "lucide-react";
import * as React from "react";

import { ChannelIntroBlock } from "@/features/messages/ui/ChannelIntroBlock";
import { ComposerDockBackdrop } from "@/features/messages/ui/ComposerDockBackdrop";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { BuzzMark } from "@/shared/ui/buzz-logo/BuzzMark";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";

const CHANNEL_ROW_CLASS =
  "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-black/[0.06]";
const WELCOME_TEAM = [
  { name: "Fizz", image: "/onboarding/starter-team/fizz.png" },
  { name: "Honey", image: "/onboarding/starter-team/honey.png" },
  { name: "Pollen", image: "/onboarding/starter-team/pollen.png" },
] as const;
const WELCOME_PREVIEW_MESSAGE =
  "Hi, I'm Fizz. Welcome to Buzz.\n\nI can help you get oriented, answer questions, and make the first few steps feel less mysterious.\n\nFeel free to ask me what else you can do in Buzz, or just talk through what you want to build.";

type PreviewThemeStyle = React.CSSProperties & Record<`--${string}`, string>;

const PREVIEW_APP_THEME: PreviewThemeStyle = {
  colorScheme: "light",
  "--accent": "0 0% 94%",
  "--accent-foreground": "0 0% 10%",
  "--background": "0 0% 100%",
  "--border": "0 0% 87%",
  "--card": "0 0% 100%",
  "--card-foreground": "0 0% 10%",
  "--foreground": "0 0% 10%",
  "--input": "0 0% 84%",
  "--muted": "0 0% 94%",
  "--muted-foreground": "0 0% 42%",
  "--popover": "0 0% 100%",
  "--popover-foreground": "0 0% 10%",
  "--primary": "0 0% 10%",
  "--primary-foreground": "0 0% 100%",
  "--ring": "0 0% 20%",
  "--secondary": "0 0% 96%",
  "--secondary-foreground": "0 0% 10%",
  "--sidebar": "48 48% 88%",
  "--sidebar-accent": "0 0% 100%",
  "--sidebar-accent-foreground": "0 0% 10%",
  "--sidebar-background": "48 48% 88%",
  "--sidebar-border": "0 0% 60%",
  "--sidebar-foreground": "0 0% 18%",
  "--sidebar-ring": "0 0% 20%",
};

function PreviewAvatar({
  avatarUrl,
  label,
  size = "small",
}: {
  avatarUrl: string;
  label: string;
  size?: "small" | "message";
}) {
  const className =
    size === "message"
      ? "h-9 w-9 rounded-lg text-xs"
      : "h-8 w-8 rounded-lg text-xs";
  if (avatarUrl) {
    return (
      <ProfileAvatar
        avatarUrl={avatarUrl}
        className={className}
        label={label}
      />
    );
  }

  return (
    <span
      aria-label={label}
      className={cn(
        "flex shrink-0 items-center justify-center bg-black font-semibold text-white",
        className,
      )}
      role="img"
    >
      {label.trim().charAt(0).toUpperCase() || "Y"}
    </span>
  );
}

function PreviewCommunityRail({ communityName }: { communityName: string }) {
  return (
    <nav
      aria-label="Communities"
      className="flex w-14 shrink-0 flex-col items-center gap-2.5 px-2.5 pb-5 pt-12 text-black"
    >
      <button
        aria-label={communityName}
        className="relative flex size-9 items-center justify-center rounded-xl bg-black text-[#f4ef82]"
        type="button"
      >
        <span className="absolute -left-2.5 h-5 w-1 rounded-r-full bg-black" />
        <BuzzMark className="h-5 w-7" />
      </button>
      {WELCOME_TEAM.map((agent) => (
        <button
          aria-label={`${agent.name} community`}
          className="size-9 overflow-hidden rounded-xl bg-white/65"
          key={agent.name}
          type="button"
        >
          <img
            alt=""
            className="h-full w-full object-contain"
            src={agent.image}
          />
        </button>
      ))}
      <button
        aria-label="Add community"
        className="flex size-9 items-center justify-center rounded-2xl bg-white/65 text-black/65 transition-[border-radius,background-color] hover:rounded-xl hover:bg-black hover:text-white"
        type="button"
      >
        <Plus className="size-4" />
      </button>
    </nav>
  );
}

function PreviewSidebar({
  avatarUrl,
  channelName,
  communityName,
  profileName,
  onPreviewAction,
}: {
  avatarUrl: string;
  channelName: string;
  communityName: string;
  profileName: string;
  onPreviewAction: (action: string) => void;
}) {
  return (
    <aside className="flex w-[344px] shrink-0 flex-col pb-2 pr-2 pt-10 text-black/80">
      <div className="flex h-9 items-center gap-0.5 px-2">
        <Button
          aria-label="Go back"
          className="size-7 rounded-md text-black/35"
          disabled
          size="icon"
          variant="ghost"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          aria-label="Go forward"
          className="size-7 rounded-md text-black/35"
          disabled
          size="icon"
          variant="ghost"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      <div className="px-2 pb-3 pt-1">
        <button
          className="flex h-9 w-full items-center gap-2 rounded-lg bg-white/25 px-3 text-sm text-black/45 transition-colors hover:bg-white/45"
          onClick={() => onPreviewAction("Search")}
          type="button"
        >
          <Search className="size-4" />
          <span className="flex-1 text-left">Search everything</span>
          <span className="text-xs">⌘K</span>
        </button>
      </div>

      <nav aria-label="Workspace" className="space-y-0.5 px-2">
        <button className={CHANNEL_ROW_CLASS} type="button">
          <Home className="size-4 text-black/50" />
          Home
        </button>
        <button className={CHANNEL_ROW_CLASS} type="button">
          <FolderKanban className="size-4 text-black/50" />
          Projects
        </button>
        <button className={CHANNEL_ROW_CLASS} type="button">
          <Bot className="size-4 text-black/50" />
          Agents
        </button>
      </nav>

      <div className="mt-5 flex items-center justify-between px-4 text-xs font-medium text-black/45">
        <span>Channels</span>
        <Plus className="size-3.5" />
      </div>
      <div className="mt-1 space-y-0.5 px-2">
        <button className={CHANNEL_ROW_CLASS} type="button">
          <Hash className="size-4 text-black/45" />
          general
        </button>
        <button className={CHANNEL_ROW_CLASS} type="button">
          <Hash className="size-4 text-black/45" />
          welcome-everyone
        </button>
        <button
          className={cn(CHANNEL_ROW_CLASS, "bg-black/[0.07] font-semibold")}
          type="button"
        >
          <Lock className="size-4 text-black/55" />
          {channelName}
        </button>
      </div>

      <div className="mt-5 px-4 text-xs font-medium text-black/45">
        Direct messages
      </div>
      <div className="mt-1 space-y-0.5 px-2">
        {WELCOME_TEAM.map((agent) => (
          <button className={CHANNEL_ROW_CLASS} key={agent.name} type="button">
            <span className="relative size-6 shrink-0">
              <img
                alt=""
                className="size-6 rounded-lg object-contain"
                src={agent.image}
              />
              <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full border border-[#dfe5cf] bg-emerald-500" />
            </span>
            {agent.name}
          </button>
        ))}
      </div>

      <button
        className="mt-auto flex items-center gap-2 rounded-xl px-2 py-2 text-left hover:bg-black/[0.05]"
        onClick={() => onPreviewAction("Profile")}
        type="button"
      >
        <PreviewAvatar avatarUrl={avatarUrl} label={profileName} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-black/85">
            {profileName}
          </p>
          <p className="truncate text-xs text-black/45">🐝 {communityName}</p>
        </div>
      </button>
    </aside>
  );
}

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
  const [activePreviewAction, setActivePreviewAction] = React.useState<
    string | null
  >(null);
  const channelName = "Welcome";
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
        icon: <Hash aria-hidden className="size-4" />,
        label: "Browse channels",
        onClick: () => setActivePreviewAction("Browse channels"),
        testId: "welcome-intro-action-browse-channels",
      },
      {
        icon: <Plus aria-hidden className="size-4" />,
        label: "Create a channel",
        onClick: () => setActivePreviewAction("Create a channel"),
        testId: "welcome-intro-action-create-channel",
      },
      {
        icon: <Bot aria-hidden className="size-4" />,
        label: "Create an agent",
        onClick: () => setActivePreviewAction("Create an agent"),
        testId: "welcome-intro-action-create-agent",
      },
    ],
    channelKindLabel: "private welcome channel",
    channelName,
    description: null,
  };

  return (
    <div
      className="flex h-dvh w-full overflow-hidden bg-[linear-gradient(145deg,#f3ed8d_0%,#dce8bf_48%,#c8dde8_100%)] text-foreground"
      data-testid="onboarding-preview-community-home"
      style={PREVIEW_APP_THEME}
    >
      <StartupWindowDragRegion />
      <PreviewCommunityRail communityName={communityName} />
      <PreviewSidebar
        avatarUrl={avatarUrl}
        channelName={channelName}
        communityName={communityName}
        onPreviewAction={setActivePreviewAction}
        profileName={profileName}
      />

      <main className="relative z-10 m-2 ml-0 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-white text-black shadow-[-1px_0_0_0_rgb(0_0_0_/_0.08)]">
        <header
          className="relative z-30 shrink-0 cursor-default select-none bg-white px-5 py-2"
          data-testid="chat-header"
          data-tauri-drag-region
        >
          <div className="flex h-9 min-w-0 items-center gap-2.5">
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <Lock className="size-4 text-black/45" />
              <h1
                className="min-w-0 truncate text-base font-semibold leading-6 tracking-tight"
                data-testid="chat-title"
              >
                {channelName}
              </h1>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                aria-label="Open terminal"
                className="size-9 rounded-xl"
                size="icon"
                variant="outline"
              >
                <TerminalSquare className="size-4" />
              </Button>
              <Button
                aria-label="View members"
                className="h-9 gap-2 rounded-xl px-3"
                variant="outline"
              >
                <Users className="size-4" />
                <span>4</span>
              </Button>
              <Button
                aria-label="Start huddle"
                className="size-9 rounded-xl"
                size="icon"
                variant="outline"
              >
                <Headphones className="size-4" />
              </Button>
              <Button
                aria-label="More channel actions"
                className="size-9 rounded-xl"
                size="icon"
                variant="outline"
              >
                <MoreVertical className="size-4" />
              </Button>
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-48 pt-5">
          <div className="mx-auto w-full max-w-[920px]">
            <ChannelIntroBlock intro={intro} />

            <div className="mt-8 flex items-start gap-3 px-3 text-left">
              <img
                alt="Fizz"
                className="size-9 rounded-lg object-contain"
                src="/onboarding/starter-team/fizz.png"
              />
              <div className="min-w-0 max-w-[680px]">
                <div className="flex items-baseline gap-2">
                  <p className="text-sm font-semibold">Fizz</p>
                  <p className="text-xs text-muted-foreground">Now</p>
                </div>
                <p className="mt-1 whitespace-pre-line text-sm leading-5">
                  {WELCOME_PREVIEW_MESSAGE}
                </p>
              </div>
            </div>

            {messages.map((message, index) => (
              <div
                className="mt-6 flex items-start gap-3 px-3 text-left"
                key={`${message}-${index.toString()}`}
              >
                <PreviewAvatar
                  avatarUrl={avatarUrl}
                  label={profileName}
                  size="message"
                />
                <div>
                  <div className="flex items-baseline gap-2">
                    <p className="text-sm font-semibold">{profileName}</p>
                    <p className="text-xs text-muted-foreground">Now</p>
                  </div>
                  <p className="mt-1 text-sm leading-5">{message}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 isolate before:absolute before:inset-x-0 before:bottom-0 before:-z-10 before:h-24 before:bg-gradient-to-b before:from-transparent before:to-white before:content-[''] after:absolute after:inset-x-0 after:bottom-0 after:-z-10 after:h-12 after:bg-white after:content-['']">
          <div className="composer-dock composer-overlay-corner-masks relative pointer-events-auto">
            <ComposerDockBackdrop gutterClassName="inset-x-4" />
            <form
              className="relative z-10 mx-4 mb-3 rounded-2xl border border-black/10 bg-white/95 px-4 pb-3 pt-3 backdrop-blur-md"
              data-testid="message-composer"
              onSubmit={submitDraft}
            >
              <textarea
                aria-label={`Message ${channelName}`}
                className="min-h-11 w-full resize-none bg-transparent text-sm leading-5 outline-none placeholder:text-black/45"
                data-testid="welcome-preview-composer-input"
                onChange={(event) => setDraft(event.target.value)}
                placeholder={`Message #${channelName}`}
                rows={2}
                value={draft}
              />
              <div className="flex items-center gap-1">
                {[AtSign, Paperclip, Smile].map((Icon) => (
                  <Button
                    className="size-7 text-black/55"
                    key={Icon.displayName ?? Icon.name}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Icon className="size-4" />
                  </Button>
                ))}
                <Button
                  aria-label="Formatting"
                  className="size-7 text-xs font-semibold text-black/55"
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  Aa
                </Button>
                <Button
                  aria-label="Send message"
                  className="ml-auto size-9 rounded-full"
                  disabled={!draft.trim()}
                  size="icon"
                  type="submit"
                >
                  <ArrowUp className="size-4" />
                </Button>
              </div>
            </form>
          </div>
        </div>

        {activePreviewAction ? (
          <div
            className="absolute right-5 top-16 z-50 rounded-lg border border-black/10 bg-white px-3 py-2 text-xs shadow-lg"
            role="status"
          >
            {activePreviewAction}
          </div>
        ) : null}
      </main>
    </div>
  );
}
