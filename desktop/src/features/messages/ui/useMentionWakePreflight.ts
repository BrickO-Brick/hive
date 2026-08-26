import * as React from "react";

import { getMentionOffsets } from "@/features/messages/lib/hasMention";
import type { DraftMentionRef } from "@/features/messages/lib/useDrafts";
import type { ManagedAgent } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import {
  isManagedAgentRunning,
  isProviderBackedAgent,
} from "./useMentionSendFlow.helpers";

/**
 * How long the wake gates must hold continuously before a mentioned agent is
 * started speculatively.
 *
 * This measures **gate hold time, not keyboard idle time**. The gates are an
 * active channel, a known relay/signer scope, a mention of an in-channel
 * locally managed agent, and substantive draft text beyond the mention itself
 * (see `buildMentionWakePlan`). `prepareMentionWake` runs on every editor
 * update, so the window is cancelled the instant any gate stops holding —
 * dropping the mention, or trimming the draft back to the bare mention, means a
 * fresh full interval is required once the gates hold again.
 *
 * Continued typing deliberately does *not* restart the window. Typing more of a
 * message addressed to an agent is further evidence of intent, not less, and a
 * keystroke debounce would defeat the feature outright: someone who composes
 * straight through and hits Send never pauses, so the wake would never fire for
 * exactly the flow it exists to speed up.
 */
export const MENTION_WAKE_GATE_HOLD_MS = 1_000;

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

export function useMentionWakePreflight(options: {
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
  // Latest-ref over the whole options object: the stable callbacks below read
  // fresh values without a hand-maintained field list that could drift.
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  const cancelMentionWake = React.useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    activePlanKeyRef.current = null;
  }, []);

  const currentPlan = React.useCallback((content: string) => {
    const context = optionsRef.current;
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

  // Not a mirror of the options object: this is the subset whose change should
  // re-arm the preflight, deliberately excluding getManagedAgentsByPubkey and
  // startManagedAgent (see the biome-ignore below).
  const {
    channelId,
    contentRef,
    enabled,
    expectedRelayUrl,
    expectedSignerPubkey,
    getDraftMentionRefs,
    isManagedAgentPubkey,
    memberPubkeys,
  } = options;

  const prepareMentionWake = React.useCallback(
    (content: string) => {
      // Any gate that stopped holding drops the plan, which cancels the window
      // outright rather than shortening it: the next arming starts a fresh
      // MENTION_WAKE_GATE_HOLD_MS.
      const plan = currentPlan(content);
      if (!plan) return cancelMentionWake();
      // The gates are still holding for the same plan, so leave the running
      // window alone. Re-arming here would turn the interval into a keystroke
      // debounce and never fire for an uninterrupted typist.
      if (activePlanKeyRef.current === plan.key) return;

      cancelMentionWake();
      activePlanKeyRef.current = plan.key;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void (async () => {
          // Re-confirm the gates at fire time and again after the lookup await,
          // so the interval is a hold on live draft state rather than a promise
          // made once at arming time.
          if (activePlanKeyRef.current !== plan.key) return;
          const beforeLookup = currentPlan(contentRef.current);
          if (beforeLookup?.key !== plan.key) return;
          const managedAgents =
            await optionsRef.current.getManagedAgentsByPubkey();
          if (activePlanKeyRef.current !== plan.key) return;
          const beforeWake = currentPlan(contentRef.current);
          if (beforeWake?.key !== plan.key) return;

          const context = optionsRef.current;
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
      }, MENTION_WAKE_GATE_HOLD_MS);
    },
    [cancelMentionWake, contentRef, currentPlan],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: optionsRef keeps callbacks fresh; these inputs are plan invalidation signals.
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
