import * as React from "react";
import { toast } from "sonner";

import { VOICE_NOTE_MAX_DURATION_SECONDS } from "@/features/messages/lib/audioAttachment";
import { useVoiceNoteRecorder } from "@/features/messages/lib/useVoiceNoteRecorder";
import { VoiceNoteRecorder } from "./VoiceNoteRecorder";

export function useComposerVoiceNote({
  hasAttachments,
  onBeforeStart,
  uploadFile,
}: {
  hasAttachments: () => boolean;
  onBeforeStart: () => void;
  uploadFile: (file: File) => Promise<unknown>;
}) {
  const recorder = useVoiceNoteRecorder();
  const limitReachedRef = React.useRef(false);
  const statusRef = React.useRef(recorder.status);
  statusRef.current = recorder.status;
  const hasAttachmentsRef = React.useRef(hasAttachments);
  hasAttachmentsRef.current = hasAttachments;
  const onBeforeStartRef = React.useRef(onBeforeStart);
  onBeforeStartRef.current = onBeforeStart;

  React.useEffect(() => {
    if (recorder.error) toast.error(recorder.error);
  }, [recorder.error]);

  const finish = React.useCallback(async () => {
    const recording = await recorder.stop();
    if (recording) await uploadFile(recording.file);
    return recording;
  }, [recorder.stop, uploadFile]);

  React.useEffect(() => {
    if (recorder.status === "idle") limitReachedRef.current = false;
    if (
      recorder.status === "recording" &&
      recorder.elapsedSeconds >= VOICE_NOTE_MAX_DURATION_SECONDS &&
      !limitReachedRef.current
    ) {
      limitReachedRef.current = true;
      void finish();
    }
  }, [finish, recorder.elapsedSeconds, recorder.status]);

  const toggle = React.useCallback(() => {
    if (statusRef.current === "recording") {
      void finish();
      return;
    }
    if (hasAttachmentsRef.current()) {
      toast.error("A voice note must be the only attachment.");
      return;
    }
    onBeforeStartRef.current();
    void recorder.start();
  }, [finish, recorder.start]);

  const cancel = React.useCallback(() => {
    void recorder.stop(true);
  }, [recorder.stop]);

  const uploadFileWhenIdle = React.useCallback(
    async (file: File) => {
      if (statusRef.current !== "idle") {
        toast.error(
          "Finish or discard the voice note before attaching a file.",
        );
        return;
      }
      await uploadFile(file);
    },
    [uploadFile],
  );

  return {
    ...recorder,
    isIdle: recorder.status === "idle",
    recorderElement:
      recorder.status === "idle" ? null : (
        <VoiceNoteRecorder
          elapsedSeconds={recorder.elapsedSeconds}
          levels={recorder.levels}
          maxDurationSeconds={VOICE_NOTE_MAX_DURATION_SECONDS}
          onCancel={cancel}
          processing={recorder.status === "processing"}
        />
      ),
    statusRef,
    finish,
    toggle,
    uploadFileWhenIdle,
  };
}
