import * as React from "react";

import type {
  RelaySkillCover,
  ResolvedRelaySkill,
} from "@/shared/api/tauriPersonas";
import { Dialog } from "@/shared/ui/dialog";
import { RelaySkillEditor } from "./RelaySkillEditor";

type UseRelaySkillEditorOptions = {
  embedded: boolean;
  open: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  assignedRelaySkills: string[];
  setAssignedRelaySkills: React.Dispatch<React.SetStateAction<string[]>>;
  setHasUserChanges: React.Dispatch<React.SetStateAction<boolean>>;
};

export function useRelaySkillEditor({
  embedded,
  open,
  onDirtyChange,
  assignedRelaySkills,
  setAssignedRelaySkills,
  setHasUserChanges,
}: UseRelaySkillEditorOptions) {
  const [publishedRelaySkills, setPublishedRelaySkills] = React.useState<
    RelaySkillCover[]
  >([]);
  const [editorState, setEditorState] = React.useState<{
    key: number;
    detail: ResolvedRelaySkill | null;
  } | null>(null);
  const closeRequestRef = React.useRef<(() => void) | null>(null);

  const resetRelaySkillEditor = React.useCallback(() => {
    setPublishedRelaySkills([]);
    setEditorState(null);
    closeRequestRef.current = null;
  }, []);
  const openRelaySkillEditor = React.useCallback(
    (detail: ResolvedRelaySkill | null) =>
      setEditorState({ key: Date.now(), detail }),
    [],
  );

  function handlePublished(skill: RelaySkillCover) {
    setPublishedRelaySkills((current) => [
      skill,
      ...current.filter((item) => item.coordinate !== skill.coordinate),
    ]);
    if (!editorState?.detail) {
      setAssignedRelaySkills((current) =>
        current.includes(skill.coordinate)
          ? current
          : [...current, skill.coordinate],
      );
      setHasUserChanges(true);
    }
    setEditorState(null);
  }

  const fieldProps = {
    assignedRelaySkills,
    onAssignedRelaySkillsChange: (coordinates: string[]) => {
      setAssignedRelaySkills(coordinates);
      setHasUserChanges(true);
    },
    onEditRelaySkill: openRelaySkillEditor,
    publishedRelaySkills,
  };

  if (!editorState) {
    return {
      editor: null,
      fieldProps,
      resetRelaySkillEditor,
    };
  }

  const editorContent = (
    <RelaySkillEditor
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
    resetRelaySkillEditor,
  };
}
