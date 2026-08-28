import * as React from "react";
import { X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

import {
  formatVoiceNoteDuration,
  nextVoiceNotePlaybackRate,
  resolveAudioAttachment,
  voiceNoteBarHeight,
  waveformPeaks,
  type AudioAttachmentImetaEntry,
} from "@/features/messages/lib/audioAttachment";
import { fetchMediaBytes } from "@/shared/api/tauriMedia";
import { cn } from "@/shared/lib/cn";
import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentMedia,
  AttachmentTitle,
} from "@/shared/ui/attachment";
import { useSmoothCorners } from "@/shared/ui/smoothCorners";
import { MorphingPlayPauseIcon } from "./MorphingPlayPauseIcon";

const PLAY_EVENT = "buzz-voice-note-play";
const INITIAL_BAR_COUNT = 38;
const BAR_KEYS = Array.from(
  { length: 256 },
  (_, index) => `voice-note-bar-${index}`,
);

function dotPeaks(count: number): number[] {
  return Array.from({ length: count }, () => 0);
}

function playbackRateLabel(rate: number): string {
  return `${rate === 0.5 ? ".5" : rate}×`;
}

export function renderAudioMessageAttachment(
  entry: AudioAttachmentImetaEntry | undefined,
  href: string | undefined,
  label: string,
) {
  const attachment = resolveAudioAttachment(entry, href, label);
  return attachment ? <AudioMessageAttachment {...attachment} /> : null;
}

function audioMimeForUrl(url: string): string {
  const pathname = url.split("?", 1)[0]?.toLowerCase() ?? "";
  if (pathname.endsWith(".mp4")) return "audio/mp4";
  if (pathname.endsWith(".mp3")) return "audio/mpeg";
  if (pathname.endsWith(".ogg")) return "audio/ogg";
  return "audio/wav";
}

