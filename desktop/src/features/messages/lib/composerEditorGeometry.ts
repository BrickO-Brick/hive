import type { Editor } from "@tiptap/react";

export type EditorRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
};

export function getEditorSelectionRect(
  editor: Editor,
  from: number,
  to: number,
): EditorRect | null {
  try {
    try {
      const range = document.createRange();
      const start = editor.view.domAtPos(from);
      const end = editor.view.domAtPos(to);
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);

      const clientRects = Array.from(range.getClientRects()).filter(
        (rect) => rect.width > 0 || rect.height > 0,
      );
      const rect = clientRects[0] ?? range.getBoundingClientRect();
      range.detach();
      if (rect.width > 0 || rect.height > 0) return rect;
    } catch {
      // A mounted view can still have stale Range offsets; use caret geometry.
    }

    const startCoords = editor.view.coordsAtPos(from);
    const endCoords = editor.view.coordsAtPos(to);
    const left = Math.min(startCoords.left, endCoords.left);
    const right = Math.max(startCoords.right, endCoords.right);
    const top = Math.min(startCoords.top, endCoords.top);
    const bottom = Math.max(startCoords.bottom, endCoords.bottom);

    if (right <= left && bottom <= top) return null;
    return {
      left,
      top,
      width: Math.max(1, right - left),
      height: bottom - top,
      right,
      bottom,
    };
  } catch {
    return null;
  }
}

export function getEditorLinkRect(
  editor: Editor,
  from: number,
  to: number,
): EditorRect | null {
  try {
    try {
      const range = document.createRange();
      const start = editor.view.domAtPos(from);
      const end = editor.view.domAtPos(to);
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);

      const rect = range.getBoundingClientRect();
      range.detach();
      if (rect.width > 0 || rect.height > 0) {
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          right: rect.right,
          bottom: rect.bottom,
        };
      }
    } catch {
      // A mounted view can still have stale Range offsets; use caret geometry.
    }

    const coords = editor.view.coordsAtPos(from);
    return {
      left: coords.left,
      top: coords.top,
      width: Math.max(1, coords.right - coords.left),
      height: Math.max(1, coords.bottom - coords.top),
      right: coords.right,
      bottom: coords.bottom,
    };
  } catch {
    return null;
  }
}
