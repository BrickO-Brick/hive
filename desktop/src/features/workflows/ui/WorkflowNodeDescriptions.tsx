import { LoaderCircle } from "lucide-react";
import { motion } from "motion/react";

import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import {
  TRIGGER_AUTHOR_LOADING_LABEL,
  TRIGGER_MESSAGE_LOADING_LABEL,
} from "./workflowTriggerDescription";

export function TriggerNodeDescription({
  authorAvatarUrl,
  authorLabel,
  authorLoading,
  description,
  messageLoading,
}: {
  authorAvatarUrl?: string | null;
  authorLabel?: string | null;
  authorLoading?: boolean;
  description: string;
  messageLoading?: boolean;
}) {
  const authorIndex = authorLabel ? description.lastIndexOf(authorLabel) : -1;
  if (!authorLabel || authorIndex < 0) {
    return (
      <TriggerDescriptionText
        authorLoading={authorLoading}
        messageLoading={messageLoading}
        text={description}
      />
    );
  }
  const prefix = description.slice(0, authorIndex).trimEnd();
  const suffix = description
    .slice(authorIndex + authorLabel.length)
    .trimStart();

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0">{prefix}</span>
      <UserAvatar
        avatarUrl={authorAvatarUrl ?? null}
        className="h-4 w-4"
        displayName={authorLabel}
        fallbackDelayMs={0}
        size="xs"
        testId="workflow-trigger-author-avatar"
      />
      <span className="min-w-0 truncate">
        {authorLabel}{" "}
        {suffix ? (
          <TriggerDescriptionText
            authorLoading={authorLoading}
            messageLoading={messageLoading}
            text={suffix}
          />
        ) : null}
      </span>
    </span>
  );
}

export function TriggerDescriptionText({
  authorLoading,
  messageLoading,
  text,
}: {
  authorLoading?: boolean;
  messageLoading?: boolean;
  text: string;
}) {
  const references = [
    authorLoading
      ? {
          ariaLabel: "Loading author",
          delay: 0,
          testId: "workflow-trigger-author-loading",
          token: TRIGGER_AUTHOR_LOADING_LABEL,
        }
      : null,
    messageLoading
      ? {
          ariaLabel: "Loading message",
          delay: 0.5,
          testId: "workflow-trigger-message-loading",
          token: TRIGGER_MESSAGE_LOADING_LABEL,
        }
      : null,
  ].filter((reference) => reference !== null);
  if (references.length === 0) return text;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const next = references
      .map((reference) => ({
        index: text.indexOf(reference.token, cursor),
        reference,
      }))
      .filter(({ index }) => index >= 0)
      .sort((left, right) => left.index - right.index)[0];
    if (!next) break;
    if (next.index > cursor) parts.push(text.slice(cursor, next.index));
    parts.push(
      <motion.span
        animate={{ opacity: 1 }}
        aria-label={next.reference.ariaLabel}
        className="inline-flex align-text-bottom"
        data-testid={next.reference.testId}
        initial={{ opacity: 0 }}
        key={`${next.reference.token}-${next.index}`}
        role="status"
        transition={{ delay: next.reference.delay, duration: 0.15 }}
      >
        <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
      </motion.span>,
    );
    cursor = next.index + next.reference.token.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length > 0 ? parts : text;
}

export function StepReactionDescription({
  description,
  emoji,
  emojiUrl,
}: {
  description: string;
  emoji: string;
  emojiUrl?: string;
}) {
  const emojiIndex = description.lastIndexOf(emoji);
  if (emojiIndex < 0) return description;

  const prefix = description.slice(0, emojiIndex);
  const suffix = description.slice(emojiIndex + emoji.length);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {prefix ? <span className="truncate">{prefix}</span> : null}
      {emojiUrl ? (
        <img
          alt={emoji}
          className="h-5 w-5 shrink-0 object-contain"
          data-testid="workflow-step-reaction-emoji"
          draggable={false}
          src={rewriteRelayUrl(emojiUrl)}
        />
      ) : (
        <span
          className="shrink-0 text-base leading-none"
          data-testid="workflow-step-reaction-emoji"
        >
          {emoji}
        </span>
      )}
      {suffix ? <span className="truncate">{suffix}</span> : null}
    </span>
  );
}
