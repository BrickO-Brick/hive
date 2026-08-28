import assert from "node:assert/strict";
import test from "node:test";

import {
  formatVoiceNoteDuration,
  isVoiceNoteAttachment,
  isVoiceNoteFile,
  nextVoiceNotePlaybackRate,
  resolveAudioAttachment,
  VOICE_NOTE_MAX_DURATION_SECONDS,
  voiceNoteBarHeight,
  waveformPeaks,
} from "./audioAttachment.ts";

test("isVoiceNoteFile scopes deferred audio uploads to recorder output", () => {
  assert.equal(
    isVoiceNoteFile(
      new File([new Uint8Array([1])], "voice-note-123.wav", {
        type: "audio/wav",
      }),
    ),
    true,
  );
  assert.equal(
    isVoiceNoteFile(
      new File([new Uint8Array([1])], "meeting.wav", { type: "audio/wav" }),
    ),
    false,
  );
});

test("resolveAudioAttachment accepts audio imeta and preserves metadata", () => {
  assert.deepEqual(
    resolveAudioAttachment(
      {
        duration: 12.5,
        filename: "voice-note.webm",
        m: "audio/webm;codecs=opus",
        size: 2048,
      },
      "https://relay.example/media/voice-note.webm",
      "Voice note",
    ),
    {
      duration: 12.5,
      filename: "voice-note.webm",
      href: "https://relay.example/media/voice-note.webm",
      size: 2048,
    },
  );
});

test("resolveAudioAttachment leaves non-audio files on the generic path", () => {
  assert.equal(
    resolveAudioAttachment(
      { filename: "notes.pdf", m: "application/pdf" },
      "https://relay.example/media/notes.pdf",
      "notes.pdf",
    ),
    null,
  );
});

test("packaged MP4 voice notes still resolve to the audio player", () => {
  const entry = {
    duration: 7.2,
    filename: "voice-note-123.mp4",
    m: "video/mp4",
  };
  assert.equal(isVoiceNoteAttachment(entry), true);
  assert.deepEqual(
    resolveAudioAttachment(
      entry,
      "https://relay.example/media/hash.mp4",
      "voice-note-123.mp4",
    ),
    {
      duration: 7.2,
      filename: "voice-note-123.mp4",
      href: "https://relay.example/media/hash.mp4",
      size: undefined,
    },
  );
  assert.equal(
    isVoiceNoteAttachment({ filename: "meeting.mp4", m: "video/mp4" }),
    false,
  );
});

test("formatVoiceNoteDuration formats minutes and seconds", () => {
  assert.equal(formatVoiceNoteDuration(0), "0:00");
  assert.equal(formatVoiceNoteDuration(65.9), "1:05");
});

test("voice notes have a five-minute recording limit", () => {
  assert.equal(VOICE_NOTE_MAX_DURATION_SECONDS, 300);
  assert.equal(
    formatVoiceNoteDuration(VOICE_NOTE_MAX_DURATION_SECONDS),
    "5:00",
  );
});

test("nextVoiceNotePlaybackRate follows the voice-note speed cycle", () => {
  assert.equal(nextVoiceNotePlaybackRate(1), 1.5);
  assert.equal(nextVoiceNotePlaybackRate(1.5), 2);
  assert.equal(nextVoiceNotePlaybackRate(2), 0.5);
  assert.equal(nextVoiceNotePlaybackRate(0.5), 1);
  assert.equal(nextVoiceNotePlaybackRate(99), 1);
});

test("waveformPeaks produces normalized accessible-height bars", () => {
  const peaks = waveformPeaks(new Float32Array([0, 0.25, -0.5, 1]), 2);
  assert.deepEqual(peaks, [0.25, 1]);
  assert.deepEqual(waveformPeaks(new Float32Array(), 2), [0.12, 0.12]);
});

test("voiceNoteBarHeight keeps quiet samples circular", () => {
  assert.equal(voiceNoteBarHeight(0), 3);
  assert.equal(voiceNoteBarHeight(0.12), 3);
  assert.equal(voiceNoteBarHeight(0.16), 3);
  assert.equal(voiceNoteBarHeight(1), 20);
});
