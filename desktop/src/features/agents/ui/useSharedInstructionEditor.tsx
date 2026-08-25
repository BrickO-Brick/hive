import * as React from "react";

import type {
  SharedInstructionCover,
  ResolvedSharedInstruction,
} from "@/shared/api/tauriPersonas";
import { Dialog } from "@/shared/ui/dialog";
import { SharedInstructionEditor } from "./SharedInstructionEditor";

type UseSharedInstructionEditorOptions = {
  embedded: boolean;
  open: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  assignedSharedInstructions: string[];
  setAssignedSharedInstructions: React.Dispatch<React.SetStateAction<string[]>>;
  setHasUserChanges: React.Dispatch<React.SetStateAction<boolean>>;
};

export function useSharedInstructionEditor({
  embedded,
  open,
  onDirtyChange,
  assignedSharedInstructions,
  setAssignedSharedInstructions,
  setHasUserChanges,
}: UseSharedInstructionEditorOptions) {
  const [publishedSharedInstructions, setPublishedSharedInstructions] =
    React.useState<SharedInstructionCover[]>([]);
  const [editorState, setEditorState] = React.useState<{
    key: number;
    detail: ResolvedSharedInstruction | null;
  } | null>(null);
  const closeRequestRef = React.useRef<(() => void) | null>(null);

  const resetSharedInstructionEditor = React.useCallback(() => {
    setPublishedSharedInstructions([]);
    setEditorState(null);
    closeRequestRef.current = null;
  }, []);
  const openSharedInstructionEditor = React.useCallback(
    (detail: ResolvedSharedInstruction | null) =>
      setEditorState({ key: Date.now(), detail }),
    [],
  );

  function handlePublished(skill: SharedInstructionCover) {
    setPublishedSharedInstructions((current) => [
      skill,
      ...current.filter((item) => item.coordinate !== skill.coordinate),
    ]);
    if (!editorState?.detail) {
      setAssignedSharedInstructions((current) =>
        current.includes(skill.coordinate)
          ? current
          : [...current, skill.coordinate],
      );
      setHasUserChanges(true);
    }
    setEditorState(null);
  }

  const fieldProps = {
    assignedSharedInstructions,
    onAssignedSharedInstructionsChange: (coordinates: string[]) => {
      setAssignedSharedInstructions(coordinates);
      setHasUserChanges(true);
    },
    onEditSharedInstruction: openSharedInstructionEditor,
    publishedSharedInstructions,
  };

  if (!editorState) {
    return {
      editor: null,
      fieldProps,
      resetSharedInstructionEditor,
    };
  }

  const editorContent = (
    <SharedInstructionEditor
      detail={editorState.detail}
      embedded={embedded}
      key={editorState.key}
      onClose={() => setEditorState(null)}
      onDirtyChange={onDirtyChange}
      onPublished={handlePublished}
      registerCloseRequest={(request) => {
        closeRequestRef.current = request;
      }}
    />
  );
  const editor = embedded ? (
    editorContent
  ) : (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeRequestRef.current?.();
      }}
      open={open}
    >
      {editorContent}
    </Dialog>
  );

  return {
    editor,
    fieldProps,
    resetSharedInstructionEditor,
  };
}
