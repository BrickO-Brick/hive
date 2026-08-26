import {
  resolveUserLabel,
  type UserProfileLookup,
} from "@/features/profile/lib/identity";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { Markdown } from "@/shared/ui/markdown";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { useAgentSessionTranscriptVariant } from "../agentSessionTranscriptContext";
import { formatTranscriptTimestampTitle } from "../agentSessionUtils";
import type { TranscriptItem } from "../agentSessionTypes";
import { ToolActivity } from "./ToolActivity";
import { TranscriptTimestamp } from "./TranscriptTimestamp";
import type { ActivityRenderClassItemProps } from "./types";
import { UserMessageBubble } from "./UserMessageBubble";

export function MessageActivity(props: ActivityRenderClassItemProps) {
  if (props.item.type === "tool") {
    return <ToolActivity {...props} />;
  }
  if (props.item.type !== "message") {
    return null;
  }

  return (
    <MessageItem
      agentAvatarUrl={props.agentAvatarUrl}
      agentName={props.agentName}
      agentPubkey={props.agentPubkey}
      item={props.item}
      profiles={props.profiles}
    />
  );
}

function MessageItem({
  agentAvatarUrl,
  agentName,
  agentPubkey,
  item,
  profiles,
}: {
  agentAvatarUrl: string | null;
  agentName: string;
  agentPubkey: string;
  item: Extract<TranscriptItem, { type: "message" }>;
  profiles?: UserProfileLookup;
}) {
  const variant = useAgentSessionTranscriptVariant();
  const isCompactPreview = variant === "compactPreview";
  const isConversation = variant === "conversation";
  const isAssistant = item.role === "assistant";
  const text = item.text.trim();
  const messageLink = getTranscriptMessageLink(item);
  // The identity row must resolve the agent through the profiles lookup first,
  // exactly as `ToolItem` (ToolItem.tsx:45-52) and the panel header
  // (AgentSessionThreadPanel.tsx:243-249) already do for the same agent on the
  // same surface. The `agentAvatarUrl`/`agentName` props only carry what the
  // *caller's* agent record holds, and the primary channel flow's record
  // (`ChannelAgentSessionAgent`) has no avatar field at all — so relying on the
  // prop alone showed initials for every channel-opened session while the
  // managed-agent panel showed the real avatar. Resolving here keeps the row
  // agreeing with the header directly above it; the props stay as the fallback
  // for callers that have an avatar the lookup does not (a locally managed
  // agent whose avatar was never published to a relay profile).
  const agentProfile = profiles?.[normalizePubkey(agentPubkey)] ?? null;
  const resolvedAgentAvatarUrl = agentProfile?.avatarUrl ?? agentAvatarUrl;
  const resolvedAgentName = resolveUserLabel({
    pubkey: agentPubkey,
    fallbackName: agentName,
    profiles,
    preferResolvedSelfLabel: true,
  });

  if (!isAssistant) {
    return (
      <UserMessageBubble
        footer={
          <TranscriptTimestamp
            messageLink={messageLink}
            timestamp={item.timestamp}
          />
        }
        item={item}
        profiles={profiles}
      />
    );
  }

  return (
    <div
      className="flex flex-row animate-in fade-in duration-200 motion-reduce:animate-none"
      data-role="assistant-message"
      data-testid="transcript-assistant-message"
    >
      <div className="group relative flex w-full min-w-0 flex-col items-start gap-1">
        {isConversation ? (
          // berd labels every agent turn with a small identity row above the
          // prose — 20px round avatar + name at `text-xs`, `mb-0.5`, `gap-1`
          // (MessageBubble.tsx:961-981). Without it the reply reads as
          // unattributed body text in a full-cover view, which was the largest
          // single divergence from berd. Only the conversation variant gets it:
          // the other variants' markup is pinned by the byte-for-byte fixture.
          <div
            className="mb-0.5 flex items-center gap-1 text-xs"
            data-testid="transcript-assistant-identity"
          >
            {/*
             * The avatar is decorative here: `UserAvatar` exposes either an
             * image named `${displayName} avatar` or its fallback initials, and
             * the agent's name already follows as visible text, so an
             * unhidden avatar makes a screen reader announce the same identity
             * twice for every agent turn. The visible name is the row's single
             * accessible identity. Hidden at this call site rather than by
             * teaching the shared `UserAvatar` a decorative mode: other rows
             * that pair an avatar with adjacent name text (for example
             * `ForumPostCard.tsx:91-99`) have the same shape and would want the
             * same treatment, but changing the shared component's accessible
             * name affects all 45 of its call sites and is not this PR's scope.
             *
             * `size="xs"` is already 20px (`h-5 w-5`) in UserAvatar.
             */}
            <span aria-hidden="true" className="flex shrink-0">
              <UserAvatar
                avatarUrl={resolvedAgentAvatarUrl}
                displayName={resolvedAgentName}
                size="xs"
              />
            </span>
            <span className="min-w-0 truncate font-normal text-foreground">
              {resolvedAgentName}
            </span>
          </div>
        ) : null}
        <div
          className={
            isCompactPreview
              ? "w-full min-w-0 text-xs leading-4"
              : "w-full min-w-0 text-sm"
          }
          title={formatTranscriptTimestampTitle(item.timestamp)}
        >
          <Markdown
            className={
              isCompactPreview
                ? "text-xs leading-4"
                : isConversation
                  ? // Focus mode reads as prose: no box, comfortable line
                    // height, and full-fidelity markdown/code from the shared
                    // renderer.
                    "leading-relaxed"
                  : "leading-5"
            }
            content={text || " "}
          />
        </div>
      </div>
    </div>
  );
}

function getTranscriptMessageLink(
  item: Extract<TranscriptItem, { type: "message" }>,
) {
  if (!item.channelId || !item.messageId) return null;
  return {
    channelId: item.channelId,
    messageId: item.messageId,
  };
}
