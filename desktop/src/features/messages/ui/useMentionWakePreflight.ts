import * as React from "react";

import { getMentionOffsets } from "@/features/messages/lib/hasMention";
import type { DraftMentionRef } from "@/features/messages/lib/useDrafts";
import type { ManagedAgent } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import {
  isManagedAgentRunning,
  isProviderBackedAgent,
} from "./useMentionSendFlow.helpers";

export const MENTION_WAKE_DELAY_MS = 1_000;

export type ManagedAgentStartInput =
  | string
  | {
      pubkey: string;
      expectedRelayUrl?: string;
      expectedSignerPubkey?: string;
    };

type MentionWakePlan = {
  key: string;
  pubkeys: string[];
};

export function hasSubstantiveNonMentionText(
  content: string,
  mentionRefs: readonly DraftMentionRef[],
): boolean {
  const remaining = content.split("");
  for (const ref of mentionRefs) {
    const mentionLength = `@${ref.displayName}`.length;
    for (const start of getMentionOffsets(content, ref.displayName)) {
      remaining.fill(" ", start, start + mentionLength);
    }
  }
  return remaining.join("").trim().length > 0;
}

export function buildMentionWakePlan({
  channelId,
  content,
  isManagedAgentPubkey,
  memberPubkeys,
  mentionRefs,
}: {
  channelId: string | null;
  content: string;
  isManagedAgentPubkey: (pubkey: string) => boolean;
  memberPubkeys: ReadonlySet<string>;
  mentionRefs: readonly DraftMentionRef[];
}): MentionWakePlan | null {
  if (!channelId || !hasSubstantiveNonMentionText(content, mentionRefs)) {
    return null;
  }
  const pubkeys = [
    ...new Set(
      mentionRefs
        .filter((ref) => ref.isAgent)
        .map((ref) => normalizePubkey(ref.pubkey))
        .filter(
          (pubkey) =>
            pubkey && memberPubkeys.has(pubkey) && isManagedAgentPubkey(pubkey),
        ),
    ),
  ].sort();
  if (pubkeys.length === 0) return null;
  return { key: `${channelId}:${pubkeys.join(",")}`, pubkeys };
}

export function useMentionWakePreflight({
  channelId,
  contentRef,
  enabled,
  expectedRelayUrl,
  expectedSignerPubkey,
  getDraftMentionRefs,
  getManagedAgentsByPubkey,
  isManagedAgentPubkey,
  memberPubkeys,
  startManagedAgent,
}: {
  channelId: string | null;
  contentRef: React.MutableRefObject<string>;
  enabled: boolean;
  expectedRelayUrl?: string;
  expectedSignerPubkey?: string;
  getDraftMentionRefs: (content: string) => DraftMentionRef[];
  getManagedAgentsByPubkey: () => Promise<Map<string, ManagedAgent>>;
  isManagedAgentPubkey: (pubkey: string) => boolean;
  memberPubkeys: ReadonlySet<string>;
  startManagedAgent: (input: ManagedAgentStartInput) => Promise<ManagedAgent>;
}) {
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const activePlanKeyRef = React.useRef<string | null>(null);
  const contextRef = React.useRef({
    channelId,
    contentRef,
    enabled,
    expectedRelayUrl,
    expectedSignerPubkey,
    getDraftMentionRefs,
    getManagedAgentsByPubkey,
    isManagedAgentPubkey,
    memberPubkeys,
    startManagedAgent,
  });
  contextRef.current = {
    channelId,
    contentRef,
    enabled,
    expectedRelayUrl,
    expectedSignerPubkey,
    getDraftMentionRefs,
    getManagedAgentsByPubkey,
    isManagedAgentPubkey,
    memberPubkeys,
    startManagedAgent,
  };

  const cancelMentionWake = React.useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    activePlanKeyRef.current = null;
  }, []);

  const currentPlan = React.useCallback((content: string) => {
    const context = contextRef.current;
    if (
      !context.enabled ||
      !context.expectedRelayUrl ||
      !context.expectedSignerPubkey ||
      // Mentions require a literal "@" (see getMentionOffsets), so drafts
      // without one can't produce a plan — skip the per-keystroke ref scan.
      !content.includes("@")
    ) {
      return null;
    }
    const mentionRefs = context.getDraftMentionRefs(content);
    const plan = buildMentionWakePlan({
      channelId: context.channelId,
      content,
      isManagedAgentPubkey: context.isManagedAgentPubkey,
      memberPubkeys: context.memberPubkeys,
      mentionRefs,
    });
    return plan
      ? {
          ...plan,
          key: JSON.stringify([
            context.expectedRelayUrl,
            context.expectedSignerPubkey,
            plan.key,
          ]),
        }
      : null;
  }, []);

  const prepareMentionWake = React.useCallback(
    (content: string) => {
      const plan = currentPlan(content);
      if (!plan) return cancelMentionWake();
      if (activePlanKeyRef.current === plan.key) return;

      cancelMentionWake();
      activePlanKeyRef.current = plan.key;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void (async () => {
          if (activePlanKeyRef.current !== plan.key) return;
          const beforeLookup = currentPlan(contentRef.current);
          if (beforeLookup?.key !== plan.key) return;
          const managedAgents =
            await contextRef.current.getManagedAgentsByPubkey();
          if (activePlanKeyRef.current !== plan.key) return;
          const beforeWake = currentPlan(contentRef.current);
          if (beforeWake?.key !== plan.key) return;

          const context = contextRef.current;
          await Promise.allSettled(
            beforeWake.pubkeys.flatMap((pubkey) => {
              const agent = managedAgents.get(pubkey);
              // A draft mention must never deploy remote compute; only the
              // send path may start provider-backed agents.
              return agent &&
                !isProviderBackedAgent(agent) &&
                !isManagedAgentRunning(agent)
                ? [
                    context.startManagedAgent({
                      pubkey,
                      expectedRelayUrl: context.expectedRelayUrl,
                      expectedSignerPubkey: context.expectedSignerPubkey,
                    }),
                  ]
                : [];
            }),
          );
        })();
      }, MENTION_WAKE_DELAY_MS);
    },
    [cancelMentionWake, contentRef, currentPlan],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: contextRef keeps callbacks fresh; these inputs are plan invalidation signals.
  React.useEffect(() => {
    prepareMentionWake(contentRef.current);
  }, [
    channelId,
    contentRef,
    enabled,
    expectedRelayUrl,
    expectedSignerPubkey,
    getDraftMentionRefs,
    isManagedAgentPubkey,
    memberPubkeys,
    prepareMentionWake,
  ]);

  React.useEffect(() => cancelMentionWake, [cancelMentionWake]);

  return { prepareMentionWake };
}
