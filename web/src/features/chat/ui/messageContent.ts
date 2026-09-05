const LEGACY_ESCAPED_STRUCTURE = /\\n(?:\\n|[-*+] |#{1,6} |> |\d+[.)] )/;

/**
 * Repair legacy agent responses that were stored with JSON newlines escaped a
 * second time. Mixed content and ordinary backslashes are deliberately left
 * untouched so code samples keep their original meaning.
 */
export function normalizeMessageContent(content: string): string {
  if (content.includes("\n") || !LEGACY_ESCAPED_STRUCTURE.test(content)) {
    return content;
  }
  return content.split("\\r\\n").join("\n").split("\\n").join("\n");
}

/** Convert Markdown message content into a compact, readable thread preview. */
export function messageContentPreview(
  content: string,
  normalizeLegacyEscapes = false,
): string {
  return (normalizeLegacyEscapes ? normalizeMessageContent(content) : content)
    .replace(/```[\s\S]*?```/g, " code sample ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
