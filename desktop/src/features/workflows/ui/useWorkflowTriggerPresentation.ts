import { useQuery } from "@tanstack/react-query";

import { useUsersBatchQuery } from "@/features/profile/hooks";
import { resolveUserLabel } from "@/features/profile/lib/identity";
import { useIdentityQuery } from "@/shared/api/hooks";
import { getEventById } from "@/shared/api/tauri";
import { parseConditionExpressions } from "./workflowConditionExpression";
import { workflowTriggerDescription } from "./workflowTriggerDescription";
import type { TriggerConfig } from "./workflowFormTypes";

const FULL_HEX_ID = /^[0-9a-f]{64}$/i;

export type WorkflowTriggerPresentation = {
  authorAvatarUrl?: string | null;
  authorLabel?: string;
  authorLoading?: boolean;
  description: string;
  emoji?: string;
  messageLoading?: boolean;
};

export function useWorkflowTriggerPresentation({
  trigger,
  workflowChannelId,
}: {
  trigger: TriggerConfig;
  workflowChannelId?: string | null;
}): WorkflowTriggerPresentation {
  const identityQuery = useIdentityQuery();
  const conditions = trigger.filter
    ? parseConditionExpressions(trigger.filter, trigger.on)
    : [];
  const emojiCondition = conditions?.find(
    (condition) =>
      condition.field === "trigger_emoji" && condition.operator === "equals",
  );
  const emoji =
    trigger.on === "reaction_added"
      ? emojiCondition?.value || trigger.emoji
      : undefined;
  const authorCondition = conditions?.find(
    (condition) => condition.field === "trigger_author",
  );
  const authorPubkey =
    authorCondition && FULL_HEX_ID.test(authorCondition.value)
      ? authorCondition.value
      : null;
  const profilesQuery = useUsersBatchQuery(authorPubkey ? [authorPubkey] : []);
  const authorProfile = authorPubkey
    ? profilesQuery.data?.profiles[authorPubkey.toLowerCase()]
    : undefined;
  const authorLoading = Boolean(
    authorPubkey && !authorProfile && profilesQuery.isFetching,
  );
  const authorLabel =
    authorPubkey && !authorLoading
      ? resolveUserLabel({
          currentPubkey: identityQuery.data?.pubkey,
          profiles: profilesQuery.data?.profiles,
          pubkey: authorPubkey,
        })
      : undefined;
  const messageCondition = conditions?.find(
    (condition) => condition.field === "trigger_message_id",
  );
  const messageId =
    messageCondition && FULL_HEX_ID.test(messageCondition.value)
      ? messageCondition.value
      : null;
  const messageQuery = useQuery({
    enabled: Boolean(messageId),
    queryKey: ["workflow-trigger-message", workflowChannelId, messageId],
    queryFn: () => getEventById(messageId ?? ""),
    retry: false,
    staleTime: 60_000,
  });
  const message =
    messageQuery.data &&
    (!workflowChannelId ||
      messageQuery.data.tags.some(
        (tag) => tag[0] === "h" && tag[1] === workflowChannelId,
      ))
      ? messageQuery.data
      : null;
  const messageLoading = Boolean(
    messageId && messageQuery.isFetching && !messageQuery.data,
  );

  return {
    authorAvatarUrl: authorProfile?.avatarUrl,
    authorLabel,
    authorLoading,
    description: workflowTriggerDescription(trigger, {
      authorLoading,
      authorLabel,
      messageLabel: message?.content.trim() || undefined,
      messageLoading,
    }),
    emoji,
    messageLoading,
  };
}
