import type { Editor } from "@tiptap/react";

/** Returns the editor DOM only after TipTap has mounted its view. */
export function getMountedEditorDom(editor: Editor): HTMLElement | null {
  try {
    return editor.view.dom;
  } catch {
    return null;
  }
}

/** Focuses the mounted view synchronously and ignores TipTap teardown races. */
export function focusMountedEditorView(editor: Editor): void {
  try {
    editor.view.focus();
  } catch {
    // TipTap exposes a throwing view proxy between mount cycles.
  }
}
