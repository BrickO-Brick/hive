import * as React from "react";

import type { DraftEntryKind } from "@/features/messages/lib/useDrafts";

type RestoreAddressedAgentMentions = (
  pubkeys?: readonly string[],
  allowedUnpinnedPubkeys?: readonly string[],
) => string;

export function useAgentPrefillDraftBridge({
  channelId,
  contentRef,
  getEntryKind,
  keepMentionedAgentsPinned,
  pendingImetaRef,
  persistAgentPrefill,
  queuedAttachmentsRef,
  resetToAgentPrefill,
  setComposerContent,
}: {
  channelId: string | null;
  contentRef: React.MutableRefObject<string>;
  getEntryKind: () => DraftEntryKind;
  keepMentionedAgentsPinned: boolean;
  pendingImetaRef: React.MutableRefObject<readonly unknown[]>;
  persistAgentPrefill: (content: string) => void;
  queuedAttachmentsRef: React.MutableRefObject<readonly unknown[]>;
  resetToAgentPrefill: () => void;
  setComposerContent: (content: string) => void;
}) {
  const restoreAddressedAgentMentionsRef =
    React.useRef<RestoreAddressedAgentMentions>(() => "");
  const restoreFrameRef = React.useRef<number | null>(null);
  const channelIdRef = React.useRef(channelId);
  channelIdRef.current = channelId;

  React.useEffect(
    () => () => {
      if (restoreFrameRef.current !== null) {
        cancelAnimationFrame(restoreFrameRef.current);
      }
    },
    [],
  );

  const onAddressedAgentsComposerCleared = React.useCallback(
    (pubkeys: readonly string[]) => {
      const content = restoreAddressedAgentMentionsRef.current(pubkeys);
      setComposerContent(content);
      resetToAgentPrefill();
      return content;
    },
    [resetToAgentPrefill, setComposerContent],
  );

  const onAddressedAgentsSendSucceeded = React.useCallback(
    (pubkeys: readonly string[], newlyPinnedPubkeys: readonly string[]) => {
      if (
        getEntryKind() === "agent-prefill" &&
        contentRef.current.trim().length > 0
      ) {
        persistAgentPrefill(contentRef.current);
      }
      if (!keepMentionedAgentsPinned || newlyPinnedPubkeys.length === 0) return;

      const sentChannelId = channelId;
      if (restoreFrameRef.current !== null) {
        cancelAnimationFrame(restoreFrameRef.current);
      }
      restoreFrameRef.current = requestAnimationFrame(() => {
        restoreFrameRef.current = null;
        if (channelIdRef.current !== sentChannelId) return;
        const shouldPersistPrefill = getEntryKind() === "agent-prefill";
        const content = restoreAddressedAgentMentionsRef.current(
          pubkeys,
          newlyPinnedPubkeys,
        );
        contentRef.current = content;
        setComposerContent(content);
        if (shouldPersistPrefill) persistAgentPrefill(content);
      });
    },
    [
      channelId,
      contentRef,
      getEntryKind,
      keepMentionedAgentsPinned,
      persistAgentPrefill,
      setComposerContent,
    ],
  );

  const onAgentPrefillChanged = React.useCallback(
    (content: string) => {
      contentRef.current = content;
      setComposerContent(content);
      persistAgentPrefill(content);
    },
    [contentRef, persistAgentPrefill, setComposerContent],
  );

  const shouldKeepAgentPrefill = React.useCallback(
    (currentContent: string) =>
      getEntryKind() === "agent-prefill" ||
      (currentContent.trim().length === 0 &&
        pendingImetaRef.current.length === 0 &&
        queuedAttachmentsRef.current.length === 0),
    [getEntryKind, pendingImetaRef, queuedAttachmentsRef],
  );

  return {
    onAddressedAgentsComposerCleared,
    onAddressedAgentsSendSucceeded,
    onAgentPrefillChanged,
    restoreAddressedAgentMentionsRef,
    shouldKeepAgentPrefill,
  };
}
