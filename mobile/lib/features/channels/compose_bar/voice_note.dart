part of '../compose_bar.dart';

class _ComposerVoiceNote {
  const _ComposerVoiceNote({
    required this.start,
    required this.onKeyboardHidden,
    required this.isPreparing,
    required this.recorder,
  });

  final VoidCallback start;
  final VoidCallback onKeyboardHidden;
  final bool isPreparing;
  final Widget? recorder;
}

bool _voiceNoteFullWidth(
  _ComposerVoiceNote voiceNote,
  List<_PendingAttachment> attachments,
) =>
    voiceNote.isPreparing ||
    voiceNote.recorder != null ||
    attachments.any((item) => item.kind == _PendingAttachmentKind.voiceNote);

_ComposerVoiceNote _useComposerVoiceNote({
  required BuildContext context,
  required WidgetRef ref,
  required FocusNode focusNode,
  required ValueNotifier<bool> isComposerExpanded,
  required ValueNotifier<bool> showFormatting,
  required ValueNotifier<_AttachmentSurface> attachmentSurface,
  required ValueNotifier<String?> uploadError,
  required ObjectRef<int> draftRevision,
  required ValueNotifier<List<_PendingAttachment>> attachments,
}) {
  final isPreparing = useState(false);
  final isRecording = useState(false);

  void beginRecording() {
    if (!isPreparing.value) return;
    isPreparing.value = false;
    isRecording.value = true;
  }

  void start() {
    attachmentSurface.value = _AttachmentSurface.closed;
    showFormatting.value = false;
    isComposerExpanded.value = false;
    _dismissComposerKeyboard(focusNode);
    if (ref.read(huddleSessionProvider).isInSession) {
      uploadError.value = 'Leave the Huddle before recording a voice note.';
      return;
    }
    uploadError.value = null;
    isPreparing.value = true;
    if (View.of(context).viewInsets.bottom == 0) beginRecording();
  }

  void complete(VoiceNoteRecording recording) {
    draftRevision.value += 1;
    uploadError.value = null;
    attachments.value = [
      ...attachments.value,
      _PendingAttachment(
        file: recording.file,
        kind: _PendingAttachmentKind.voiceNote,
        deleteAfterUse: true,
        duration: recording.duration,
        waveform: recording.waveform,
      ),
    ];
    isRecording.value = false;
  }

  return _ComposerVoiceNote(
    start: start,
    onKeyboardHidden: beginRecording,
    isPreparing: isPreparing.value,
    recorder: isRecording.value
        ? VoiceNoteComposerRecorder(
            onCancel: () => isRecording.value = false,
            onRecorded: complete,
          )
        : null,
  );
}
