import * as React from "react";

import { encodeVoiceNoteWav } from "./voiceNoteWav";

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/webm",
] as const;

function supportedMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

export type VoiceNoteRecording = {
  duration: number;
  file: File;
};

export function useVoiceNoteRecorder() {
  const startInFlightRef = React.useRef(false);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const contextRef = React.useRef<AudioContext | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const startedAtRef = React.useRef(0);
  const cancelRef = React.useRef(false);
  const resolveStopRef = React.useRef<
    ((recording: VoiceNoteRecording | null) => void) | null
  >(null);
  const [status, setStatus] = React.useState<
    "idle" | "recording" | "processing"
  >("idle");
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  const [levels, setLevels] = React.useState<number[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (status !== "idle") startInFlightRef.current = false;
  }, [status]);

  const releaseAudio = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });
    streamRef.current = null;
    const context = contextRef.current;
    contextRef.current = null;
    if (context) void context.close().catch(() => undefined);
  }, []);

  const start = React.useCallback(async () => {
    if (status !== "idle" || startInFlightRef.current) return;
    startInFlightRef.current = true;
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      startInFlightRef.current = false;
      setError("Voice recording is not available in this environment.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      const mimeType = supportedMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.72;
      context.createMediaStreamSource(stream).connect(analyser);

      chunksRef.current = [];
      cancelRef.current = false;
      recorderRef.current = recorder;
      streamRef.current = stream;
      contextRef.current = context;
      startedAtRef.current = performance.now();
      setElapsedSeconds(0);
      setLevels([]);

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        void (async () => {
          const actualMime = recorder.mimeType || mimeType || "audio/webm";
          const blob = new Blob(chunksRef.current, { type: actualMime });
          let recording: VoiceNoteRecording | null = null;
          if (!cancelRef.current && blob.size > 0) {
            try {
              const encoded = await blob.arrayBuffer();
              const decoded = await context.decodeAudioData(encoded.slice(0));
              const channels = Array.from(
                { length: decoded.numberOfChannels },
                (_, index) => decoded.getChannelData(index),
              );
              const wav = encodeVoiceNoteWav(channels, decoded.sampleRate);
              const wavBuffer = new ArrayBuffer(wav.byteLength);
              new Uint8Array(wavBuffer).set(wav);
              recording = {
                duration: decoded.duration,
                file: new File([wavBuffer], `voice-note-${Date.now()}.wav`, {
                  type: "audio/wav",
                }),
              };
            } catch {
              setError("Buzz could not prepare this voice note for upload.");
            }
          }
          chunksRef.current = [];
          recorderRef.current = null;
          releaseAudio();
          setStatus("idle");
          setElapsedSeconds(0);
          resolveStopRef.current?.(recording);
          resolveStopRef.current = null;
        })();
      });
      recorder.addEventListener("error", () => {
        setError("The voice recording was interrupted.");
      });
      recorder.start(250);
      setStatus("recording");

      const samples = new Uint8Array(analyser.fftSize);
      const levelTimer = window.setInterval(() => {
        if (recorder.state !== "recording") {
          window.clearInterval(levelTimer);
          return;
        }
        analyser.getByteTimeDomainData(samples);
        let sumSquares = 0;
        for (const sample of samples) {
          const centered = (sample - 128) / 128;
          sumSquares += centered * centered;
        }
        const rms = Math.sqrt(sumSquares / samples.length);
        const level = Math.min(1, rms * 5.5);
        setLevels((previous) => [...previous, level]);
        setElapsedSeconds((performance.now() - startedAtRef.current) / 1000);
      }, 90);
    } catch (cause) {
      startInFlightRef.current = false;
      releaseAudio();
      const denied =
        cause instanceof DOMException &&
        (cause.name === "NotAllowedError" || cause.name === "SecurityError");
      setError(
        denied
          ? "Allow Buzz to access your microphone to record a voice note."
          : "Buzz could not start the voice recorder.",
      );
    }
  }, [releaseAudio, status]);

  const stop = React.useCallback(
    (cancel = false): Promise<VoiceNoteRecording | null> => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        return Promise.resolve(null);
      }
      cancelRef.current = cancel;
      setStatus("processing");
      return new Promise((resolve) => {
        resolveStopRef.current = resolve;
        recorder.stop();
      });
    },
    [],
  );

  React.useEffect(
    () => () => {
      cancelRef.current = true;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      releaseAudio();
    },
    [releaseAudio],
  );

  return {
    elapsedSeconds,
    error,
    levels,
    start,
    status,
    stop,
  };
}
