const COLLECTION_MESSAGE_LABEL_LIMIT = 120;

/** Build a compact, store-safe label from user-authored message text. */
export function collectionMessageLabel(body: string, author: string): string {
  const compact = body.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
  const fallback = author.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
  return Array.from(compact || fallback)
    .slice(0, COLLECTION_MESSAGE_LABEL_LIMIT)
    .join("");
}
