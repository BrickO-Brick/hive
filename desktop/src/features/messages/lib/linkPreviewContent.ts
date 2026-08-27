import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import type { MentionTextChange } from "./mentionIdentityRefs";

import { buildPlainTextProjection } from "./plainTextProjection";

function projectTransactionTextChange(
  tr: Transaction,
): MentionTextChange | null {
  // StepMap coordinates after the first map belong to intermediate documents,
  // not `tr.before`/`tr.doc`. Only project the single-step/single-range shape;
  // callers fail closed for anything more complex.
  if (tr.mapping.maps.length !== 1) return null;

  const ranges: Array<[number, number, number, number]> = [];
  tr.mapping.maps[0].forEach((oldFrom, oldTo, newFrom, newTo) => {
    ranges.push([oldFrom, oldTo, newFrom, newTo]);
  });
  if (ranges.length !== 1) return null;

  const [oldFrom, oldTo, newFrom, newTo] = ranges[0];
  const previous = buildPlainTextProjection(tr.before);
  const next = buildPlainTextProjection(tr.doc);
  return {
    oldFrom: previous.mapPMToTextOffset(oldFrom),
    oldTo: previous.mapPMToTextOffset(oldTo),
    newFrom: next.mapPMToTextOffset(newFrom),
    newTo: next.mapPMToTextOffset(newTo),
  };
}

export function buildPreviewUpdate(
  doc: ProseMirrorNode,
  selectionAnchor: number,
  transaction?: Transaction,
) {
  const projection = buildPlainTextProjection(doc);
  const plainText = projection.text;
  const hrefs = new Set<string>();
  doc.descendants((node) => {
    if (!node.isText || node.marks.some((mark) => mark.type.name === "spoiler"))
      return;
    const href = node.marks.find((mark) => mark.type.name === "link")?.attrs
      .href;
    if (typeof href === "string") hrefs.add(href);
  });
  return {
    cursor: projection.mapPMToTextOffset(selectionAnchor),
    linkPreviewContent: [plainText, ...hrefs].join("\n"),
    text: plainText,
    textChange: transaction ? projectTransactionTextChange(transaction) : null,
  };
}
