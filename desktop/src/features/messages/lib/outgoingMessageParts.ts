import { buildOutgoingMessage, type ImetaMedia } from "./imetaMediaMarkdown";

export type OutgoingMessagePart = {
  content: string;
  createdAt?: number;
  kind: "media" | "text";
  outgoingTags: string[][] | undefined;
};

/**
 * Build the ordered events for one composer submission. Attachments remain
 * together in a media-only event and precede any authored text event.
 */
export function buildOutgoingMessageParts({
  body,
  media,
  nowSeconds = Math.floor(Date.now() / 1_000),
  spoileredMediaUrls = new Set(),
  textTags = [],
}: {
  body: string;
  media: ReadonlyArray<ImetaMedia>;
  nowSeconds?: number;
  spoileredMediaUrls?: ReadonlySet<string>;
  textTags?: string[][];
}): OutgoingMessagePart[] {
  const parts: OutgoingMessagePart[] = [];
  const hasText = body.trim().length > 0;

  if (media.length > 0) {
    const mediaMessage = buildOutgoingMessage("", media, spoileredMediaUrls);
    parts.push({
      content: mediaMessage.content,
      // Relay events sort by whole-second timestamps and then event id. Give
      // the media half of a mixed submission the immediately preceding second
      // so every client renders it first without delaying either network send.
      createdAt: hasText ? Math.max(0, nowSeconds - 1) : undefined,
      kind: "media",
      outgoingTags: mediaMessage.mediaTags,
    });
  }

  if (hasText) {
    parts.push({
      content: body,
      kind: "text",
      outgoingTags: textTags.length > 0 ? textTags : undefined,
    });
  }

  return parts;
}
