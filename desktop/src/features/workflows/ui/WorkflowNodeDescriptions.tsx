import { LoaderCircle } from "lucide-react";
import { motion } from "motion/react";

import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { TRIGGER_MESSAGE_LOADING_LABEL } from "./workflowTriggerDescription";

export function TriggerNodeDescription({
  authorAvatarUrl,
  authorLabel,
  description,
  messageLoading,
}: {
  authorAvatarUrl?: string | null;
  authorLabel?: string | null;
  description: string;
  messageLoading?: boolean;
}) {
  const authorIndex = authorLabel ? description.lastIndexOf(authorLabel) : -1;
  if (!authorLabel || authorIndex < 0) {
    return (
      <TriggerDescriptionText
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
            messageLoading={messageLoading}
            text={suffix}
          />
        ) : null}
      </span>
    </span>
  );
}

function TriggerDescriptionText({
  messageLoading,
  text,
}: {
  messageLoading?: boolean;
  text: string;
}) {
  const loadingIndex = messageLoading
    ? text.indexOf(TRIGGER_MESSAGE_LOADING_LABEL)
    : -1;
  if (loadingIndex < 0) return text;

  const prefix = text.slice(0, loadingIndex);
  const suffix = text.slice(
    loadingIndex + TRIGGER_MESSAGE_LOADING_LABEL.length,
  );
  return (
    <>
      {prefix}
      <motion.span
        animate={{ opacity: 1 }}
        aria-label="Loading message"
        className="inline-flex align-text-bottom"
        data-testid="workflow-trigger-message-loading"
        initial={{ opacity: 0 }}
        role="status"
        transition={{ delay: 0.5, duration: 0.15 }}
      >
        <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
      </motion.span>
      {suffix}
    </>
  );
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