async function decodePeaks(url: string, count: number): Promise<number[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Audio fetch failed (${response.status})`);
  const bytes = await response.arrayBuffer();
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(bytes.slice(0));
    return waveformPeaks(buffer.getChannelData(0), count);
  } finally {
    await context.close();
  }
}

export function AudioMessageAttachment({
  composer = false,
  duration: taggedDuration,
  filename,
  href,
  onRemove,
}: {
  composer?: boolean;
  duration?: number;
  filename: string;
  href: string;
  onRemove?: () => void;
}) {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const playbackId = React.useId();
  const mediaRef = React.useRef<HTMLDivElement | null>(null);
  const playbackRateRef = React.useRef<HTMLButtonElement | null>(null);
  const waveformRef = React.useRef<HTMLDivElement | null>(null);
  const progressWaveformRef = React.useRef<HTMLDivElement | null>(null);
  const progressFrameRef = React.useRef<number | null>(null);
  const shouldReduceMotion = useReducedMotion();
  const [playbackHref, setPlaybackHref] = React.useState<string | undefined>(
    composer || href.startsWith("blob:") || href.startsWith("data:")
      ? href
      : undefined,
  );
  const [barCount, setBarCount] = React.useState(INITIAL_BAR_COUNT);
  const [duration, setDuration] = React.useState(taggedDuration ?? 0);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [playbackRate, setPlaybackRate] = React.useState(1);
  const [peaks, setPeaks] = React.useState(() => dotPeaks(INITIAL_BAR_COUNT));
  const [waveformReady, setWaveformReady] = React.useState(false);
  useSmoothCorners(mediaRef);
  useSmoothCorners(playbackRateRef);

  React.useEffect(() => {
    if (composer || href.startsWith("blob:") || href.startsWith("data:")) {
      setPlaybackHref(href);
      return;
    }

    let active = true;
    let objectUrl: string | undefined;
    setPlaybackHref(undefined);
    void fetchMediaBytes(href)
      .then((bytes) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(
          new Blob([bytes], { type: audioMimeForUrl(href) }),
        );
        setPlaybackHref(objectUrl);
      })
      .catch(() => {
        if (active) setPlaybackHref(rewriteRelayUrl(href));
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [composer, href]);

  React.useEffect(() => {
    const waveform = waveformRef.current;
    if (!waveform) return;
    const updateCount = () => {
      setBarCount(
        Math.min(256, Math.max(1, Math.floor((waveform.clientWidth + 2) / 5))),
      );
    };
    updateCount();
    const observer = new ResizeObserver(updateCount);
    observer.observe(waveform);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (!playbackHref) return;
    let active = true;
    setWaveformReady(false);
    setPeaks(dotPeaks(barCount));
    void decodePeaks(playbackHref, barCount)
      .then((next) => {
        if (!active) return;
        setPeaks(next);
        setWaveformReady(true);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [barCount, playbackHref]);

  React.useEffect(() => {
    const handleOtherPlayback = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail !== playbackId) audioRef.current?.pause();
    };
    window.addEventListener(PLAY_EVENT, handleOtherPlayback);
    return () => window.removeEventListener(PLAY_EVENT, handleOtherPlayback);
  }, [playbackId]);

  const paintProgress = React.useCallback((time: number, knownDuration = 0) => {
    const audio = audioRef.current;
    const progressWaveform = progressWaveformRef.current;
    if (!progressWaveform) return;
    const audioDuration =
      knownDuration > 0
        ? knownDuration
        : audio && Number.isFinite(audio.duration)
          ? audio.duration
          : 0;
    const ratio = audioDuration > 0 ? time / audioDuration : 0;
    const remaining = Math.max(0, Math.min(1, 1 - ratio)) * 100;
    progressWaveform.style.clipPath = `inset(0 ${remaining}% 0 0)`;
  }, []);

  React.useEffect(() => {
    if (!isPlaying) {
      if (progressFrameRef.current !== null) {
        window.cancelAnimationFrame(progressFrameRef.current);
        progressFrameRef.current = null;
      }
      return;
    }

    const paintFrame = () => {
      const audio = audioRef.current;
      if (!audio || audio.paused) {
        progressFrameRef.current = null;
        return;
      }
      paintProgress(audio.currentTime);
      progressFrameRef.current = window.requestAnimationFrame(paintFrame);
    };
    progressFrameRef.current = window.requestAnimationFrame(paintFrame);
    return () => {
      if (progressFrameRef.current !== null) {
        window.cancelAnimationFrame(progressFrameRef.current);
        progressFrameRef.current = null;
      }
    };
  }, [isPlaying, paintProgress]);

  const togglePlayback = React.useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      window.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail: playbackId }));
      void audio.play();
    } else {
      audio.pause();
    }
  }, [playbackId]);

  const timeLabel = isPlaying
    ? formatVoiceNoteDuration(Math.max(0, duration - currentTime))
    : formatVoiceNoteDuration(duration);
  const nextPlaybackRate = nextVoiceNotePlaybackRate(playbackRate);

  const waveformBars = React.useCallback(
    (active: boolean) =>
      peaks.map((peak, index) => (
        <motion.span
          animate={{ height: voiceNoteBarHeight(peak) }}
          aria-hidden="true"
          className={cn(
            "w-[3px] shrink-0",
            active ? "bg-primary" : "bg-muted-foreground/35",
          )}
          initial={false}
          key={BAR_KEYS[index]}
          style={{ borderRadius: "9999px" }}
          transition={
            shouldReduceMotion
              ? { duration: 0 }
              : { duration: 0.24, ease: [0.23, 1, 0.32, 1] }
          }
        />
      )),
    [peaks, shouldReduceMotion],
  );

  return (
    <Attachment
      className={cn(
        "my-1 w-full max-w-[21rem] gap-2.5 px-2.5 py-2",
        composer && "shadow-none",
      )}
      data-testid={
        composer ? "composer-voice-note-card" : "audio-message-attachment"
      }
      size="sm"
    >
      <AttachmentMedia
        ref={mediaRef}
        className="rounded-lg bg-primary text-primary-foreground"
        data-testid="voice-note-playback-control"
      >
        <button
          aria-label={isPlaying ? "Pause voice note" : "Play voice note"}
          className="flex h-full w-full items-center justify-center rounded-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          onClick={togglePlayback}
          type="button"
        >
          <MorphingPlayPauseIcon isPlaying={isPlaying} />
        </button>
      </AttachmentMedia>
      <AttachmentContent className="min-w-0">
        <AttachmentTitle className="sr-only">{filename}</AttachmentTitle>
        <div
          className="relative h-6 overflow-hidden"
          data-testid="voice-note-playback-waveform"
          data-waveform-state={waveformReady ? "ready" : "loading"}
          ref={waveformRef}
        >
          <div className="flex h-full items-center gap-0.5">
            {waveformBars(false)}
          </div>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center gap-0.5 will-change-[clip-path]"
            data-testid="voice-note-progress-waveform"
            ref={progressWaveformRef}
            style={{ clipPath: "inset(0 100% 0 0)" }}
          >
            {waveformBars(true)}
          </div>
          <input
            aria-label="Voice note playback position"
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            max={Math.max(duration, 0.01)}
            min="0"
            onInput={(event) => {
              const next = Number(event.currentTarget.value);
              if (audioRef.current && Number.isFinite(next)) {
                audioRef.current.currentTime = next;
                setCurrentTime(next);
                paintProgress(next, Number(event.currentTarget.max));
              }
            }}
            step="0.01"
            type="range"
            value={Math.min(currentTime, Math.max(duration, 0.01))}
          />
        </div>
      </AttachmentContent>
      <AttachmentActions className="grid min-w-9 place-items-center">
        <span
          aria-hidden={!composer}
          className={cn(
            "pointer-events-none col-start-1 row-start-1 text-xs tabular-nums text-muted-foreground transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
            !composer &&
              "group-hover/attachment:-translate-y-0.5 group-hover/attachment:opacity-0 group-focus-within/attachment:-translate-y-0.5 group-focus-within/attachment:opacity-0",
          )}
        >
          {timeLabel}
        </span>
        {!composer ? (
          <button
            ref={playbackRateRef}
            aria-label={`Playback speed ${playbackRateLabel(playbackRate)}; next ${playbackRateLabel(nextPlaybackRate)}`}
            className="col-start-1 row-start-1 grid rounded-full bg-primary px-2.5 py-0.5 text-2xs font-semibold tabular-nums text-primary-foreground opacity-0 transition-[opacity,transform] duration-150 ease-out active:scale-95 group-hover/attachment:opacity-100 group-focus-within/attachment:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none motion-reduce:active:scale-100"
            data-testid="voice-note-playback-rate"
            onClick={() => {
              const next = nextVoiceNotePlaybackRate(playbackRate);
              setPlaybackRate(next);
              if (audioRef.current) {
                audioRef.current.defaultPlaybackRate = next;
                audioRef.current.playbackRate = next;
              }
            }}
            type="button"
          >
            <span
              aria-hidden="true"
              className="invisible col-start-1 row-start-1"
            >
              1.5×
            </span>
            <span
              className="col-start-1 row-start-1 text-center"
              data-testid="voice-note-playback-rate-value"
            >
              {playbackRateLabel(playbackRate)}
            </span>
          </button>
        ) : null}
      </AttachmentActions>
      {!composer && onRemove ? (
        <AttachmentActions>
          <AttachmentAction
            aria-label="Remove voice note"
            onClick={onRemove}
            title="Remove"
            type="button"
          >
            <X />
          </AttachmentAction>
        </AttachmentActions>
      ) : null}
      {/* biome-ignore lint/a11y/useMediaCaption: voice notes are user-provided audio */}
      <audio
        onDurationChange={(event) => {
          const next = event.currentTarget.duration;
          if (Number.isFinite(next)) {
            setDuration(next);
            paintProgress(event.currentTarget.currentTime, next);
          }
        }}
        onEnded={() => {
          setCurrentTime(0);
          setIsPlaying(false);
          paintProgress(0);
        }}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
        onTimeUpdate={(event) =>
          setCurrentTime(event.currentTarget.currentTime)
        }
        preload="metadata"
        ref={audioRef}
        src={playbackHref}
      />
    </Attachment>
  );
}
