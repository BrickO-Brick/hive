import { buildOutgoingMessage, type ImetaMedia } from "./imetaMediaMarkdown";
import { splitOutgoingLinkContent } from "@/shared/lib/linkPreview";

export type OutgoingMessagePart = {
  content: string;
  createdAt?: number;
  kind: "link" | "media" | "text";
  outgoingTags: string[][] | undefined;
};

/**
 * Build the ordered events for one composer submission. Attachments remain
 * together in a media-only event, authored links move to a link-only event,
 * and both precede any remaining authored text event.
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
  const { linkContent, textContent } = splitOutgoingLinkContent(body);
  const linkTags = textTags.filter((tag) => tag[0] === "link-preview");
  const remainingTextTags = textTags.filter((tag) => tag[0] !== "link-preview");

  if (media.length > 0) {
    const mediaMessage = buildOutgoingMessage("", media, spoileredMediaUrls);
    parts.push({
      content: mediaMessage.content,
      kind: "media",
      outgoingTags: mediaMessage.mediaTags,
    });
  }

  if (linkContent) {
    parts.push({
      content: linkContent,
      kind: "link",
      outgoingTags: linkTags.length > 0 ? linkTags : undefined,
    });
  }

  if (textContent) {
    parts.push({
      content: textContent,
      kind: "text",
      outgoingTags:
        remainingTextTags.length > 0 ? remainingTextTags : undefined,
    });
  }

  // Relay events sort by whole-second timestamps and then event id. Backdate
  // every part except the final one by one additional second so attachment →
  // link → prose order is stable without delaying any network send.
  return parts.map((part, index) =>
    index < parts.length - 1
      ? {
          ...part,
          createdAt: Math.max(0, nowSeconds - (parts.length - 1 - index)),
        }
      : part,
  );
}
