import * as React from "react";
import { useEditorState } from "@tiptap/react";

import type { UseMentionsResult } from "@/features/messages/lib/useMentions";
import type { UseRichTextEditorResult } from "@/features/messages/lib/useRichTextEditor";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";
import type { ComposerAddressAgent } from "./ComposerAddressControls";
import { mergeMentionRecipients } from "./useMentionSendFlow.helpers";

/** Preview the same resolved identities used at the send boundary. */
export function useComposerAgentRecipients({
  audiencePubkeys,
  mentions,
  profiles,
  richText,
}: {
  audiencePubkeys: readonly string[];
  mentions: UseMentionsResult;
  profiles?: UserProfileLookup;
  richText: UseRichTextEditorResult;
}): ComposerAddressAgent[] {
  const serializedRef = React.useRef<{
    document: unknown;
    text: string;
  }>({ document: null, text: "" });
  return (
    useEditorState({
      editor: richText.editor,
      selector: ({ editor }) => {
        const document = editor?.state.doc;
        // Do not serialize on selection transactions or rerender the composer
        // for ordinary typing. useEditorState compares the recipient rows.
        if (serializedRef.current.document !== document) {
          serializedRef.current = {
            document,
            text: document?.textContent.includes("@")
              ? richText.getMarkdown()
              : "",
          };
        }
        const text = serializedRef.current.text;
        const refs = mentions.getDraftMentionRefs(text);
        const automatic = new Set(audiencePubkeys.map(normalizePubkey));
        const selectedAgents = new Set(
          refs
            .filter((ref) => ref.isAgent)
            .map((ref) => normalizePubkey(ref.pubkey)),
        );
        return mergeMentionRecipients(
          mentions.extractMentionPubkeys(text),
          audiencePubkeys,
        )
          .filter(
            (pubkey) =>
              automatic.has(pubkey) ||
              selectedAgents.has(pubkey) ||
              mentions.isAgentPubkey(pubkey),
          )
          .map((pubkey) => {
            const profile = profiles?.[pubkey];
            return {
              pubkey,
              displayName:
                refs.find((ref) => normalizePubkey(ref.pubkey) === pubkey)
                  ?.displayName ||
                mentions.getMentionDisplayName(pubkey) ||
                profile?.displayName ||
                profile?.name ||
                truncatePubkey(pubkey),
              avatarUrl: profile?.avatarUrl ?? null,
              isAutomatic: automatic.has(pubkey),
            };
          });
      },
    }) ?? []
  );
}
