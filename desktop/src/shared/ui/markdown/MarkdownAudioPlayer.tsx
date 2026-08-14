import * as React from "react";
import { Pause, Play } from "lucide-react";

import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";

import { isAudioMedia } from "./mediaEntry";
import type { ImetaEntry } from "./types";

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export function MarkdownAudioPlayer({
  alt,
  resolvedSrc,
}: {
  alt?: string;
  resolvedSrc: string;
}) {
  const audioRef = React.useRef<HTMLAudioElement>(null);
  const sliderRef = React.useRef<HTMLInputElement>(null);
  const timeRef = React.useRef<HTMLSpanElement>(null);
  const [playing, setPlaying] = React.useState(false);

  const syncProgress = React.useCallback((audio: HTMLAudioElement) => {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const currentTime = Math.min(audio.currentTime, duration);
    if (sliderRef.current) {
      sliderRef.current.max = String(duration);
      sliderRef.current.value = String(currentTime);
      sliderRef.current.style.setProperty(
        "--audio-progress-fill",
        `${duration > 0 ? (currentTime / duration) * 100 : 0}%`,
      );
    }
    if (timeRef.current) {
      timeRef.current.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
    }
  }, []);

  const togglePlayback = React.useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play();
    } else {
      audio.pause();
    }
  }, []);

  return (
    <span
      className="my-1 flex h-11 w-full max-w-md items-center gap-3 rounded-xl border border-border/70 bg-muted/45 px-3"
      data-audio-player=""
    >
      {/* biome-ignore lint/a11y/useMediaCaption: user-uploaded audio has no caption track */}
      <audio
        aria-label={alt?.trim() || "Audio attachment"}
        onDurationChange={(event) => syncProgress(event.currentTarget)}
        onEnded={() => setPlaying(false)}
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
        onTimeUpdate={(event) => syncProgress(event.currentTarget)}
        preload="metadata"
        ref={audioRef}
        src={resolvedSrc}
      />
      <button
        aria-label={playing ? "Pause audio" : "Play audio"}
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-80"
        onClick={togglePlayback}
        type="button"
      >
        {playing ? (
          <Pause className="size-3.5 fill-current" />
        ) : (
          <Play className="ml-0.5 size-3.5 fill-current" />
        )}
      </button>
      <input
        aria-label="Audio position"
        className="audio-progress-slider min-w-0 flex-1"
        defaultValue={0}
        min={0}
        onChange={(event) => {
          const audio = audioRef.current;
          if (!audio) return;
          audio.currentTime = Number(event.currentTarget.value);
          syncProgress(audio);
        }}
        ref={sliderRef}
        step="0.01"
        type="range"
      />
      <span
        className="shrink-0 tabular-nums text-2xs text-muted-foreground"
        ref={timeRef}
      >
        0:00 / 0:00
      </span>
    </span>
  );
}

export function MarkdownAudioAttachment({
  alt,
  entry,
  src,
}: {
  alt?: string;
  entry?: ImetaEntry;
  src?: string;
}): React.ReactNode {
  if (!src || !isAudioMedia(src, entry?.m)) return null;
  return (
    <span data-block-media="" className="block min-w-0 max-w-full">
      <MarkdownAudioPlayer alt={alt} resolvedSrc={rewriteRelayUrl(src)} />
    </span>
  );
}
