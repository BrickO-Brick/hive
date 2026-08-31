import * as React from "react";

import {
  getPersistentAgentAudienceRevision,
  getPersistentAgentAudienceSnapshot,
} from "@/features/messages/lib/persistentAgentAudience";

type RestoreAddressedAgentMentions = (
  pubkeys?: readonly string[],
  allowedUnpinnedPubkeys?: readonly string[],
) => string;

export function useAddressedAgentMentionRestore({
  audienceScope,
  channelId,
  enabled,
}: {
  audienceScope: string | null;
  channelId: string | null;
  enabled: boolean;
}) {
  const restoreAddressedAgentMentionsRef =
    React.useRef<RestoreAddressedAgentMentions>(() => "");
  const restoreFrameRef = React.useRef<number | null>(null);
  const audienceScopeRef = React.useRef(audienceScope);
  const audienceScopeGenerationRef = React.useRef(0);
  if (audienceScopeRef.current !== audienceScope) {
    audienceScopeRef.current = audienceScope;
    audienceScopeGenerationRef.current += 1;
  }
  const renderAudienceScopeGeneration = audienceScopeGenerationRef.current;
  const channelIdRef = React.useRef(channelId);
  channelIdRef.current = channelId;
  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;
  const isMountedRef = React.useRef(false);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (restoreFrameRef.current !== null) {
        cancelAnimationFrame(restoreFrameRef.current);
      }
    };
  }, []);

  const onAddressedAgentsComposerCleared = React.useCallback(
    (pubkeys: readonly string[]) => {
      const clearedAudienceScope = audienceScope;
      const clearedAudienceScopeGeneration = renderAudienceScopeGeneration;
      if (
        !isMountedRef.current ||
        !clearedAudienceScope ||
        audienceScopeRef.current !== clearedAudienceScope ||
        audienceScopeGenerationRef.current !== clearedAudienceScopeGeneration
      ) {
        return "";
      }
      const currentAudience = new Set(
        getPersistentAgentAudienceSnapshot().audiences[clearedAudienceScope] ??
          [],
      );
      return restoreAddressedAgentMentionsRef.current(
        pubkeys.filter((pubkey) => currentAudience.has(pubkey)),
      );
    },
    [audienceScope, renderAudienceScopeGeneration],
  );
  const onAddressedAgentsSendSucceeded = React.useCallback(
    (pubkeys: readonly string[], newlyPinnedPubkeys: readonly string[]) => {
      const sentAudienceScope = audienceScope;
      if (
        !isMountedRef.current ||
        !enabled ||
        !sentAudienceScope ||
        newlyPinnedPubkeys.length === 0
      )
        return;

      const sentChannelId = channelId;
      const sentAudienceScopeGeneration = renderAudienceScopeGeneration;
      const sentAudienceRevision =
        getPersistentAgentAudienceRevision(sentAudienceScope);
      if (restoreFrameRef.current !== null) {
        cancelAnimationFrame(restoreFrameRef.current);
      }
      restoreFrameRef.current = requestAnimationFrame(() => {
        restoreFrameRef.current = null;
        if (
          !enabledRef.current ||
          audienceScopeRef.current !== sentAudienceScope ||
          audienceScopeGenerationRef.current !== sentAudienceScopeGeneration ||
          channelIdRef.current !== sentChannelId ||
          getPersistentAgentAudienceRevision(sentAudienceScope) !==
            sentAudienceRevision
        ) {
          return;
        }

        const currentAudience = new Set(
          getPersistentAgentAudienceSnapshot().audiences[sentAudienceScope] ??
            [],
        );
        if (!newlyPinnedPubkeys.some((pubkey) => currentAudience.has(pubkey)))
          return;
        restoreAddressedAgentMentionsRef.current(
          pubkeys.filter((pubkey) => currentAudience.has(pubkey)),
        );
      });
    },
    [audienceScope, channelId, enabled, renderAudienceScopeGeneration],
  );

  return {
    onAddressedAgentsComposerCleared,
    onAddressedAgentsSendSucceeded,
    restoreAddressedAgentMentionsRef,
  };
}
